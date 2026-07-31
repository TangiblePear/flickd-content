// ── Fleet insights ───────────────────────────────────────────────────────────
// Everything the admin panel's Insights page draws, in ONE request.
//
// Authorised by the shared ADMIN_KEY, never a user session — same reasoning as
// `moderationQueue.ts`: the admin is not a user of this system, and giving a users.id
// panel powers would make an account takeover a reporting takeover.
//
// **Read-only.** Nothing here writes, so it can never corrupt the data it reports on.
//
// The per-device dimensions are aggregated in JS from a single `SELECT * FROM
// user_telemetry` rather than a GROUP BY per dimension. Two reasons: `integrations` and
// `features` are JSON and cannot be grouped in SQL at all, and one scan of a table with
// one row per device is cheaper than a dozen scans of it. That holds while devices are
// counted in thousands; past ~100k rows this wants materialising into `telemetry_daily`
// and reading the series instead.
//
// Counts that D1 already knows (friendships, comments, votes, reports) come straight
// from their own tables — the client never reports them, precisely so there is only ever
// one source for each.

import { adminAuthorized } from "./commentsAdmin";
import { minSocialVersion } from "./profiles";

export interface InsightsEnv {
  DB: D1Database;
  ADMIN_KEY?: string;
  MIN_SOCIAL_VERSION?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const DAY_MS = 86_400_000;
/** Enough for a quarter's trend without making the payload silly. */
const SERIES_DAYS = 90;

interface DeviceRow {
  user_id: string;
  device_id: string;
  platform: string | null;
  version_code: number | null;
  version_name: string | null;
  build_type: string | null;
  country: string | null;
  language: string | null;
  os_api: number | null;
  manufacturer: string | null;
  model: string | null;
  installer: string | null;
  premium: number | null;
  gate_outcome: string | null;
  ads_consent: string | null;
  integrations: string | null;
  features: string | null;
  last_seen_at: number;
  reported_on: string;
}

/** `{key: n}` accumulator. Null/blank keys are skipped rather than bucketed as "". */
type Tally = Record<string, number>;
const bump = (into: Tally, key: string | null | undefined, by = 1) => {
  if (key == null || key === "") return;
  into[key] = (into[key] ?? 0) + by;
};

/** `{a: 3, b: 1}` → `[{key:"b",…},{key:"a",…}]`, biggest first. Stable for equal counts. */
function ranked(t: Tally): Array<{ key: string; devices: number }> {
  return Object.entries(t)
    .map(([key, devices]) => ({ key, devices }))
    .sort((a, b) => b.devices - a.devices || a.key.localeCompare(b.key));
}

/**
 * `GET /api/insights` — the whole page.
 *
 * One request because the panel is one screen: a dozen endpoints would be a dozen
 * round trips for a view that is always drawn all at once.
 */
export async function handleInsights(req: Request, env: InsightsEnv): Promise<Response> {
  if (!adminAuthorized(req, env)) return json({ error: "unauthorized" }, 401);

  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  const { results: devices } = await env.DB.prepare(
    `SELECT user_id, device_id, platform, version_code, version_name, build_type, country,
            language, os_api, manufacturer, model, installer, premium, gate_outcome,
            ads_consent, integrations, features, last_seen_at, reported_on
       FROM user_telemetry`,
  ).all<DeviceRow>();
  const rows = devices ?? [];

  // ── Dimensions ─────────────────────────────────────────────────────────────
  const versions: Tally = {};
  const versionNames: Record<string, string> = {};
  const osApi: Tally = {};
  const countries: Tally = {};
  const languages: Tally = {};
  const manufacturers: Tally = {};
  const models: Tally = {};
  const installers: Tally = {};
  const buildTypes: Tally = {};
  const platforms: Tally = {};
  const integrations: Tally = {};
  const featuresUsed: Tally = {};
  const featureCounts: Record<string, { sum: number; devices: number }> = {};
  // Monetisation is computed on RELEASE builds only: a debug build can force premium
  // from the developer menu, so counting it would inflate conversion with our own
  // testing. Reported separately so the panel can say what it excluded.
  const gate: Tally = {};
  const adsConsent: Tally = {};

  const accounts = new Set<string>();
  const activeAccounts = { d1: new Set<string>(), d7: new Set<string>(), d30: new Set<string>() };
  let activeDevices1 = 0;
  let activeDevices7 = 0;
  let activeDevices30 = 0;
  let premiumRelease = 0;
  let releaseDevices = 0;
  let reportingNewClient = 0;

  for (const r of rows) {
    accounts.add(r.user_id);
    if (r.reported_on === today) {
      activeDevices1++;
      activeAccounts.d1.add(r.user_id);
    }
    if (r.last_seen_at >= now - 7 * DAY_MS) {
      activeDevices7++;
      activeAccounts.d7.add(r.user_id);
    }
    if (r.last_seen_at >= now - 30 * DAY_MS) {
      activeDevices30++;
      activeAccounts.d30.add(r.user_id);
    }
    // The adoption marker for the client half. Row count would overstate it —
    // header-only writes from clients predating the telemetry block land here too.
    if (r.version_name) reportingNewClient++;

    bump(versions, r.version_code == null ? null : String(r.version_code));
    if (r.version_code != null && r.version_name) versionNames[String(r.version_code)] = r.version_name;
    bump(osApi, r.os_api == null ? null : String(r.os_api));
    bump(countries, r.country);
    bump(languages, r.language);
    bump(manufacturers, r.manufacturer);
    bump(models, r.manufacturer && r.model ? `${r.manufacturer} ${r.model}` : r.model);
    bump(installers, r.installer);
    bump(buildTypes, r.build_type);
    bump(platforms, r.platform);

    if (r.build_type === "release") {
      releaseDevices++;
      if (r.premium) premiumRelease++;
      bump(gate, r.gate_outcome);
      bump(adsConsent, r.ads_consent);
    }

    // A malformed blob costs that one device's contribution, never the whole page.
    try {
      const parsed = r.integrations ? (JSON.parse(r.integrations) as Record<string, unknown>) : null;
      for (const [k, v] of Object.entries(parsed ?? {})) {
        // A string value is a CHOICE (which AI provider); keep it rather than
        // flattening it to "configured".
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
        const slot = (featureCounts[k] ??= { sum: 0, devices: 0 });
        slot.sum += v;
        slot.devices++;
      }
    } catch {
      /* ignore */
    }
  }

  // ── Everything D1 already knew ─────────────────────────────────────────────
  // One statement of scalar subqueries rather than eight round trips.
  const totals = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users)                                            AS accounts,
       (SELECT COUNT(*) FROM users WHERE status = 'active')                    AS accounts_active,
       (SELECT COUNT(*) FROM users WHERE created_at >= ?)                      AS accounts_new_7d,
       (SELECT COUNT(*) FROM users WHERE created_at >= ?)                      AS accounts_new_30d,
       (SELECT COUNT(*) FROM friendships WHERE state = 'accepted')             AS friendships,
       (SELECT COUNT(*) FROM friendships WHERE state = 'pending')              AS friend_requests,
       (SELECT COUNT(*) FROM profiles)                                         AS profiles,
       (SELECT COUNT(*) FROM feed_events)                                      AS feed_events,
       (SELECT COUNT(*) FROM comments)                                         AS comments,
       (SELECT COUNT(*) FROM episode_votes)                                    AS votes,
       (SELECT COUNT(*) FROM shared_lists)                                     AS shared_lists,
       (SELECT COUNT(*) FROM reports WHERE state = 'open')                     AS open_reports`,
  )
    .bind(now - 7 * DAY_MS, now - 30 * DAY_MS)
    .first<Record<string, number>>();

  // Distinct accounts holding at least one accepted edge. Both columns, because the
  // pair is stored once in canonical order — counting only `user_a` would halve it.
  const social = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT user_a AS id FROM friendships WHERE state = 'accepted'
       UNION
       SELECT user_b AS id FROM friendships WHERE state = 'accepted')`,
  ).first<{ n: number }>();

  const { results: signups } = await env.DB.prepare(
    `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
       FROM users WHERE created_at >= ?
       GROUP BY day ORDER BY day`,
  )
    .bind(now - SERIES_DAYS * DAY_MS)
    .all<{ day: string; n: number }>();

  const { results: daily } = await env.DB.prepare(
    `SELECT day, active, devices, new_users, snapshot FROM telemetry_daily
       WHERE day >= ? ORDER BY day`,
  )
    .bind(new Date(now - SERIES_DAYS * DAY_MS).toISOString().slice(0, 10))
    .all<{ day: string; active: number; devices: number; new_users: number; snapshot: string }>();

  const floor = minSocialVersion(env);

  return json({
    generatedAt: now,
    today,
    /** 0 = no gate. Devices below it are blocked from the social surface. */
    minSocialVersion: floor,
    belowFloor: floor === 0 ? 0 : rows.filter((r) => (r.version_code ?? 0) < floor).length,

    totals: {
      ...totals,
      devices: rows.length,
      telemetryAccounts: accounts.size,
      activeDevices1,
      activeDevices7,
      activeDevices30,
      activeAccounts1: activeAccounts.d1.size,
      activeAccounts7: activeAccounts.d7.size,
      activeAccounts30: activeAccounts.d30.size,
      accountsWithFriends: social?.n ?? 0,
      /** Devices on a build that sends the telemetry block. NOT the row count. */
      reportingNewClient,
      releaseDevices,
      premiumRelease,
    },

    versions: ranked(versions).map((v) => ({ ...v, name: versionNames[v.key] ?? null })),
    osApi: ranked(osApi),
    countries: ranked(countries),
    languages: ranked(languages),
    manufacturers: ranked(manufacturers),
    models: ranked(models).slice(0, 12),
    installers: ranked(installers),
    buildTypes: ranked(buildTypes),
    platforms: ranked(platforms),
    integrations: ranked(integrations),
    featuresUsed: ranked(featuresUsed),
    featureCounts: Object.entries(featureCounts)
      .map(([key, v]) => ({ key, sum: v.sum, devices: v.devices }))
      .sort((a, b) => b.sum - a.sum),
    monetisation: { gate: ranked(gate), adsConsent: ranked(adsConsent) },

    series: {
      daily: (daily ?? []).map((d) => ({
        day: d.day,
        active: d.active,
        devices: d.devices,
        newUsers: d.new_users,
      })),
      signups: signups ?? [],
    },
  });
}
