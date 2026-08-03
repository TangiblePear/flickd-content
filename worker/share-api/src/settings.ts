// ── Portable preferences ─────────────────────────────────────────────────────
//
// The user's own settings — theme, accent, language, media filter, release-year floor,
// excluded genres, selected networks, region, gender — so signing in on a new device
// restores what they had set up instead of asking for all of it again.
//
// Concurrency is optimistic on `user_settings.version`, exactly as `profiles.version`
// works in profiles.ts. Read that header first; this is deliberately the same shape.
//
// ⚠️ These rows are NEVER served to anyone but their owner. There is no `canView` path
// here and none should be added — see migration 0024 for why gender in particular must
// not live on the friend-readable `profiles` row.

import { resolveSession } from "./auth";

export interface SettingsEnv {
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

/**
 * Generous against a real payload of roughly 500 bytes. The cap exists because this is a
 * client-controlled write, not because the shape is expected to approach it.
 */
const MAX_SETTINGS_BYTES = 8 * 1024;

/** Bounds the key count too — a cap on total bytes alone permits 8k one-byte keys. */
const MAX_SETTINGS_KEYS = 100;

const MAX_KEY_LENGTH = 64;

export interface SettingsRow {
  user_id: string;
  payload: string | null;
  version: number;
  updated_at: number;
}

export interface SettingsWire {
  payload: Record<string, unknown>;
  version: number;
  updatedAt: number;
}

/** Parse a JSON column, falling back rather than throwing on a bad row. */
function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function toSettingsWire(row: SettingsRow): SettingsWire {
  return {
    payload: parsePayload(row.payload),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export async function readSettingsRow(env: SettingsEnv, userId: string): Promise<SettingsRow | null> {
  return env.DB.prepare("SELECT user_id, payload, version, updated_at FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<SettingsRow>();
}

/**
 * Merge the posted object over the stored one, key by key.
 *
 * **This is the correctness point of the whole module**, and it mirrors invariant 2 in
 * `ProfileSyncRepository`'s header: a write must only touch the fields the client
 * actually sent. `handlePutMyProfile` gets this for free by carrying omitted columns
 * forward in `mergeValidated`; a blob written wholesale would lose it, and a client that
 * predates `key_added_in_v40` would silently wipe it on its next push.
 *
 * Keys are therefore set, never removed. That is not a limitation in practice — a
 * preference is reset by writing its default, not by deleting it — and the alternative
 * (honouring deletes) would hand every old client the power to blank what it can't see.
 *
 * Returns null when the result is unusable, so the caller can answer 413.
 */
export function mergeSettings(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): string | null {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    // Junk keys are dropped rather than failing the whole write: one bad key from a
    // future client must not cost the user every other preference in the same request.
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
    if (value === undefined) continue;
    merged[key] = value;
  }
  if (Object.keys(merged).length > MAX_SETTINGS_KEYS) return null;
  const serialized = JSON.stringify(merged);
  if (serialized.length > MAX_SETTINGS_BYTES) return null;
  return serialized;
}

/** GET /api/me/settings — the owner's own preferences, or null when none stored yet. */
export async function handleGetMySettings(
  req: Request,
  env: SettingsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();
  const row = await readSettingsRow(env, session.userId);
  if (!row) return json({ settings: null });
  return json({ settings: toSettingsWire(row) }, 200, { ETag: `"${row.version}"` });
}

/**
 * PUT /api/me/settings — merge the posted preference keys into the owner's row.
 *
 * `If-Match: <version>` is REQUIRED once a row exists; a mismatch returns 409 with the
 * current version so the client can re-read and retry. `If-Match: 0` (or absent) means
 * "I believe none exists" and only succeeds on a first write — otherwise a client with no
 * idea of the current state could silently clobber another device's edit.
 */
export async function handlePutMySettings(
  req: Request,
  env: SettingsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid_payload" }, 400);
  }

  const ifMatchRaw = (req.headers.get("If-Match") ?? "").replace(/"/g, "").trim();
  const ifMatch = ifMatchRaw === "" ? null : Number(ifMatchRaw);
  if (ifMatch != null && !Number.isInteger(ifMatch)) return json({ error: "invalid_if_match" }, 400);

  const existing = await readSettingsRow(env, session.userId);
  const currentVersion = existing?.version ?? 0;
  const claimed = ifMatch ?? 0;
  if (claimed !== currentVersion) {
    return json({ error: "version_conflict", version: currentVersion }, 409);
  }

  const payload = mergeSettings(
    body as Record<string, unknown>,
    existing ? parsePayload(existing.payload) : {},
  );
  if (payload === null) return json({ error: "too_large" }, 413);

  const now = Date.now();
  const version = currentVersion + 1;
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, payload, version, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       payload = excluded.payload, version = excluded.version, updated_at = excluded.updated_at`,
  )
    .bind(session.userId, payload, version, now)
    .run();

  return json({ version, updatedAt: now });
}
