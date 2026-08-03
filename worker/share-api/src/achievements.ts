// ── Portable achievements ────────────────────────────────────────────────────
//
// `achievement_unlocks` is a device-local Room table and it is STICKY: the client's
// evaluator takes `max(derivedTier, persistedTier)`, so a badge whose signal has since
// dropped below threshold survives on the device that earned it. A new device recomputes
// from nothing and shows fewer badges — measured at 41 on one device against 33 on
// another for the same account. This row is what makes the set follow the account.
//
// ── Why this is a REPLACE and settings.ts is a MERGE ─────────────────────────
//
// Settings merge per key so an older client cannot blank a preference it has never heard
// of. Achievements cannot work that way: the client sends the whole reconciled set, and a
// per-badge merge here would make a DEMOTION impossible to express — the very thing
// `rules_version` exists to allow. The client owns the reconciliation; the server stores
// its conclusion verbatim.
//
// ── What `rules_version` is actually for ─────────────────────────────────────
//
// The client holds three one-shot corrections for badges granted under rules that later
// changed (wipeRewatchAchievementsOnce, wipeShareMetricAchievementsOnce,
// reconcileRebalancedTiersOnce), each guarded by a PER-DEVICE flag. Sync those rows
// naively and a device that has already run a wipe re-pulls the wiped rows from here and
// silently reinstates them — the correction undoes itself, fleet-wide and invisibly.
//
// So the stamp travels with the payload. A client reading a value BELOW its own
// `AchievementCatalog.RULES_VERSION` must adopt, re-reconcile against current thresholds
// and push the corrected set back. The server is authoritative for HISTORY; the current
// rules always get the last word.
//
// The server does not interpret the number beyond storing and returning it. Comparing
// rule sets is the client's job — it is the only party that knows what its thresholds are.

import { resolveSession } from "./auth";

export interface AchievementsEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-Revoke-Session, X-App-Version",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

const unauthorized = () => json({ error: "unauthorized" }, 401);

/** ~56 badges at well under 100 bytes each; the cap is against a hostile write, not a real one. */
const MAX_ACHIEVEMENTS_BYTES = 32 * 1024;
const MAX_UNLOCKS = 500;
const MAX_ID_LENGTH = 64;

export interface AchievementsRow {
  user_id: string;
  payload: string | null;
  rules_version: number;
  version: number;
  updated_at: number;
}

export interface UnlockWire {
  id: string;
  tier: number;
  unlockedAt: number;
}

export interface AchievementsWire {
  unlocks: UnlockWire[];
  rulesVersion: number;
  version: number;
  updatedAt: number;
}

function parseUnlocks(raw: string | null): UnlockWire[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as UnlockWire[]) : [];
  } catch {
    return [];
  }
}

export function toAchievementsWire(row: AchievementsRow): AchievementsWire {
  return {
    unlocks: parseUnlocks(row.payload),
    rulesVersion: row.rules_version,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export async function readAchievementsRow(
  env: AchievementsEnv,
  userId: string,
): Promise<AchievementsRow | null> {
  return env.DB.prepare(
    "SELECT user_id, payload, rules_version, version, updated_at FROM user_achievements WHERE user_id = ?",
  )
    .bind(userId)
    .first<AchievementsRow>();
}

/**
 * Validate and re-serialize the posted unlock set.
 *
 * Entries that are not well-formed are dropped rather than failing the request: one bad
 * row from a future client must not cost the user every other badge in the same push.
 * Returns null when the result is unusable, so the caller can answer 413.
 */
export function validateUnlocks(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_UNLOCKS) return null;
  const clean: UnlockWire[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (id.length === 0 || id.length > MAX_ID_LENGTH) continue;
    const tier = Number(row.tier);
    if (!Number.isInteger(tier) || tier <= 0) continue;
    const unlockedAt = Number(row.unlockedAt);
    clean.push({
      id,
      tier,
      // A junk timestamp becomes 0 rather than dropping the badge. The tier is the
      // entitlement; the date is decoration on the Daily News drop and the activity feed.
      unlockedAt: Number.isFinite(unlockedAt) && unlockedAt > 0 ? Math.floor(unlockedAt) : 0,
    });
  }
  const serialized = JSON.stringify(clean);
  if (serialized.length > MAX_ACHIEVEMENTS_BYTES) return null;
  return serialized;
}

/** GET /api/me/achievements — the owner's unlock set, or null when none stored yet. */
export async function handleGetMyAchievements(
  req: Request,
  env: AchievementsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();
  const row = await readAchievementsRow(env, session.userId);
  if (!row) return json({ achievements: null });
  return json({ achievements: toAchievementsWire(row) }, 200, { ETag: `"${row.version}"` });
}

/**
 * PUT /api/me/achievements — replace the owner's unlock set.
 *
 * Body: `{ rulesVersion: number, unlocks: [{id, tier, unlockedAt}] }`.
 *
 * `If-Match: <version>` behaves exactly as it does for profiles and settings.
 */
export async function handlePutMyAchievements(
  req: Request,
  env: AchievementsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid_payload" }, 400);
  }

  const rulesVersion = Number(body.rulesVersion);
  // Refused rather than defaulted. An unstamped payload is indistinguishable from one
  // written under rules nobody can identify, and storing it as 0 would make every future
  // client believe it needs to re-reconcile a set that may be perfectly current.
  if (!Number.isInteger(rulesVersion) || rulesVersion <= 0) {
    return json({ error: "invalid_rules_version" }, 400);
  }

  const ifMatchRaw = (req.headers.get("If-Match") ?? "").replace(/"/g, "").trim();
  const ifMatch = ifMatchRaw === "" ? null : Number(ifMatchRaw);
  if (ifMatch != null && !Number.isInteger(ifMatch)) return json({ error: "invalid_if_match" }, 400);

  const existing = await readAchievementsRow(env, session.userId);
  const currentVersion = existing?.version ?? 0;
  const claimed = ifMatch ?? 0;
  if (claimed !== currentVersion) {
    return json({ error: "version_conflict", version: currentVersion }, 409);
  }

  const payload = validateUnlocks(body.unlocks);
  if (payload === null) return json({ error: "too_large" }, 413);

  const now = Date.now();
  const version = currentVersion + 1;
  await env.DB.prepare(
    `INSERT INTO user_achievements (user_id, payload, rules_version, version, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       payload = excluded.payload, rules_version = excluded.rules_version,
       version = excluded.version, updated_at = excluded.updated_at`,
  )
    .bind(session.userId, payload, rulesVersion, version, now)
    .run();

  return json({ version, updatedAt: now });
}
