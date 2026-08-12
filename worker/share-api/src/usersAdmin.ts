// ── The admin Users panel ────────────────────────────────────────────────────
// Every account, with enough about each to answer a support question, plus the controls
// to act on one.
//
// Authorised by the shared ADMIN_KEY, never a user session — the same reasoning
// moderationQueue.ts and insights.ts already record: the admin is not a user of this
// system, and giving a users.id these powers would make an account takeover a moderation
// takeover.
//
// **How this differs from insights.ts, which already reads much of the same data.**
// That page is DEVICE-rowed and deliberately anonymous: one row per (user_id, device_id),
// `users.id` truncated to a six-character prefix, no email and no display name, because
// "the page never needs to address an account". This one does address accounts, so it
// collapses devices per person and carries full identity. The two must not restate each
// other's headline totals — a number derived twice is two numbers that cannot be
// reconciled — so nothing here recomputes "accounts" or "active"; that is Insights' job.
//
// The counts are gathered the way insights.ts gathers its dimensions: a handful of cheap
// whole-table scans folded in JS, not a correlated subquery per user per stat. At this row
// count one scan of a small table beats N round trips, and the JSON columns
// (`integrations`, `features`) cannot be grouped in SQL at all.

import { adminAuthorized } from "./commentsAdmin";
import { minSocialVersion } from "./profiles";
import { isPremiere } from "./premiere";
import { revokeAllSessions } from "./auth";
import { eraseAccount, type FriendsEnv } from "./friends";
// PERMANENT_UNTIL is shared with the posting suspension deliberately: one sentinel for
// "no end date" across every expiry column, so a single `>` covers every case everywhere.
import { suspensionUntil, PERMANENT_UNTIL } from "./suspension";
import { actorOf, recordAdminAction, adminActionsFor } from "./adminAudit";
import { notifyAccount, type NotifyEnv } from "./notify";

export interface UsersAdminEnv extends FriendsEnv, NotifyEnv {
  ADMIN_KEY?: string;
  MIN_SOCIAL_VERSION?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-Admin-Actor",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const DAY_MS = 86_400_000;

/**
 * The row cap.
 *
 * Generous, because the panel filters and sorts client-side and the whole roster arrives
 * in one payload — the same trade insights.ts makes. `truncated` travels with the
 * response so the page can SAY it is short: a silently truncated list is a panel that
 * lies, and the lie is invisible precisely when it matters (a full account base).
 *
 * Past roughly 10k accounts this wants server-side pagination and per-column counts from
 * their own query. It is not close to that today.
 */
const USERS_LIMIT = 2000;

/** How many of each per-person list the detail pane carries. */
const DETAIL_LIMIT = 20;

// ── Shared shapes ────────────────────────────────────────────────────────────

interface UserBaseRow {
  id: string;
  created_at: number;
  status: string;
  posting_suspended_until: number | null;
  friend_code: string | null;
  premiere_until: number | null;
  premiere_comp_until: number | null;
  premiere_since: number | null;
  picture_animated: number | null;
  first_install_at: number | null;
  beta_tester: number | null;
  push_self_topic: string | null;
  push_friend_topic: string | null;
  email: string | null;
  provider: string | null;
  firebase_uid: string | null;
  identity_created_at: number | null;
  display_name: string | null;
  avatar_id: string | null;
  border_id: string | null;
  picture_url: string | null;
  personality_id: string | null;
  visibility: string | null;
  profile_updated_at: number | null;
  event_count: number | null;
  title_count: number | null;
  last_watched_at: number | null;
  history_version: number | null;
  list_count: number | null;
  list_item_count: number | null;
}

/**
 * `users` plus every 1:1 table that hangs off it.
 *
 * LEFT JOINs throughout: an account with no profile, no identity, no history and no lists
 * is a real and common state (someone who signed in and left), and an INNER JOIN anywhere
 * here would silently drop exactly the accounts most worth looking at.
 *
 * ⚠️ `identities` is joined on `user_id` alone, without pinning the provider. Firebase is
 * the only provider today and the PK is (provider, subject), so an account holds exactly
 * one row; if a second provider is ever added this becomes a fan-out that duplicates
 * accounts in the list, and needs a MIN() or an explicit provider predicate.
 */
const BASE_SQL = `
  SELECT u.id, u.created_at, u.status, u.posting_suspended_until, u.friend_code,
         u.premiere_until, u.premiere_comp_until, u.premiere_since, u.picture_animated,
         u.first_install_at, u.beta_tester, u.push_self_topic, u.push_friend_topic,
         i.email, i.provider, i.subject AS firebase_uid, i.created_at AS identity_created_at,
         p.display_name, p.avatar_id, p.border_id, p.picture_url, p.personality_id,
         p.visibility, p.updated_at AS profile_updated_at,
         h.event_count, h.title_count, h.last_watched_at, h.version AS history_version,
         lm.list_count, lm.item_count AS list_item_count
    FROM users u
    LEFT JOIN identities  i  ON i.user_id = u.id
    LEFT JOIN profiles    p  ON p.user_id = u.id
    LEFT JOIN history_meta h ON h.user_id = u.id
    LEFT JOIN lists_meta  lm ON lm.user_id = u.id`;

export interface TelemetryFold {
  devices: number;
  platforms: string[];
  versionName: string | null;
  versionCode: number | null;
  buildType: string | null;
  osApi: number | null;
  device: string | null;
  country: string | null;
  language: string | null;
  installer: string | null;
  clientPremium: boolean | null;
  gate: string | null;
  adsConsent: string | null;
  integrations: string[];
  features: string[];
  counts: Record<string, number>;
  lastSeenAt: number | null;
  ghostRow: boolean;
}

interface TelemetryRow {
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

const TELEMETRY_SQL = `
  SELECT user_id, device_id, platform, version_code, version_name, build_type, country,
         language, os_api, manufacturer, model, installer, premium, gate_outcome,
         ads_consent, integrations, features, last_seen_at, reported_on
    FROM user_telemetry`;

/** `manufacturer model`, which reads "Google Pixel 8" for a handset and "Chrome 142" for the web. */
export const deviceLabel = (r: { manufacturer: string | null; model: string | null }): string | null =>
  r.manufacturer && r.model ? `${r.manufacturer} ${r.model}` : r.model;

/** Parse a JSON telemetry column. A malformed blob costs that device's contribution only. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return (JSON.parse(raw) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The `integrations` blob as a flat list. A string value is a CHOICE, kept as `key:value`. */
export function integrationList(raw: string | null): string[] {
  const parsed = parseJson<Record<string, unknown>>(raw, {});
  const out: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v) out.push(`${k}:${v}`);
    else if (v === true) out.push(k);
  }
  return out;
}

/**
 * Collapse an account's telemetry rows into one answer per dimension.
 *
 * ⚠️ This is the whole reason the panel exists separately from Insights, and the rules are
 * not arbitrary:
 *
 *  - **Newest device wins** for the point-in-time facts (version, build, OS, model,
 *    country, installer, gate). Taking the first row would describe whichever handset the
 *    scan happened to reach first, which for someone who has upgraded phones is the OLD
 *    one — and the version column is what an "are they on a current build" question reads.
 *  - **Counts take the MAXIMUM, never the sum.** `features.counts` are LIFETIME totals per
 *    device over the same synced library, so adding two devices double-counts one
 *    library. A person with a phone and a tablet does not watch twice as much.
 *  - **Integrations and surfaces UNION.** Configuring Trakt on one device is configuring
 *    it for the account.
 */
export function foldTelemetry(rows: TelemetryRow[]): TelemetryFold {
  const newestFirst = [...rows].sort((a, b) => b.last_seen_at - a.last_seen_at);
  const newest = newestFirst[0];
  // The newest APP row, for the Android-shaped columns. A browser sends no
  // `X-App-Version` (so version_code is 0, not NULL) and puts its own name in
  // manufacturer/model, so reading them off a web row reports "an app on version 0" —
  // the exact mistake insights.ts documents at length.
  const newestApp = newestFirst.find((r) => r.platform !== "web") ?? null;

  const integrations = new Set<string>();
  const features = new Set<string>();
  const counts: Record<string, number> = {};
  for (const r of rows) {
    for (const k of integrationList(r.integrations)) integrations.add(k);
    const f = parseJson<{ used?: string[]; counts?: Record<string, number> }>(r.features, {});
    for (const k of f.used ?? []) features.add(k);
    for (const [k, v] of Object.entries(f.counts ?? {})) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      counts[k] = Math.max(counts[k] ?? 0, v);
    }
  }

  return {
    devices: rows.length,
    platforms: [...new Set(rows.map((r) => r.platform).filter((p): p is string => !!p))].sort(),
    versionName: newestApp?.version_name ?? null,
    versionCode: newestApp?.version_code ?? null,
    buildType: newestApp?.build_type ?? null,
    osApi: newestApp?.os_api ?? null,
    device: newest ? deviceLabel(newest) : null,
    country: newest?.country ?? null,
    language: newest?.language ?? null,
    installer: newestApp?.installer ?? null,
    clientPremium: newest?.premium == null ? null : newest.premium === 1,
    gate: newestApp?.gate_outcome ?? null,
    adsConsent: newestApp?.ads_consent ?? null,
    integrations: [...integrations].sort(),
    features: [...features].sort(),
    counts,
    lastSeenAt: newest?.last_seen_at ?? null,
    ghostRow: rows.some((r) => r.device_id === ""),
  };
}

/**
 * `user_id -> n` for one COUNT query.
 *
 * One scan per table, each returning at most one row per account. Cheaper than a
 * subquery per user per stat by a factor of the account count, and D1 charges reads at
 * $0.001/M — the expensive side is writes.
 */
async function tally(db: D1Database, sql: string, ...binds: unknown[]): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<{ k: string; n: number }>();
  return new Map((results ?? []).map((r) => [r.k, r.n]));
}

/** Every per-user count the list shows, in one pass. */
async function loadTallies(db: D1Database) {
  const [
    comments,
    commentsHidden,
    commentsDeleted,
    reactionsGiven,
    reactionsReceived,
    votes,
    feedEvents,
    friends,
    friendsPending,
    blocksMade,
    blocksReceived,
    sharedSent,
    sharedReceived,
    matchMade,
    matchReceived,
    reportsFiled,
    reportsAgainst,
    reportsAgainstOpen,
    feedback,
    integrationsConnected,
    pushQueued,
    pushStuck,
    sessionsLive,
    lastSignIn,
  ] = await Promise.all([
    tally(db, "SELECT author_id AS k, COUNT(*) AS n FROM comments WHERE deleted_at IS NULL GROUP BY author_id"),
    tally(db, "SELECT author_id AS k, COUNT(*) AS n FROM comments WHERE hidden_at IS NOT NULL GROUP BY author_id"),
    tally(db, "SELECT author_id AS k, COUNT(*) AS n FROM comments WHERE deleted_at IS NOT NULL GROUP BY author_id"),
    tally(db, "SELECT user_id AS k, COUNT(*) AS n FROM comment_reactions GROUP BY user_id"),
    tally(
      db,
      `SELECT c.author_id AS k, COUNT(*) AS n FROM comment_reactions r
         JOIN comments c ON c.id = r.comment_id GROUP BY c.author_id`,
    ),
    tally(db, "SELECT user_id AS k, COUNT(*) AS n FROM episode_votes GROUP BY user_id"),
    tally(db, "SELECT author_id AS k, COUNT(*) AS n FROM feed_events GROUP BY author_id"),
    // Both columns, because the pair is stored once in canonical order — counting only
    // `user_a` would halve every friend count in the panel.
    tally(
      db,
      `SELECT k, COUNT(*) AS n FROM (
         SELECT user_a AS k FROM friendships WHERE state = 'accepted'
         UNION ALL
         SELECT user_b AS k FROM friendships WHERE state = 'accepted') GROUP BY k`,
    ),
    tally(
      db,
      `SELECT k, COUNT(*) AS n FROM (
         SELECT user_a AS k FROM friendships WHERE state = 'pending'
         UNION ALL
         SELECT user_b AS k FROM friendships WHERE state = 'pending') GROUP BY k`,
    ),
    tally(db, "SELECT blocker_id AS k, COUNT(*) AS n FROM blocks GROUP BY blocker_id"),
    tally(db, "SELECT blocked_id AS k, COUNT(*) AS n FROM blocks GROUP BY blocked_id"),
    tally(db, "SELECT sender_id AS k, COUNT(*) AS n FROM shared_lists GROUP BY sender_id"),
    tally(db, "SELECT recipient_id AS k, COUNT(*) AS n FROM shared_lists GROUP BY recipient_id"),
    tally(db, "SELECT requester_id AS k, COUNT(*) AS n FROM match_requests GROUP BY requester_id"),
    tally(db, "SELECT target_id AS k, COUNT(*) AS n FROM match_requests GROUP BY target_id"),
    tally(db, "SELECT reporter_id AS k, COUNT(*) AS n FROM reports GROUP BY reporter_id"),
    tally(db, "SELECT target_id AS k, COUNT(*) AS n FROM reports GROUP BY target_id"),
    tally(db, "SELECT target_id AS k, COUNT(*) AS n FROM reports WHERE state = 'open' GROUP BY target_id"),
    tally(db, "SELECT user_id AS k, COUNT(*) AS n FROM feedback WHERE user_id IS NOT NULL GROUP BY user_id"),
    tally(db, "SELECT user_id AS k, COUNT(*) AS n FROM user_integrations WHERE connected = 1 GROUP BY user_id"),
    tally(db, "SELECT user_id AS k, COUNT(*) AS n FROM pending_integration_push GROUP BY user_id"),
    tally(
      db,
      "SELECT user_id AS k, COUNT(*) AS n FROM pending_integration_push WHERE failed_at IS NOT NULL GROUP BY user_id",
    ),
    tally(
      db,
      "SELECT user_id AS k, COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ? GROUP BY user_id",
      Date.now(),
    ),
    // MAX rather than COUNT, but the same shape, so it rides the same helper.
    tally(db, "SELECT user_id AS k, MAX(created_at) AS n FROM sessions GROUP BY user_id"),
  ]);

  return {
    comments,
    commentsHidden,
    commentsDeleted,
    reactionsGiven,
    reactionsReceived,
    votes,
    feedEvents,
    friends,
    friendsPending,
    blocksMade,
    blocksReceived,
    sharedSent,
    sharedReceived,
    matchMade,
    matchReceived,
    reportsFiled,
    reportsAgainst,
    reportsAgainstOpen,
    feedback,
    integrationsConnected,
    pushQueued,
    pushStuck,
    sessionsLive,
    lastSignIn,
  };
}

/** `json_array_length` per account, for the achievements column. */
async function loadAchievementCounts(db: D1Database): Promise<Map<string, { count: number; rulesVersion: number }>> {
  const { results } = await db
    .prepare(
      `SELECT user_id, rules_version,
              -- Defensive: a payload that is not a JSON array yields NULL rather than
              -- failing the whole query, which one bad row otherwise would.
              CASE WHEN json_valid(payload) THEN json_array_length(payload) ELSE NULL END AS n
         FROM user_achievements`,
    )
    .all<{ user_id: string; rules_version: number; n: number | null }>();
  return new Map((results ?? []).map((r) => [r.user_id, { count: r.n ?? 0, rulesVersion: r.rules_version }]));
}

// ── GET /api/users ───────────────────────────────────────────────────────────

export async function handleUsersList(req: Request, env: UsersAdminEnv): Promise<Response> {
  if (!adminAuthorized(req, env as never)) return json({ error: "unauthorized" }, 401);

  const now = Date.now();
  const floor = minSocialVersion(env);

  const [{ results: base }, { results: telemetry }, tallies, achievements, total] = await Promise.all([
    env.DB.prepare(`${BASE_SQL} ORDER BY u.created_at DESC LIMIT ?`).bind(USERS_LIMIT).all<UserBaseRow>(),
    env.DB.prepare(TELEMETRY_SQL).all<TelemetryRow>(),
    loadTallies(env.DB),
    loadAchievementCounts(env.DB),
    env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>(),
  ]);

  const byUser = new Map<string, TelemetryRow[]>();
  for (const r of telemetry ?? []) {
    const list = byUser.get(r.user_id);
    if (list) list.push(r);
    else byUser.set(r.user_id, [r]);
  }

  const users = (base ?? []).map((u) => {
    const t = foldTelemetry(byUser.get(u.id) ?? []);
    const ach = achievements.get(u.id);
    const n = (m: Map<string, number>) => m.get(u.id) ?? 0;
    const serverEvents = u.event_count;

    return {
      // ── Identity ──
      id: u.id,
      displayName: u.display_name,
      email: u.email,
      firebaseUid: u.firebase_uid,
      provider: u.provider,
      friendCode: u.friend_code,
      avatarId: u.avatar_id,
      borderId: u.border_id,
      pictureUrl: u.picture_url,
      pictureAnimated: (u.picture_animated ?? 0) === 1,
      personalityId: u.personality_id,
      visibility: u.visibility,

      // ── Lifecycle ──
      createdAt: u.created_at,
      firstInstallAt: u.first_install_at ?? 0,
      lastSeenAt: t.lastSeenAt,
      lastWatchedAt: u.last_watched_at,
      lastSignInAt: tallies.lastSignIn.get(u.id) ?? null,
      profileUpdatedAt: u.profile_updated_at,
      ageDays: Math.floor((now - u.created_at) / DAY_MS),
      daysSinceSeen: t.lastSeenAt == null ? null : Math.floor((now - t.lastSeenAt) / DAY_MS),

      // ── Status & entitlement ──
      status: u.status,
      postingSuspendedUntil: (u.posting_suspended_until ?? 0) > now ? u.posting_suspended_until : 0,
      isPremiere: isPremiere(u, now),
      premiereUntil: u.premiere_until ?? 0,
      premiereCompUntil: u.premiere_comp_until ?? 0,
      premiereSince: u.premiere_since ?? 0,
      /** Which source entitles them right now — for the "paid vs comped" filter. */
      premiereSource: premiereSource(u, now),
      betaTester: (u.beta_tester ?? 0) === 1,
      pushTopicsSet: !!u.push_self_topic || !!u.push_friend_topic,
      sessionsLive: n(tallies.sessionsLive),

      // ── Device & app, folded across their devices ──
      devices: t.devices,
      platforms: t.platforms,
      versionName: t.versionName,
      versionCode: t.versionCode,
      buildType: t.buildType,
      osApi: t.osApi,
      device: t.device,
      country: t.country,
      language: t.language,
      installer: t.installer,
      clientPremium: t.clientPremium,
      gate: t.gate,
      adsConsent: t.adsConsent,

      // ── Integrations ──
      integrations: t.integrations,
      integrationsConnected: n(tallies.integrationsConnected),

      // ── Engagement ──
      serverEvents,
      titleCount: u.title_count,
      historyVersion: u.history_version,
      clientCounts: t.counts,
      surfaces: t.features,
      comments: n(tallies.comments),
      commentsHidden: n(tallies.commentsHidden),
      commentsDeleted: n(tallies.commentsDeleted),
      reactionsGiven: n(tallies.reactionsGiven),
      reactionsReceived: n(tallies.reactionsReceived),
      votes: n(tallies.votes),
      feedEvents: n(tallies.feedEvents),
      lists: u.list_count ?? 0,
      listItems: u.list_item_count ?? 0,
      friends: n(tallies.friends),
      friendsPending: n(tallies.friendsPending),
      blocksMade: n(tallies.blocksMade),
      blocksReceived: n(tallies.blocksReceived),
      sharedListsSent: n(tallies.sharedSent),
      sharedListsReceived: n(tallies.sharedReceived),
      matchRequestsMade: n(tallies.matchMade),
      matchRequestsReceived: n(tallies.matchReceived),
      achievements: ach?.count ?? 0,
      achievementsRulesVersion: ach?.rulesVersion ?? null,
      reportsFiled: n(tallies.reportsFiled),
      reportsAgainst: n(tallies.reportsAgainst),
      reportsAgainstOpen: n(tallies.reportsAgainstOpen),
      feedbackSubmitted: n(tallies.feedback),
      pushQueued: n(tallies.pushQueued),
      pushStuck: n(tallies.pushStuck),

      // ── Health flags, derived HERE so the panel and the API cannot disagree ──
      flags: {
        /** Holds an account but has never landed a telemetry row: signed in, then left. */
        orphan: t.devices === 0,
        /**
         * The device reports a non-empty library and the server has none of it. A real
         * backlog, not a cosmetic mismatch — the events exist only on the handset.
         */
        historyNotUploaded: (t.counts.watched ?? 0) > 0 && serverEvents == null,
        ghostDeviceRow: t.ghostRow,
        /**
         * Below the social floor. App rows only: a browser sends no `X-App-Version`, so
         * it scores 0 and would sit here forever.
         */
        belowFloor: floor > 0 && t.versionCode != null && t.versionCode < floor,
        /**
         * No usable profile — which is NOT the same as no `profiles` row.
         *
         * ⚠️ This used to require `profile_updated_at == null` as well, i.e. no row at
         * all, and so said nothing about a row that exists with no name in it. The
         * roster then showed an unnamed account with no flag beside it, which reads as
         * "named, but the name is missing" — the one reading that is impossible. Found
         * 2026-08-12: `version = 1`, every column NULL, `layout` at its default,
         * written by a client that pushed before the user had typed a name.
         *
         * Keyed on the display name alone, because that is what the panel actually
         * renders and what a support question is about. `''` counts too: the client
         * sends all 14 fields on every save, so an unset name arrives as an empty
         * string and `str()` stores NULL — but a row written by any other path could
         * hold the empty string, and both draw as "unnamed".
         */
        noProfile: !u.display_name,
        noEmail: !u.email,
        /** What the device believes about its entitlement, against what the server knows. */
        premiumMismatch: t.clientPremium != null && t.clientPremium !== isPremiere(u, now),
      },
    };
  });

  return json({
    generatedAt: now,
    minSocialVersion: floor,
    total: total?.n ?? users.length,
    /** True when the cap cut the list. The panel MUST say so — see USERS_LIMIT. */
    truncated: (total?.n ?? 0) > users.length,
    limit: USERS_LIMIT,
    users,
  });
}

/** Which column is entitling this account right now. `null` when neither is. */
function premiereSource(
  u: { premiere_until: number | null; premiere_comp_until: number | null },
  now: number,
): "paid" | "comp" | "both" | null {
  const paid = (u.premiere_until ?? 0) > now;
  const comp = (u.premiere_comp_until ?? 0) > now;
  if (paid && comp) return "both";
  if (paid) return "paid";
  if (comp) return "comp";
  return null;
}

// ── GET /api/users/{id} ──────────────────────────────────────────────────────

/**
 * The wide, per-person data that has no place in a list row.
 *
 * A second endpoint rather than more columns on the first: these are per-account LISTS,
 * and carrying twenty comments and every device row for two thousand accounts would make
 * the roster payload enormous to render one pane.
 */
export async function handleUserDetail(req: Request, env: UsersAdminEnv, userId: string): Promise<Response> {
  if (!adminAuthorized(req, env as never)) return json({ error: "unauthorized" }, 401);
  if (!userId) return json({ error: "bad_request" }, 400);

  const base = await env.DB.prepare(`${BASE_SQL} WHERE u.id = ?`).bind(userId).first<UserBaseRow>();
  if (!base) return json({ error: "not_found" }, 404);

  const [
    { results: devices },
    { results: sessions },
    achievements,
    settings,
    stats,
    { results: comments },
    { results: reportsAgainst },
    { results: reportsFiled },
    { results: feedback },
    { results: lists },
    { results: friends },
    { results: blocks },
    { results: integrations },
    history,
  ] = await Promise.all([
    env.DB.prepare(`${TELEMETRY_SQL} WHERE user_id = ? ORDER BY last_seen_at DESC`)
      .bind(userId)
      .all<TelemetryRow>(),
    env.DB.prepare(
      `SELECT created_at, expires_at, revoked_at FROM sessions WHERE user_id = ?
        ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(userId, DETAIL_LIMIT)
      .all<{ created_at: number; expires_at: number; revoked_at: number | null }>(),
    env.DB.prepare("SELECT payload, rules_version, updated_at FROM user_achievements WHERE user_id = ?")
      .bind(userId)
      .first<{ payload: string; rules_version: number; updated_at: number }>(),
    env.DB.prepare("SELECT payload, updated_at FROM user_settings WHERE user_id = ?")
      .bind(userId)
      .first<{ payload: string; updated_at: number }>(),
    env.DB.prepare("SELECT stats, updated_at FROM profile_stats WHERE user_id = ?")
      .bind(userId)
      .first<{ stats: string | null; updated_at: number }>(),
    env.DB.prepare(
      `SELECT id, tmdb_id, media_type, season, episode, body, visibility, spoiler,
              hidden_at, deleted_at, created_at
         FROM comments WHERE author_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(userId, DETAIL_LIMIT)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT kind, context, state, body_snapshot, created_at, reporter_id
         FROM reports WHERE target_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(userId, DETAIL_LIMIT)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT kind, context, state, target_id, created_at
         FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(userId, DETAIL_LIMIT)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT topic, message, contact, platform, app_version, device, os_version, locale,
              state, admin_note, created_at
         FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(userId, DETAIL_LIMIT)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id, name, kind, is_pinned_to_home, updated_at,
              (SELECT COUNT(*) FROM list_items li WHERE li.user_id = l.user_id AND li.list_id = l.id) AS items
         FROM lists l WHERE l.user_id = ? AND l.deleted_at IS NULL ORDER BY l.updated_at DESC`,
    )
      .bind(userId)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END AS friend_id,
              f.state, f.created_at, p.display_name
         FROM friendships f
         LEFT JOIN profiles p
                ON p.user_id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
        WHERE f.user_a = ?1 OR f.user_b = ?1
        ORDER BY f.created_at DESC`,
    )
      .bind(userId)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT blocker_id, blocked_id, display_name, created_at FROM blocks
        WHERE blocker_id = ? OR blocked_id = ? ORDER BY created_at DESC`,
    )
      .bind(userId, userId)
      .all<Record<string, unknown>>(),
    env.DB.prepare("SELECT target, connected, updated_at, reconcile_at FROM user_integrations WHERE user_id = ?")
      .bind(userId)
      .all<Record<string, unknown>>(),
    env.DB.prepare("SELECT version, event_count, title_count, last_watched_at, updated_at FROM history_meta WHERE user_id = ?")
      .bind(userId)
      .first<Record<string, unknown>>(),
  ]);

  return json({
    generatedAt: Date.now(),
    id: base.id,
    devices: (devices ?? []).map((d) => ({
      deviceId: d.device_id,
      device: deviceLabel(d),
      platform: d.platform,
      versionName: d.version_name,
      versionCode: d.version_code,
      buildType: d.build_type,
      osApi: d.os_api,
      country: d.country,
      language: d.language,
      installer: d.installer,
      premium: d.premium == null ? null : d.premium === 1,
      gate: d.gate_outcome,
      adsConsent: d.ads_consent,
      integrations: integrationList(d.integrations),
      features: parseJson<{ used?: string[]; counts?: Record<string, number> }>(d.features, {}),
      lastSeenAt: d.last_seen_at,
      reportedOn: d.reported_on,
    })),
    sessions: (sessions ?? []).map((s) => ({
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      revokedAt: s.revoked_at,
    })),
    achievements: achievements
      ? {
          rulesVersion: achievements.rules_version,
          updatedAt: achievements.updated_at,
          unlocked: parseJson<unknown[]>(achievements.payload, []),
        }
      : null,
    settings: settings ? { updatedAt: settings.updated_at, payload: parseJson(settings.payload, {}) } : null,
    profileStats: stats ? { updatedAt: stats.updated_at, stats: parseJson(stats.stats ?? null, null) } : null,
    history: history ?? null,
    comments: comments ?? [],
    reportsAgainst: reportsAgainst ?? [],
    reportsFiled: reportsFiled ?? [],
    feedback: feedback ?? [],
    lists: lists ?? [],
    friends: friends ?? [],
    blocks: blocks ?? [],
    integrations: integrations ?? [],
    adminActions: await adminActionsFor(env.DB, userId),
  });
}

// ── POST /api/users/act ──────────────────────────────────────────────────────
// ONE endpoint over an allow-list, mirroring handleModerationAct. The alternative is the
// browser choosing between nine URLs, which puts routing knowledge in the client and gives
// the audit trail nine places to be forgotten.

type Action =
  | "ban"
  | "unban"
  | "signout"
  | "suspend"
  | "unsuspend"
  | "comp_grant"
  | "comp_revoke"
  | "beta_grant"
  | "delete";

const ACTIONS = new Set<Action>([
  "ban",
  "unban",
  "signout",
  "suspend",
  "unsuspend",
  "comp_grant",
  "comp_revoke",
  "beta_grant",
  "delete",
]);

/**
 * Comp durations, in ms. `0` means permanent.
 *
 * An allow-list rather than a range, for the reason SUSPEND_DURATIONS gives: the panel is
 * the only caller and these are the only buttons, so validating against the list turns a
 * malformed request into a 400 instead of a 300-year entitlement.
 */
export const COMP_DURATIONS: readonly number[] = [
  30 * DAY_MS, // a month
  90 * DAY_MS, // a quarter
  365 * DAY_MS, // a year
  0, // permanent
];

/** A preset duration → the deadline to store, or `null` if it is not a preset. */
export function compUntil(durationMs: number): number | null {
  if (!COMP_DURATIONS.includes(durationMs)) return null;
  return durationMs === 0 ? PERMANENT_UNTIL : Date.now() + durationMs;
}

/**
 * Wake every device on an account so it re-reads its entitlement now rather than at the
 * next 6-hour sync.
 *
 * `notifyAccount` sends the bare `inbox_update` that already means "sync now" to every
 * build in the field — see its own note on why inventing a new `type` would reach nobody.
 * The client picks the comp up from the top-level `premiereCompUntil` that
 * `handleSync` returns.
 *
 * Awaited rather than deferred to `ctx.waitUntil`: an admin action has no latency budget
 * worth protecting, and `ctx?.waitUntil(f())` does not call `f` at all when `ctx` is
 * undefined. Best-effort — a push that fails must not fail the comp that succeeded.
 */
async function wake(env: UsersAdminEnv, userId: string, notify: NotifyAccount): Promise<void> {
  try {
    await notify(env, userId);
  } catch {
    // Deliberately silent: the entitlement is already written, and the 6-hour sync is
    // the fallback this only shortens.
  }
}

/** Injectable so tests assert the wake without an FCM round trip. */
export type NotifyAccount = (env: UsersAdminEnv, userId: string) => Promise<void>;

export async function handleUsersAct(
  req: Request,
  env: UsersAdminEnv,
  notify: NotifyAccount = notifyAccount,
): Promise<Response> {
  if (!adminAuthorized(req, env as never)) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const userId = typeof body.userId === "string" ? body.userId : "";
  const action = String(body.action ?? "") as Action;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
  if (!userId || !ACTIONS.has(action)) return json({ error: "bad_request" }, 400);

  const owner = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first<{ id: string }>();
  if (!owner) return json({ error: "not_found" }, 404);

  const actor = actorOf(req);
  const log = (detail?: Record<string, unknown>) =>
    recordAdminAction(env.DB, actor, action, userId, { ...detail, ...(reason ? { reason } : {}) });

  switch (action) {
    /**
     * The hard ban. `users.status` blocks the next sign-in; `revokeAllSessions` is what
     * ends the ones already out there — see its own note. Both, always: either alone is
     * a ban that does not bite.
     */
    case "ban": {
      await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(userId).run();
      const ended = await revokeAllSessions(env, userId);
      await log({ sessionsEnded: ended });
      return json({ ok: true, sessionsEnded: ended });
    }

    /**
     * Lets them sign in again. Deliberately does NOT restore sessions — they were
     * revoked, not suspended, and a revoked token is gone. The next launch signs in and
     * mints a fresh one, which is also the only way the client learns it is welcome back.
     */
    case "unban":
      await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(userId).run();
      await log();
      return json({ ok: true });

    case "signout": {
      const ended = await revokeAllSessions(env, userId);
      await log({ sessionsEnded: ended });
      return json({ ok: true, sessionsEnded: ended });
    }

    /**
     * Posting suspension — comments, pictures and profile text, nothing else. Reuses
     * `suspensionUntil` so the panel cannot invent a duration the rest of the system has
     * never seen.
     */
    case "suspend": {
      const until = suspensionUntil(Number(body.durationMs));
      if (until == null) return json({ error: "invalid_duration" }, 400);
      await env.DB.prepare("UPDATE users SET posting_suspended_until = ? WHERE id = ?").bind(until, userId).run();
      await log({ durationMs: Number(body.durationMs), until });
      return json({ ok: true, until });
    }

    case "unsuspend":
      await env.DB.prepare("UPDATE users SET posting_suspended_until = NULL WHERE id = ?").bind(userId).run();
      await log();
      return json({ ok: true });

    /**
     * ⚠️ Writes `premiere_comp_until`, NEVER `premiere_until` — that column belongs to the
     * Play verifier and is overwritten with Google's answer, including 0. And never
     * `premiere_since`, whose one-shot guard would record the date of a freebie as the
     * date they started paying. See migration 0031.
     */
    case "comp_grant": {
      const until = compUntil(Number(body.durationMs));
      if (until == null) return json({ error: "invalid_duration" }, 400);
      await env.DB.prepare("UPDATE users SET premiere_comp_until = ? WHERE id = ?").bind(until, userId).run();
      await log({ durationMs: Number(body.durationMs), until });
      await wake(env, userId, notify);
      return json({ ok: true, until });
    }

    case "comp_revoke":
      await env.DB.prepare("UPDATE users SET premiere_comp_until = 0 WHERE id = ?").bind(userId).run();
      await log();
      // Revoke wakes them too. A comp that is removed the moment the person opens the app
      // and one that lingers for six hours are different products, and support removing a
      // comp usually means it is going to somebody else.
      await wake(env, userId, notify);
      return json({ ok: true });

    /**
     * Grant only. `beta_tester` is a deliberate one-way latch (migration 0030): someone
     * who qualified in July and reinstalls in September has no early `firstInstallTime`
     * left to prove it with, and taking the badge away because their phone forgot would
     * punish them for owning a phone. There is no `beta_revoke`.
     */
    case "beta_grant":
      await env.DB.prepare("UPDATE users SET beta_tester = 1 WHERE id = ?").bind(userId).run();
      await log();
      return json({ ok: true });

    /**
     * Irreversible. Two guards, both deliberate:
     *
     *  - `confirm` must echo the id, so a mis-click on a row cannot erase an account.
     *  - the audit row is written BEFORE the erasure, because afterwards there is no row
     *    to reference and a throw part-way would lose the record of an erasure that
     *    partly happened — exactly when it matters most.
     */
    default: {
      if (body.confirm !== userId) return json({ error: "confirm_required" }, 400);
      await log({ irreversible: true });
      await eraseAccount(env, userId);
      return json({ ok: true });
    }
  }
}
