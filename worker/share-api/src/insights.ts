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
 * Every UTC day from `from` to `to` inclusive.
 *
 * The panel needs this because `maybeRollup` only ever computes YESTERDAY: a day on which
 * nothing synced is skipped and is never backfilled. Handing the client only the days that
 * exist lets it space them evenly and draw a gap as continuity — which is the one thing a
 * trend chart must never do. With the full axis, an absent day arrives as `null` and can
 * be drawn as absent.
 */
function everyDay(from: number, to: number): string[] {
  const out: string[] = [];
  for (let t = from; t <= to; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** A device as the roster draws it. One row per `user_telemetry` row, never per account. */
interface RosterRow {
  /** Short prefix only. The full users.id is never needed to read this page. */
  acct: string;
  deviceId: string;
  device: string | null;
  /**
   * `android` or `web`. Already stored and already SELECTed, but never reached the
   * panel — so a browser row was indistinguishable from a handset that had failed to
   * report, and drew as the alarming "header only". Every Android-shaped column
   * (build, API level, installer, entitlement) is empty for a browser by design, and
   * this is the only field that says so.
   */
  platform: string | null;
  versionName: string | null;
  versionCode: number | null;
  osApi: number | null;
  country: string | null;
  language: string | null;
  buildType: string | null;
  installer: string | null;
  premium: boolean | null;
  gate: string | null;
  adsConsent: string | null;
  integrations: string[];
  features: string[];
  counts: Record<string, number>;
  lastSeenAt: number;
  /** Events this ACCOUNT has on the server, from history_meta. Null = never uploaded. */
  serverEvents: number | null;
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

  /**
   * `?excludeDebug=1` — drop our own development handsets from the WHOLE page.
   *
   * Filtered here, at the single source every panel is folded from, rather than per
   * panel: a page where the version histogram excludes debug builds and the roster does
   * not is a page whose numbers cannot be reconciled with each other.
   *
   * Only an explicit `debug` is dropped. A NULL `build_type` is a legacy header-only row
   * from a client predating the telemetry block — unknown, not ours, and hiding it would
   * quietly shrink the fleet.
   */
  const excludeDebug = new URL(req.url).searchParams.get("excludeDebug") === "1";

  const { results: devices } = await env.DB.prepare(
    `SELECT user_id, device_id, platform, version_code, version_name, build_type, country,
            language, os_api, manufacturer, model, installer, premium, gate_outcome,
            ads_consent, integrations, features, last_seen_at, reported_on
       FROM user_telemetry`,
  ).all<DeviceRow>();
  const rows = excludeDebug
    ? (devices ?? []).filter((r) => r.build_type !== "debug")
    : (devices ?? []);

  // Server-side history, per account. `history_meta` is one WITHOUT ROWID row per user and
  // is the only cheap source for this — the events themselves live in an R2 document, so
  // "has this account uploaded" cannot be answered from the events at all.
  const { results: historyRows } = await env.DB.prepare(
    "SELECT user_id, event_count FROM history_meta",
  ).all<{ user_id: string; event_count: number }>();
  const serverHistory = new Map((historyRows ?? []).map((r) => [r.user_id, r.event_count]));

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
  // `values` alongside the sum, because a mean over these lies at this scale: measured
  // 2026-08-02, watched was 16,461 / 2,918 / 0 / 0 / 0 — mean 3,876, median 0, and no
  // device anywhere near the mean. The panel draws the values and derives its own median.
  const featureCounts: Record<string, { sum: number; devices: number; values: number[] }> = {};
  const roster: RosterRow[] = [];
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

    // ⚠️ A browser is a device, but it is not an APK and not a handset.
    //
    // `version_code` is the `X-App-Version` header, which a browser never sends — so
    // it is 0, not NULL, and the two tallies below would read that as "an app on
    // version 0". That is not a cosmetic wrong: `belowFloor` counts exactly this
    // column against MIN_SOCIAL_VERSION, and it is the number the legacy-relay purge
    // decision rests on. Every browser on the site would have sat in it forever,
    // and the purge would never have looked safe to run.
    //
    // `manufacturer`/`model` carry the browser name and major version, which is what
    // makes the roster read "Chrome 142" — but those two tallies feed the panels that
    // answer handset questions ("can minSdk rise", "which devices do we support"), and
    // "Chrome" is not a manufacturer.
    //
    // Everything else is left in deliberately: country, language and the activity
    // counters above describe a real person using FlickTo, whichever client they used.
    const isApp = r.platform !== "web";
    if (isApp) {
      bump(versions, r.version_code == null ? null : String(r.version_code));
      if (r.version_code != null && r.version_name) versionNames[String(r.version_code)] = r.version_name;
      bump(manufacturers, r.manufacturer);
      bump(models, r.manufacturer && r.model ? `${r.manufacturer} ${r.model}` : r.model);
    }
    bump(osApi, r.os_api == null ? null : String(r.os_api));
    bump(countries, r.country);
    bump(languages, r.language);
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
    const myIntegrations: string[] = [];
    try {
      const parsed = r.integrations ? (JSON.parse(r.integrations) as Record<string, unknown>) : null;
      for (const [k, v] of Object.entries(parsed ?? {})) {
        // A string value is a CHOICE (which AI provider); keep it rather than
        // flattening it to "configured".
        if (typeof v === "string") {
          bump(integrations, `${k}:${v}`);
          myIntegrations.push(`${k}:${v}`);
        } else if (v === true) {
          bump(integrations, k);
          myIntegrations.push(k);
        }
      }
    } catch {
      /* ignore */
    }
    const myFeatures: string[] = [];
    const myCounts: Record<string, number> = {};
    try {
      const f = r.features ? (JSON.parse(r.features) as { used?: string[]; counts?: Record<string, number> }) : null;
      for (const k of f?.used ?? []) {
        bump(featuresUsed, k);
        myFeatures.push(k);
      }
      for (const [k, v] of Object.entries(f?.counts ?? {})) {
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        const slot = (featureCounts[k] ??= { sum: 0, devices: 0, values: [] });
        slot.sum += v;
        slot.devices++;
        slot.values.push(v);
        myCounts[k] = v;
      }
    } catch {
      /* ignore */
    }

    roster.push({
      // A prefix, not the id. The roster is a debugging aid, and nothing on the page
      // needs to address an account — so it does not carry one.
      acct: r.user_id.slice(0, 6),
      deviceId: r.device_id,
      // A browser sends its name and major version in these two columns, so this
      // reads "Chrome 142" for the web exactly as it reads "Google Pixel 8" for a
      // handset — see handleWebTelemetry.
      device: r.manufacturer && r.model ? `${r.manufacturer} ${r.model}` : r.model,
      platform: r.platform,
      versionName: r.version_name,
      versionCode: r.version_code,
      osApi: r.os_api,
      country: r.country,
      language: r.language,
      buildType: r.build_type,
      installer: r.installer,
      premium: r.premium == null ? null : r.premium === 1,
      gate: r.gate_outcome,
      adsConsent: r.ads_consent,
      integrations: myIntegrations,
      features: myFeatures,
      counts: myCounts,
      lastSeenAt: r.last_seen_at,
      serverEvents: serverHistory.get(r.user_id) ?? null,
    });
  }
  roster.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

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

  // Accounts that hold a session but have never landed a telemetry row — the gap between
  // "Accounts" and every distribution on the page. Before the history-sync fix these were
  // simply everyone who had not opened Friends in a day; after it, an account sitting here
  // for more than an hour is a real signal (signed in, then left) rather than an artefact
  // of where telemetry happened to be recorded.
  // The sub-select carries the same debug filter as `rows` above. Without it an account
  // that only ever reported from a debug build would leave `coverage.reporting` while
  // appearing in no list at all, and the honesty rail (`accounts - reporting`) would name
  // a gap the page could not show.
  const { results: orphans } = await env.DB.prepare(
    `SELECT id, created_at FROM users
      WHERE id NOT IN (
        SELECT user_id FROM user_telemetry
         WHERE ?1 = 0 OR build_type IS NULL OR build_type <> 'debug')
      ORDER BY created_at DESC`,
  )
    .bind(excludeDebug ? 1 : 0)
    .all<{ id: string; created_at: number }>();

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

  // Every day in the window, so an unrolled day arrives as a hole rather than vanishing.
  const byDay = new Map((daily ?? []).map((d) => [d.day, d]));
  const signupsByDay = new Map((signups ?? []).map((s) => [s.day, s.n]));
  const axis = everyDay(now - SERIES_DAYS * DAY_MS, now);

  const accountsTotal = totals?.accounts ?? 0;
  const historyAccounts = serverHistory.size;

  return json({
    generatedAt: now,
    today,
    /**
     * Whether debug builds were dropped, echoed back so the page can SAY so.
     *
     * ⚠️ It does not reach `series.daily`. That is read from `telemetry_daily`, which is
     * immutable once computed and holds no build type — the day was folded with debug
     * devices in it and cannot be refolded. Everything else on the page honours the flag,
     * so the trend is the one panel that must be labelled rather than filtered.
     */
    excludeDebug,
    /** 0 = no gate. Devices below it are blocked from the social surface. */
    minSocialVersion: floor,
    // Browsers excluded: they send no `X-App-Version`, so every one of them scores 0
    // and would count as a client below the floor forever. This number gates the
    // legacy-relay purge — it has to mean "old APKs still out there", nothing else.
    belowFloor:
      floor === 0 ? 0 : rows.filter((r) => r.platform !== "web" && (r.version_code ?? 0) < floor).length,

    /**
     * The page's honesty rail: how much of the account base can be measured at all.
     *
     * Every distribution below is drawn from `reporting`, never from `accounts`. Shipping
     * these four together is what stops a share being computed against a denominator the
     * page cannot see — which is the failure this whole panel exists to prevent.
     */
    coverage: {
      accounts: accountsTotal,
      /** Accounts with at least one `user_telemetry` row. */
      reporting: accounts.size,
      /** Accounts whose row carries the client-sent block, not just the header half. */
      rich: new Set(rows.filter((r) => r.version_name).map((r) => r.user_id)).size,
      activeToday: activeAccounts.d1.size,
    },

    /** Signed in, never reported. Ids are prefixes — the page never addresses an account. */
    orphanAccounts: (orphans ?? []).map((o) => ({ acct: o.id.slice(0, 6), createdAt: o.created_at })),

    /** One row per reporting device, most recently seen first. */
    roster,

    /**
     * Facts D1 can prove on its own, for the health strip. Each is a comparison the page
     * cannot make from the distributions above.
     */
    health: {
      /** Accounts with a server-side history document. */
      historyAccounts,
      historyEvents: [...serverHistory.values()].reduce((n, v) => n + v, 0),
      /**
       * Devices reporting a non-zero lifetime `watched` whose ACCOUNT has never uploaded.
       * A real backlog: the library exists on the device and the server has none of it.
       */
      historyNotUploaded: roster.filter((d) => (d.counts.watched ?? 0) > 0 && d.serverEvents == null).length,
      /**
       * Rows keyed on the empty device id — a client that reported before it sent a
       * deviceId. Harmless until the same device later reports properly, at which point
       * the account holds a permanent ghost row that double-counts it.
       */
      ghostDeviceRows: rows.filter((r) => r.device_id === "").length,
      /**
       * Rollup days missing BETWEEN the first one ever recorded and yesterday.
       *
       * ⚠️ Not "days in the window without a rollup". The window is 90 days and the
       * feature is younger than that, so that definition reports ~86 holes forever and
       * the health row it feeds is a warning that can never be cleared. A gap only means
       * anything inside the period we have actually been recording.
       */
      missingRollupDays: (() => {
        const first = (daily ?? [])[0]?.day;
        if (!first) return 0;
        return axis.filter((d) => d >= first && d < today && !byDay.has(d)).length;
      })(),
    },

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
      .map(([key, v]) => ({ key, sum: v.sum, devices: v.devices, values: [...v.values].sort((a, b) => a - b) }))
      .sort((a, b) => b.sum - a.sum),
    monetisation: { gate: ranked(gate), adsConsent: ranked(adsConsent) },

    series: {
      /**
       * The full date axis, with `null` on days that were never rolled up.
       *
       * ⚠️ `null` and `0` mean different things here and the chart must draw them
       * differently: 0 is "nobody synced", null is "we never computed this day and now
       * never will". Collapsing them — which is what handing over only the present days
       * did — turns a gap into a continuous line.
       */
      daily: axis.map((day) => {
        const d = byDay.get(day);
        return d
          ? { day, active: d.active, devices: d.devices, newUsers: d.new_users }
          : { day, active: null, devices: null, newUsers: null };
      }),
      /** Signups come from `users.created_at` directly, so a quiet day is a real 0. */
      signups: axis.map((day) => ({ day, n: signupsByDay.get(day) ?? 0 })),
    },
  });
}
