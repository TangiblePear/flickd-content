// ── Product telemetry ────────────────────────────────────────────────────────
// What the fleet is running and what it uses, recorded off the back of a request
// that was happening anyway.
//
// Two properties make this cheap enough to hang off `POST /api/sync`:
//
//   1. **The version already arrives.** `X-App-Version` is stamped on every FlickTo
//      call by an OkHttp interceptor and was already being parsed to enforce
//      MIN_SOCIAL_VERSION — it was simply never stored. So version, country and
//      activity start recording the moment this deploys, from the fleet that is
//      already out there, without waiting for an app release.
//
//   2. **The daily guard is one statement and no read.** SQLite allows a WHERE on
//      `ON CONFLICT ... DO UPDATE`, so after the first report of the day the upsert
//      writes zero rows. One write per device per day, no cron, no marker table.
//
// Everything here is best-effort and runs under `waitUntil`: telemetry must never
// fail, slow, or change the shape of a sync. Every caller catches.
//
// Never record a token, a URL, a username or an API key. `integrations` says only
// WHETHER a thing is configured.

import { appVersion } from "./profiles";

export interface TelemetryEnv {
  DB: D1Database;
}

/**
 * The client-sent half. Every field optional — a client that sends none of it still
 * gets a row from the header alone, and a client on a newer build than this Worker
 * must not break by sending a field we do not know.
 */
export interface TelemetryBlock {
  /**
   * Names one handset. A salted SHA-256 of the Android SSAID (client-side; the raw value
   * never reaches here), or a random UUID on a client that has no SSAID or predates the
   * change. NOT the advertising id, and never used for ads.
   */
  deviceId?: unknown;
  platform?: unknown;
  versionName?: unknown;
  buildType?: unknown;
  osApi?: unknown;
  manufacturer?: unknown;
  model?: unknown;
  language?: unknown;
  installer?: unknown;
  premium?: unknown;
  gate?: unknown;
  adsConsent?: unknown;
  integrations?: unknown;
  /**
   * Sent as its own field rather than inside `integrations` because Kotlin cannot type
   * a mixed boolean/string map. Folded into the same column here, as a slug value, so
   * the rollup keeps WHICH provider was chosen instead of flattening it to "one was".
   */
  aiProvider?: unknown;
  features?: unknown;
}

/** UTC `YYYY-MM-DD`. Computed SERVER-side so a wrong device clock cannot skew a day bucket. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

// ── Sanitisation ─────────────────────────────────────────────────────────────
// Everything below crosses a trust boundary. Sizes are capped rather than rejected:
// a client that sends junk should cost a truncated column, not a lost row.

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, max);
  return s.length > 0 ? s : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function bool(v: unknown): number | null {
  return typeof v === "boolean" ? (v ? 1 : 0) : null;
}

/** Keys we are willing to store, in either a `used` list or a counts/integrations map. */
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const MAX_KEYS = 64;

/**
 * A string value here is a CHOICE ("which AI provider"), never a credential. Slug
 * shape and a 24-char ceiling, and over-length is **rejected rather than truncated**:
 * truncating a token that reached this column by client bug would still store 24
 * characters of it. Real Trakt/Simkl tokens are 64 hex characters, so they die here.
 */
const SLUG_RE = /^[A-Za-z0-9_.-]{1,24}$/;

/** `{plex: true, trakt: true, aiProvider: "gemini"}` — booleans and slugs only. */
function integrationsJson(v: unknown, aiProvider: unknown): string | null {
  const out: Record<string, boolean | string> = {};
  let n = 0;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
      if (n >= MAX_KEYS || !KEY_RE.test(k)) continue;
      // Strings are accepted here too, even though the Android client sends them in
      // their own field — a future platform may not have that type constraint.
      if (typeof raw === "boolean") out[k] = raw;
      else if (typeof raw === "string" && SLUG_RE.test(raw.trim())) out[k] = raw.trim();
      else continue;
      n++;
    }
  }
  if (typeof aiProvider === "string" && SLUG_RE.test(aiProvider.trim())) out.aiProvider = aiProvider.trim();
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** `{used: [...], counts: {...}}` — a set of surfaces touched, plus lifetime totals. */
function featuresJson(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const src = v as { used?: unknown; counts?: unknown };
  const used: string[] = [];
  if (Array.isArray(src.used)) {
    for (const k of src.used) {
      if (used.length >= MAX_KEYS) break;
      if (typeof k === "string" && KEY_RE.test(k) && !used.includes(k)) used.push(k);
    }
  }
  const counts: Record<string, number> = {};
  if (src.counts && typeof src.counts === "object" && !Array.isArray(src.counts)) {
    let n = 0;
    for (const [k, raw] of Object.entries(src.counts as Record<string, unknown>)) {
      if (n >= MAX_KEYS || !KEY_RE.test(k)) continue;
      const i = int(raw);
      // Negative is meaningless for a lifetime total and would poison a sum.
      if (i == null || i < 0) continue;
      counts[k] = i;
      n++;
    }
  }
  if (used.length === 0 && Object.keys(counts).length === 0) return null;
  return JSON.stringify({ used, counts });
}

// ── The write ────────────────────────────────────────────────────────────────

/**
 * Upsert this device's row, at most once per UTC day — plus one catch-up write when the
 * day's first report was a thin one.
 *
 * The `WHERE user_telemetry.reported_on <> excluded.reported_on` on the DO UPDATE is the
 * throttle: the second and every later report of the day writes nothing.
 *
 * **The second clause is not an optimisation, it is the thing that makes a row complete.**
 * Two callers write here on different schedules: `/api/history/sync` every 15 minutes
 * carrying only a device id, and `/api/sync` carrying the rich block once a day. The
 * frequent thin caller therefore almost always claims the day first, and with the throttle
 * alone the rich write that followed was discarded — for that whole day.
 *
 * `COALESCE(excluded.x, user_telemetry.x)` hid this for existing rows by preserving
 * yesterday's values, so it only showed on a row with no yesterday: two devices whose rows
 * were deleted mid-day came back as `version_name = NULL` and could never fill in again,
 * because the next day's first write was thin too, and the next. Device-found 2026-08-04.
 *
 * So a rich write is also let through when the row still has no rich half. That is at most
 * one extra write per device per day, it stops the moment the row is complete, and it
 * cannot be triggered by a thin caller — `excluded.version_name` is NULL for those.
 *
 * @param block absent for any client predating it, which lands on `device_id = ''`
 *   and is exactly why version data works before the next release ships.
 */
export async function recordTelemetry(
  env: TelemetryEnv,
  userId: string,
  req: Request,
  block: TelemetryBlock | undefined,
  nowMs = Date.now(),
): Promise<void> {
  const b = block && typeof block === "object" ? block : {};
  const day = utcDay(nowMs);
  const country = str((req as unknown as { cf?: { country?: unknown } }).cf?.country, 2);

  await env.DB.prepare(
    `INSERT INTO user_telemetry (
       user_id, device_id, platform, version_code, country, last_seen_at, reported_on,
       version_name, build_type, os_api, manufacturer, model, language, installer,
       premium, gate_outcome, ads_consent, integrations, features
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id) DO UPDATE SET
       platform     = excluded.platform,
       version_code = excluded.version_code,
       country      = COALESCE(excluded.country, user_telemetry.country),
       last_seen_at = excluded.last_seen_at,
       reported_on  = excluded.reported_on,
       version_name = COALESCE(excluded.version_name, user_telemetry.version_name),
       build_type   = COALESCE(excluded.build_type,   user_telemetry.build_type),
       os_api       = COALESCE(excluded.os_api,       user_telemetry.os_api),
       manufacturer = COALESCE(excluded.manufacturer, user_telemetry.manufacturer),
       model        = COALESCE(excluded.model,        user_telemetry.model),
       language     = COALESCE(excluded.language,     user_telemetry.language),
       installer    = COALESCE(excluded.installer,    user_telemetry.installer),
       premium      = COALESCE(excluded.premium,      user_telemetry.premium),
       gate_outcome = COALESCE(excluded.gate_outcome, user_telemetry.gate_outcome),
       ads_consent  = COALESCE(excluded.ads_consent,  user_telemetry.ads_consent),
       integrations = COALESCE(excluded.integrations, user_telemetry.integrations),
       features     = COALESCE(excluded.features,     user_telemetry.features)
     WHERE user_telemetry.reported_on <> excluded.reported_on
        OR (excluded.version_name IS NOT NULL AND user_telemetry.version_name IS NULL)`,
  )
    .bind(
      userId,
      str(b.deviceId, 64) ?? "",
      str(b.platform, 16) ?? "android",
      appVersion(req),
      country,
      nowMs,
      day,
      str(b.versionName, 32),
      str(b.buildType, 16),
      int(b.osApi),
      str(b.manufacturer, 32),
      str(b.model, 48),
      str(b.language, 16),
      str(b.installer, 48),
      bool(b.premium),
      str(b.gate, 16),
      str(b.adsConsent, 16),
      integrationsJson(b.integrations, b.aiProvider),
      featuresJson(b.features),
    )
    .run();
}

// ── The daily rollup ─────────────────────────────────────────────────────────

interface RollupRow {
  version_code: number | null;
  os_api: number | null;
  country: string | null;
  language: string | null;
  platform: string | null;
  build_type: string | null;
  installer: string | null;
  premium: number | null;
  gate_outcome: string | null;
  ads_consent: string | null;
  integrations: string | null;
  features: string | null;
}

const bump = (into: Record<string, number>, key: string | null | undefined) => {
  if (key == null || key === "") return;
  into[key] = (into[key] ?? 0) + 1;
};

/**
 * Fold yesterday's `user_telemetry` rows into one immutable `telemetry_daily` row.
 *
 * **Opportunistic, not cron** — this account is at its 5-cron limit, the same reason
 * the orphan reaper fires from request traffic. The first sync after the UTC boundary
 * computes yesterday; every other call that day is a single PK lookup and returns.
 *
 * The `INSERT OR IGNORE` claim is what makes concurrent callers safe: whoever loses
 * the race writes nothing and the aggregation runs exactly once.
 *
 * @returns the day rolled up, or null when there was nothing to do.
 */
export async function maybeRollup(env: TelemetryEnv, nowMs = Date.now()): Promise<string | null> {
  const day = utcDay(nowMs - DAY_MS);

  const done = await env.DB.prepare("SELECT day FROM telemetry_daily WHERE day = ?").bind(day).first<{ day: string }>();
  if (done) return null;

  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO telemetry_daily (day, active, devices, new_users, snapshot, computed_at)
     VALUES (?, 0, 0, 0, '{}', ?)`,
  )
    .bind(day, nowMs)
    .run();
  if (claim?.meta && claim.meta.changes === 0) return null; // lost the race

  const from = Date.parse(`${day}T00:00:00.000Z`);
  const to = from + DAY_MS;

  const totals = await env.DB.prepare(
    "SELECT COUNT(DISTINCT user_id) AS active, COUNT(*) AS devices FROM user_telemetry WHERE reported_on = ?",
  )
    .bind(day)
    .first<{ active: number; devices: number }>();

  const fresh = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?")
    .bind(from, to)
    .first<{ n: number }>();

  const { results } = await env.DB.prepare(
    `SELECT version_code, os_api, country, language, platform, build_type, installer,
            premium, gate_outcome, ads_consent, integrations, features
       FROM user_telemetry WHERE reported_on = ?`,
  )
    .bind(day)
    .all<RollupRow>();

  const version: Record<string, number> = {};
  const osApi: Record<string, number> = {};
  const country: Record<string, number> = {};
  const language: Record<string, number> = {};
  const platform: Record<string, number> = {};
  const buildType: Record<string, number> = {};
  const installer: Record<string, number> = {};
  const gate: Record<string, number> = {};
  const adsConsent: Record<string, number> = {};
  const integrations: Record<string, number> = {};
  const featuresUsed: Record<string, number> = {};
  // Sum AND the number of devices reporting it, so the panel can show a mean without
  // assuming every device reported the key.
  const featureCounts: Record<string, { sum: number; n: number }> = {};
  let premium = 0;

  for (const r of results ?? []) {
    bump(version, r.version_code == null ? null : String(r.version_code));
    bump(osApi, r.os_api == null ? null : String(r.os_api));
    bump(country, r.country);
    bump(language, r.language);
    bump(platform, r.platform);
    bump(buildType, r.build_type);
    bump(installer, r.installer);
    bump(gate, r.gate_outcome);
    bump(adsConsent, r.ads_consent);
    if (r.premium) premium++;

    // A malformed blob must cost that one device's contribution, never the rollup.
    try {
      const parsed = r.integrations ? (JSON.parse(r.integrations) as Record<string, unknown>) : null;
      for (const [k, v] of Object.entries(parsed ?? {})) {
        // A string value is a choice (which AI provider); count it as `key:value` so
        // the histogram keeps the choice instead of flattening it to "configured".
        if (typeof v === "string") bump(integrations, `${k}:${v}`);
        else if (v === true) bump(integrations, k);
      }
    } catch {
      /* ignore */
    }
    try {
      const f = r.features ? (JSON.parse(r.features) as { used?: string[]; counts?: Record<string, number> }) : null;
      for (const k of f?.used ?? []) bump(featuresUsed, k);
      for (const [k, v] of Object.entries(f?.counts ?? {})) {
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        const slot = (featureCounts[k] ??= { sum: 0, n: 0 });
        slot.sum += v;
        slot.n++;
      }
    } catch {
      /* ignore */
    }
  }

  const snapshot = JSON.stringify({
    version,
    osApi,
    country,
    language,
    platform,
    buildType,
    installer,
    premium,
    gate,
    adsConsent,
    integrations,
    featuresUsed,
    featureCounts,
  });

  await env.DB.prepare(
    "UPDATE telemetry_daily SET active = ?, devices = ?, new_users = ?, snapshot = ?, computed_at = ? WHERE day = ?",
  )
    .bind(totals?.active ?? 0, totals?.devices ?? 0, fresh?.n ?? 0, snapshot, nowMs, day)
    .run();

  return day;
}
