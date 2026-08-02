/**
 * Server-side watch history — the sync endpoint, the paginated history read, the
 * derived stats, and the platform-wide aggregate.
 *
 * ## Everything here is ADDITIVE to a device that works without it
 *
 * The app is account-free by design: watching, rating and browsing all work with no
 * account at all, against Room on the device. This module is a sync layer bolted to
 * the side of that, and the client gates every call in here on holding a session
 * token. Nothing on the server is ever the primary copy, and nothing here can cause
 * a client to delete local data it did not itself delete — the one exception being a
 * `deleted_at` tombstone, which is a deletion the user performed on another device.
 *
 * ## One write per watch event, and the totals are derived
 *
 * `POST /api/history/sync` writes one row per event and nothing else. There is no
 * counter table to keep in step; `GET /api/history/stats` derives the totals with a
 * GROUP BY and caches the answer in KV for five minutes. The same trade the poll and
 * comment features already made (migrations 0013–0015), for the same reason: watching
 * is the hot write, and counters multiply it.
 *
 * `user_ratings` is touched only when the request carries ratings — an explicit user
 * action. A watch event never writes it.
 *
 * ## No third-party tokens live here
 *
 * Trakt and SIMKL OAuth tokens stay on the device. Phase 3 has the server coordinate
 * WHICH events need pushing; the device executes the push with its own token. That is
 * why `pendingPush` is on the response shape already and always empty for now — the
 * wire contract is fixed before the feature lands, so the client that ships first
 * does not need a second version of the parser.
 */

import { resolveSession } from "./auth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-Revoke-Session",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

export interface HistoryEnv {
  DB: D1Database;
  /** Derived-stats cache. Optional so the whole feature degrades to "always derive". */
  HISTORY_STATS_KV?: KVNamespace;
  /** One data point per synced watch event. Optional; absent simply records nothing. */
  HISTORY_ANALYTICS?: { writeDataPoint(event: AnalyticsDataPoint): void };
  /** Account id for the Analytics Engine SQL API. */
  CF_ACCOUNT_ID?: string;
  /** API token with Account Analytics: Read. A SECRET. Absent ⇒ global stats 503. */
  ANALYTICS_API_TOKEN?: string;
}

interface AnalyticsDataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

// ── Limits ──────────────────────────────────────────────────────────────────

/**
 * Events accepted in one sync call.
 *
 * ⚠️ This is a CHOSEN number, not a platform ceiling. An earlier version of this
 * comment claimed "D1 caps a batch at 100 statements"; that is false, and the kind of
 * false-fact-in-a-comment that gets believed later. D1's documented "100" is
 * **maximum bound parameters per QUERY** — per individual statement — and the INSERT
 * below binds 15. Nothing here is near a limit.
 *
 * What actually argues for chunking is failure semantics, not size. `DB.batch()` is a
 * transaction: every row lands or none do. A phone uploading a decade of history in
 * one request over mobile data, dying at 95%, would keep nothing and start again. At
 * this size each batch commits independently, so progress is durable and resumable —
 * which is what let a mis-triggered back-fill recover with no user action on
 * 2026-08-02.
 *
 * The secondary argument is Worker CPU: building N prepared statements is CPU time,
 * and the budget is per invocation.
 *
 * Raised 100 -> 500 on 2026-08-02 after measuring a real back-fill: 2,917 events at
 * 100/pass took ~15 minutes, and 500 brings that to ~3. Still nowhere near any limit.
 *
 * ⚠️ ORDER MATTERS if this ever changes again: the SERVER's cap must be deployed
 * BEFORE a client that sends more, or the client gets a 413 and syncs NOTHING — not
 * a slower sync, no sync at all.
 */
export const MAX_EVENTS_PER_SYNC = 500;
/** Same reasoning; ratings are a separate batch. */
export const MAX_RATINGS_PER_SYNC = 500;
/** Delta rows handed back per sync. The client pages by re-syncing with the new cursor. */
const MAX_DELTA_EVENTS = 500;
const MAX_DELTA_RATINGS = 500;

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** A watch counts toward the totals at this much progress. Below it, it is an abandon. */
const WATCHED_THRESHOLD_PCT = 80;

/** How long a derived stats blob stays in KV. Every write that could move it deletes it. */
const STATS_TTL_SECONDS = 300;
/** Global stats change slowly and cost an off-box query, so they are cached far longer. */
const GLOBAL_STATS_TTL_SECONDS = 3600;

const statsKey = (userId: string) => `history:stats:${userId}`;
const GLOBAL_STATS_KEY = "history:stats:global";

const MEDIA_TYPES = new Set(["MOVIE", "SHOW"]);

// ── Wire shapes ─────────────────────────────────────────────────────────────

export interface WatchEventPayload {
  id: string;
  mediaType: string;
  tmdbId: number;
  tvdbId?: number | null;
  showTmdbId?: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  watchedAt: number;
  source?: string;
  progressPct?: number;
  deviceId?: string | null;
  deletedAt?: number | null;
  updatedAt?: number;
}

export interface RatingPayload {
  mediaType: string;
  tmdbId: number;
  watchStatus?: string | null;
  rating?: number | null;
  feedback?: string | null;
  updatedAt: number;
}

// ── Validation ──────────────────────────────────────────────────────────────
//
// Every field below becomes a primary-key component, an index entry or a number the
// stats derivation trusts. Validated rather than trusted: the client is not the only
// thing that can reach an authenticated endpoint, and a `watched_at` of NaN or a
// 4 MB `id` would be stored happily by D1 and only surface as a broken history page.

const isFiniteInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Null for anything malformed, so a bad event is dropped rather than half-written. */
export function parseEvent(raw: unknown): WatchEventPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;

  // The client's canonical id (`watch-EPISODE-1396-s2e5-1753027200`). Bounded because
  // it is half the primary key.
  if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > 200) return null;

  const mediaType = typeof e.mediaType === "string" ? e.mediaType.toUpperCase() : "";
  if (!MEDIA_TYPES.has(mediaType)) return null;

  if (!isFiniteInt(e.tmdbId) || e.tmdbId <= 0) return null;
  if (!isFiniteInt(e.watchedAt) || e.watchedAt <= 0) return null;

  const season = e.seasonNumber == null ? null : isFiniteInt(e.seasonNumber) ? e.seasonNumber : NaN;
  const episode = e.episodeNumber == null ? null : isFiniteInt(e.episodeNumber) ? e.episodeNumber : NaN;
  if (Number.isNaN(season) || Number.isNaN(episode)) return null;

  const tvdbId = e.tvdbId == null ? null : isFiniteInt(e.tvdbId) ? e.tvdbId : null;

  // For a SHOW the row's own tmdbId IS the show — the Android entity has no separate
  // column — so the client may omit it and the server fills it in. Movies keep NULL,
  // which is what the partial per-show index is built on.
  const showTmdbId =
    mediaType === "SHOW" ? (isFiniteInt(e.showTmdbId) && e.showTmdbId > 0 ? e.showTmdbId : e.tmdbId) : null;

  // Clamped, not rejected: a progress percentage outside 0–100 is a client rounding
  // bug, and throwing away the user's watch over it would be a worse answer than
  // recording it at the nearest legal value.
  const progressRaw = isFiniteInt(e.progressPct) ? e.progressPct : 100;
  const progressPct = Math.max(0, Math.min(100, progressRaw));

  const source = typeof e.source === "string" && e.source ? e.source.slice(0, 32).toUpperCase() : "INTERNAL";
  const deviceId = typeof e.deviceId === "string" && e.deviceId ? e.deviceId.slice(0, 64) : null;
  const deletedAt = isFiniteInt(e.deletedAt) && e.deletedAt > 0 ? e.deletedAt : null;
  const updatedAt = isFiniteInt(e.updatedAt) && e.updatedAt > 0 ? e.updatedAt : Date.now();

  return {
    id: e.id,
    mediaType,
    tmdbId: e.tmdbId,
    tvdbId,
    showTmdbId,
    seasonNumber: season,
    episodeNumber: episode,
    watchedAt: e.watchedAt,
    source,
    progressPct,
    deviceId,
    deletedAt,
    updatedAt,
  };
}

export function parseRating(raw: unknown): RatingPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const mediaType = typeof r.mediaType === "string" ? r.mediaType.toUpperCase() : "";
  if (!MEDIA_TYPES.has(mediaType)) return null;
  if (!isFiniteInt(r.tmdbId) || r.tmdbId <= 0) return null;
  if (!isFiniteInt(r.updatedAt) || r.updatedAt <= 0) return null;

  // 1–10, matching the in-app rating scale and `episode_votes`. REAL rather than
  // INTEGER on the column because half-stars are a plausible future; the bound is
  // what matters, not the granularity.
  let rating: number | null = null;
  if (r.rating != null) {
    if (typeof r.rating !== "number" || !Number.isFinite(r.rating)) return null;
    if (r.rating < 1 || r.rating > 10) return null;
    rating = r.rating;
  }

  const watchStatus =
    typeof r.watchStatus === "string" && r.watchStatus ? r.watchStatus.slice(0, 32).toUpperCase() : null;
  const feedback = typeof r.feedback === "string" && r.feedback ? r.feedback.slice(0, 2000) : null;

  return { mediaType, tmdbId: r.tmdbId, watchStatus, rating, feedback, updatedAt: r.updatedAt };
}

// ── Row → wire ──────────────────────────────────────────────────────────────

interface WatchHistoryRow {
  id: string;
  media_type: string;
  tmdb_id: number;
  tvdb_id: number | null;
  show_tmdb_id: number | null;
  season_number: number | null;
  episode_number: number | null;
  watched_at: number;
  source: string;
  progress_pct: number;
  device_id: string | null;
  deleted_at: number | null;
  updated_at: number;
}

const rowToEvent = (r: WatchHistoryRow): WatchEventPayload => ({
  id: r.id,
  mediaType: r.media_type,
  tmdbId: r.tmdb_id,
  tvdbId: r.tvdb_id,
  showTmdbId: r.show_tmdb_id,
  seasonNumber: r.season_number,
  episodeNumber: r.episode_number,
  watchedAt: r.watched_at,
  source: r.source,
  progressPct: r.progress_pct,
  deviceId: r.device_id,
  deletedAt: r.deleted_at,
  updatedAt: r.updated_at,
});

interface UserRatingRow {
  media_type: string;
  tmdb_id: number;
  watch_status: string | null;
  rating: number | null;
  feedback: string | null;
  updated_at: number;
}

const rowToRating = (r: UserRatingRow): RatingPayload => ({
  mediaType: r.media_type,
  tmdbId: r.tmdb_id,
  watchStatus: r.watch_status,
  rating: r.rating,
  feedback: r.feedback,
  updatedAt: r.updated_at,
});

const EVENT_COLUMNS =
  "id, media_type, tmdb_id, tvdb_id, show_tmdb_id, season_number, episode_number, " +
  "watched_at, source, progress_pct, device_id, deleted_at, updated_at";

// ── POST /api/history/sync ──────────────────────────────────────────────────

/**
 * Push this device's queued events and ratings, and pull back everything the account
 * changed elsewhere since the caller's cursor. One request, one round trip, because
 * the client calls it on a WorkManager tick and a two-call handshake would double the
 * chargeable requests for no extra information.
 *
 * ## `updated_at`, not `watched_at`, is the sync clock
 *
 * The delta is "rows whose server-side `updated_at` is newer than your cursor". It
 * cannot be `watched_at`: back-dating a watch you forgot to log is an ordinary thing
 * to do, and a `watched_at` cursor would place that row in the past and never hand it
 * to any other device. The cursor returned is the server's clock at the moment the
 * reads ran, so a device's own writes in this same call are already behind it.
 *
 * ## Last-write-wins, with one asymmetry
 *
 * Both upserts take the newer `updated_at`, so two devices editing offline converge
 * with no merge prompt. Progress is the exception — it takes `MAX(existing, incoming)`
 * — because progress only ever moves forward in the user's experience of it. Syncing a
 * stale 40% over a later 100% would mark a finished film unfinished, which reads as
 * data loss even though the row is intact.
 */
export async function handleHistorySync(req: Request, env: HistoryEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ error: "invalid_payload" }, 400);

  const rawEvents = Array.isArray(body.events) ? body.events : [];
  const rawRatings = Array.isArray(body.ratings) ? body.ratings : [];
  if (rawEvents.length > MAX_EVENTS_PER_SYNC || rawRatings.length > MAX_RATINGS_PER_SYNC) {
    return json({ error: "too_many_items", maxEvents: MAX_EVENTS_PER_SYNC, maxRatings: MAX_RATINGS_PER_SYNC }, 413);
  }

  const since = isFiniteInt(body.lastSyncTimestamp) && body.lastSyncTimestamp > 0 ? body.lastSyncTimestamp : 0;
  const deviceId = typeof body.deviceId === "string" && body.deviceId ? body.deviceId.slice(0, 64) : "";

  // Malformed entries are DROPPED, not fatal. One bad row out of a hundred must not
  // fail the batch: the client's queue only clears on success, so a permanently
  // unparseable event would wedge the whole sync forever — the same terminal-failure
  // trap the comment-reaction outbox hit.
  const events: WatchEventPayload[] = [];
  for (const raw of rawEvents) {
    const parsed = parseEvent(raw);
    if (parsed) events.push({ ...parsed, deviceId: parsed.deviceId ?? (deviceId || null) });
  }
  const ratings: RatingPayload[] = [];
  for (const raw of rawRatings) {
    const parsed = parseRating(raw);
    if (parsed) ratings.push(parsed);
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  for (const e of events) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO watch_history
           (user_id, id, media_type, tmdb_id, tvdb_id, show_tmdb_id, season_number, episode_number,
            watched_at, source, progress_pct, device_id, deleted_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           progress_pct = MAX(watch_history.progress_pct, excluded.progress_pct),
           tvdb_id      = COALESCE(excluded.tvdb_id, watch_history.tvdb_id),
           source       = excluded.source,
           deleted_at   = excluded.deleted_at,
           updated_at   = excluded.updated_at
         WHERE excluded.updated_at > watch_history.updated_at`,
      ).bind(
        session.userId,
        e.id,
        e.mediaType,
        e.tmdbId,
        e.tvdbId ?? null,
        e.showTmdbId ?? null,
        e.seasonNumber ?? null,
        e.episodeNumber ?? null,
        e.watchedAt,
        e.source ?? "INTERNAL",
        e.progressPct ?? 100,
        e.deviceId ?? null,
        e.deletedAt ?? null,
        now,
        e.updatedAt ?? now,
      ),
    );
  }

  for (const r of ratings) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO user_ratings (user_id, media_type, tmdb_id, watch_status, rating, feedback, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(user_id, media_type, tmdb_id) DO UPDATE SET
           watch_status = excluded.watch_status,
           rating       = excluded.rating,
           feedback     = excluded.feedback,
           updated_at   = excluded.updated_at
         WHERE excluded.updated_at > user_ratings.updated_at`,
      ).bind(session.userId, r.mediaType, r.tmdbId, r.watchStatus ?? null, r.rating ?? null, r.feedback ?? null, r.updatedAt),
    );
  }

  // ⚠️ There is deliberately NO cursor write here.
  //
  // A `sync_cursors` upsert used to run on every pass. Nothing ever read it — the
  // CLIENT holds its own cursor in DataStore and sends it as `lastSyncTimestamp`, and
  // no query in this Worker consulted the table to answer anything. It cost ~2 rows
  // written (row + primary key) on EVERY pass including idle ones, which at a
  // 15-minute cadence is ~192 rows per device per day with nobody watching anything.
  //
  // The table is dropped in migration 0019. If you are tempted to reinstate a
  // server-side cursor, check first that something actually READS it: this one was
  // written faithfully for a fortnight and consumed by nothing.

  if (statements.length > 0) await env.DB.batch(statements);

  // ⚠️ Read the delta AFTER the writes, and take the cursor from before them.
  //
  // `updated_at > since` with `since` = the caller's previous cursor, so anything
  // another device wrote while this one was offline comes back. This device's own
  // writes are filtered out by `device_id` — it already has them, and echoing them
  // would have the client re-insert rows it just sent.
  //
  // COALESCE, not a bare `!=`: `NULL != 'abc'` is NULL, which is falsy, so a row
  // written by a client too old to send a device id would be silently withheld from
  // EVERY device. A row with no device id belongs to nobody and must go to everyone.
  const { results: deltaEventRows } = await env.DB.prepare(
    `SELECT ${EVENT_COLUMNS} FROM watch_history
      WHERE user_id = ? AND updated_at > ? AND COALESCE(device_id, '') != ?
      ORDER BY updated_at ASC LIMIT ?`,
  )
    .bind(session.userId, since, deviceId, MAX_DELTA_EVENTS)
    .all<WatchHistoryRow>();

  const { results: deltaRatingRows } = await env.DB.prepare(
    `SELECT media_type, tmdb_id, watch_status, rating, feedback, updated_at FROM user_ratings
      WHERE user_id = ? AND updated_at > ?
      ORDER BY updated_at ASC LIMIT ?`,
  )
    .bind(session.userId, since, MAX_DELTA_RATINGS)
    .all<UserRatingRow>();

  // Anything that changed invalidates the derived totals. Deleting the key rather
  // than recomputing it: the next reader pays for the derivation, and a user who
  // syncs a hundred times without opening the History tab pays nothing.
  //
  // ⚠️ NOT `ctx?.waitUntil(invalidateStats(...))`. Optional chaining short-circuits
  // the WHOLE call expression, arguments included, so with no ctx the invalidation
  // never runs at all — the totals then stay stale for the full five-minute TTL after
  // every watch. Awaiting when there is no ctx is the same shape poll.ts uses for its
  // cache purge, and for the same reason.
  if (events.length > 0) {
    const purge = invalidateStats(env, session.userId);
    if (ctx) ctx.waitUntil(purge);
    else await purge;
  }

  // One data point per event, fire-and-forget. `indexes` carries the account id
  // because Analytics Engine samples per index, so a single very heavy user cannot
  // dominate the platform-wide totals.
  if (env.HISTORY_ANALYTICS && events.length > 0) {
    const write = async () => {
      for (const e of events) {
        // A tombstone is a deletion, not a watch. Counting it would make the global
        // total a count of write operations rather than of things watched.
        if (e.deletedAt != null) continue;
        env.HISTORY_ANALYTICS!.writeDataPoint({
          blobs: [e.mediaType, e.source ?? "INTERNAL"],
          doubles: [e.tmdbId, e.showTmdbId ?? 0, e.progressPct ?? 100],
          indexes: [session.userId],
        });
      }
    };
    if (ctx) ctx.waitUntil(write());
    else await write();
  }

  return json({
    serverEvents: (deltaEventRows ?? []).map(rowToEvent),
    serverRatings: (deltaRatingRows ?? []).map(rowToRating),
    // ⚠️ `now - 1`, not `now`, and the millisecond is load-bearing.
    //
    // The delta is `updated_at > cursor` — strictly greater — and `now` was taken
    // BEFORE the writes and reads above. Any row stamped at exactly `now` (another
    // device syncing concurrently, or this request's own tombstone) is therefore not
    // greater than `now`, so handing `now` back would put that row permanently on the
    // wrong side of the cursor: it would never appear in any future delta either, and
    // the event would be invisible to this device forever with nothing logged.
    //
    // Backing off one millisecond re-delivers the boundary at worst. That asymmetry is
    // the entire argument: a re-delivered row is an idempotent upsert on the same
    // primary key and costs nothing, and a dropped row is silent data loss.
    syncTimestamp: now - 1,
    conflicts: [],
    // Phase 3. Always empty for now — the shape ships ahead of the feature so the
    // first client to talk to this does not need a second parser later.
    pendingPush: [],
  });
}

// ── GET /api/history ────────────────────────────────────────────────────────

/**
 * The account's history, newest first.
 *
 * ## Keyset pagination on `(watched_at, id)`, not on `watched_at` alone
 *
 * The plan specified a single `watched_at` cursor. That silently LOSES rows: marking a
 * whole season watched in Trakt stamps every episode with one identical timestamp, and
 * `watched_at < cursor` steps straight over the rest of the tie the moment a page
 * boundary lands inside it. The user sees a history page that is simply missing
 * episodes, with nothing in any log. The compound cursor costs one extra query
 * parameter and removes the whole failure.
 *
 * Tombstoned rows are excluded here — this is what the user reads, and they deleted
 * them. They are still returned by `/sync`, which is how the deletion propagates.
 */
export async function handleGetHistory(req: Request, env: HistoryEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const params = new URL(req.url).searchParams;

  const cursorRaw = Number(params.get("cursor"));
  const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : Number.MAX_SAFE_INTEGER;
  const cursorId = params.get("cursorId") ?? "￿";

  const limitRaw = Number(params.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_PAGE) : DEFAULT_PAGE;

  const typeRaw = (params.get("type") ?? "").toUpperCase();
  const type = MEDIA_TYPES.has(typeRaw) ? typeRaw : null;

  const { results } = await env.DB.prepare(
    `SELECT ${EVENT_COLUMNS} FROM watch_history
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND (watched_at < ? OR (watched_at = ? AND id < ?))
        AND (? IS NULL OR media_type = ?)
      ORDER BY watched_at DESC, id DESC
      LIMIT ?`,
  )
    .bind(session.userId, cursor, cursor, cursorId, type, type, limit)
    .all<WatchHistoryRow>();

  const rows = results ?? [];
  // A next cursor only when the page was full. Handing one back on a short page would
  // have the client make a guaranteed-empty extra request at the end of every list.
  const last = rows.length === limit ? rows[rows.length - 1] : null;

  return json({
    events: rows.map(rowToEvent),
    nextCursor: last ? last.watched_at : null,
    nextCursorId: last ? last.id : null,
  });
}

// ── GET /api/history/stats ──────────────────────────────────────────────────

export interface HistoryStats {
  totalMovies: number;
  totalEpisodes: number;
  shows: Array<{ showTmdbId: number; episodesWatched: number; lastWatchedAt: number }>;
  computedAt: number;
}

/**
 * Derive the totals from `watch_history`. Three GROUP BY / COUNT queries against the
 * per-user indexes, never a counter table — see the module header.
 *
 * Exported so the tests can assert the derivation directly rather than through the
 * cache, which would otherwise hide a wrong query behind a warm KV entry.
 */
export async function deriveStats(env: HistoryEnv, userId: string): Promise<HistoryStats> {
  // DISTINCT tmdb_id: rewatching a film is one film watched, not two. Episodes are
  // COUNT(*) for the opposite reason — the number the user recognises there is "how
  // many episodes did I watch", and a rewatched episode is another episode watched.
  const movies = await env.DB.prepare(
    `SELECT COUNT(DISTINCT tmdb_id) AS n FROM watch_history
      WHERE user_id = ? AND media_type = 'MOVIE' AND progress_pct >= ? AND deleted_at IS NULL`,
  )
    .bind(userId, WATCHED_THRESHOLD_PCT)
    .first<{ n: number }>();

  const episodes = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM watch_history
      WHERE user_id = ? AND media_type = 'SHOW' AND progress_pct >= ? AND deleted_at IS NULL`,
  )
    .bind(userId, WATCHED_THRESHOLD_PCT)
    .first<{ n: number }>();

  // Per-show progress. DISTINCT on the season:episode pair, because "how far through
  // am I" must not advance when the user rewatches an episode they have already seen.
  const { results: showRows } = await env.DB.prepare(
    `SELECT show_tmdb_id,
            COUNT(DISTINCT season_number || ':' || episode_number) AS episodes_watched,
            MAX(watched_at) AS last_watched_at
       FROM watch_history
      WHERE user_id = ? AND show_tmdb_id IS NOT NULL AND progress_pct >= ? AND deleted_at IS NULL
      GROUP BY show_tmdb_id`,
  )
    .bind(userId, WATCHED_THRESHOLD_PCT)
    .all<{ show_tmdb_id: number; episodes_watched: number; last_watched_at: number }>();

  return {
    totalMovies: movies?.n ?? 0,
    totalEpisodes: episodes?.n ?? 0,
    shows: (showRows ?? []).map((r) => ({
      showTmdbId: r.show_tmdb_id,
      episodesWatched: r.episodes_watched,
      lastWatchedAt: r.last_watched_at,
    })),
    computedAt: Date.now(),
  };
}

export async function handleGetHistoryStats(req: Request, env: HistoryEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const key = statsKey(session.userId);
  if (env.HISTORY_STATS_KV) {
    const cached = await env.HISTORY_STATS_KV.get(key, "json").catch(() => null);
    if (cached) return json(cached);
  }

  const stats = await deriveStats(env, session.userId);

  if (env.HISTORY_STATS_KV) {
    const put = env.HISTORY_STATS_KV.put(key, JSON.stringify(stats), { expirationTtl: STATS_TTL_SECONDS });
    // Never delay the response to store its own cache entry.
    if (ctx) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return json(stats);
}

/** Drop a user's derived-stats blob. Called by every path that can change a total. */
export async function invalidateStats(env: HistoryEnv, userId: string): Promise<void> {
  if (!env.HISTORY_STATS_KV) return;
  await env.HISTORY_STATS_KV.delete(statsKey(userId)).catch(() => {});
}

// ── DELETE /api/history/{id} ────────────────────────────────────────────────

/**
 * Soft-delete one watch event.
 *
 * A tombstone rather than a `DELETE`, because the deletion has to reach the user's
 * other devices: a row that had simply vanished is indistinguishable from one that
 * never synced, so the offline device would keep it forever — and, worse, push it
 * back on its next sync. The tombstone is swept for real in Phase 4, after every
 * device has had time to see it.
 *
 * `UPDATE … WHERE user_id = ?` is the whole authorization check: the key is
 * `(user_id, id)`, so a request naming somebody else's event id changes zero rows and
 * answers 404 — the same answer an id that does not exist gets, which is deliberate.
 * Distinguishing them would turn this into a probe for which events exist.
 */
export async function handleDeleteHistory(
  id: string,
  req: Request,
  env: HistoryEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE watch_history SET deleted_at = ?, updated_at = ?
      WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
  )
    .bind(now, now, session.userId, id)
    .run();

  if (!res.meta?.changes) return json({ error: "not_found" }, 404);

  await invalidateStats(env, session.userId);
  return json({ ok: true, deletedAt: now });
}

// ── GET /api/stats/global ───────────────────────────────────────────────────

interface GlobalStats {
  totalWatches: number;
  movies: number;
  episodes: number;
  bySource: Array<{ source: string; n: number }>;
  windowDays: number;
  computedAt: number;
}

/**
 * Platform-wide watch numbers, from Analytics Engine rather than from D1.
 *
 * ## Why not `SELECT COUNT(*) FROM watch_history`
 *
 * Because that is an unbounded full scan of the hottest table in the database, run on
 * a PUBLIC unauthenticated endpoint — a free denial-of-service against the whole app's
 * write path. Analytics Engine is a separate, sampled, column-oriented store built for
 * exactly this shape of question, and querying it cannot touch D1 at all.
 *
 * `SUM(_sample_interval)` rather than `COUNT()`: Analytics Engine samples under load
 * and `_sample_interval` is the weight each surviving row stands for, so summing it
 * estimates the true total. Counting rows would silently under-report by the sampling
 * ratio the moment write volume rose — a number that looks fine and is wrong.
 *
 * Reading a dataset is an ACCOUNT-level HTTP call with its own credential; the
 * `HISTORY_ANALYTICS` binding only writes. With the account id or token missing this
 * answers 503 rather than 500 or a plausible zero, because "not configured" and
 * "nobody has watched anything" must not look the same.
 */
export async function handleGetGlobalStats(req: Request, env: HistoryEnv, ctx?: ExecutionContext): Promise<Response> {
  if (env.HISTORY_STATS_KV) {
    const cached = await env.HISTORY_STATS_KV.get(GLOBAL_STATS_KEY, "json").catch(() => null);
    if (cached) return json(cached, 200, { "Cache-Control": `public, max-age=${GLOBAL_STATS_TTL_SECONDS}` });
  }

  if (!env.CF_ACCOUNT_ID || !env.ANALYTICS_API_TOKEN) {
    return json({ error: "not_configured" }, 503);
  }

  const stats = await queryGlobalStats(env).catch((e) => {
    console.error("history: global stats query failed", e);
    return null;
  });
  // Upstream failure is a 503, never a cached zero: a zero written to KV would then be
  // served confidently for an hour after the upstream recovered.
  if (!stats) return json({ error: "upstream_unavailable" }, 503);

  if (env.HISTORY_STATS_KV) {
    const put = env.HISTORY_STATS_KV.put(GLOBAL_STATS_KEY, JSON.stringify(stats), {
      expirationTtl: GLOBAL_STATS_TTL_SECONDS,
    });
    if (ctx) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return json(stats, 200, { "Cache-Control": `public, max-age=${GLOBAL_STATS_TTL_SECONDS}` });
}

const GLOBAL_WINDOW_DAYS = 30;

async function queryGlobalStats(env: HistoryEnv): Promise<GlobalStats | null> {
  // `history_events` is the DATASET name from wrangler.toml, not the binding name.
  // blob1 = media type, blob2 = source (see the writeDataPoint call in the sync path).
  const sql = `SELECT blob1 AS media_type, blob2 AS source, SUM(_sample_interval) AS n
               FROM history_events
               WHERE timestamp > NOW() - INTERVAL '${GLOBAL_WINDOW_DAYS}' DAY
               GROUP BY media_type, source`;

  const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`, "Content-Type": "text/plain" },
    body: sql,
  });
  if (!resp.ok) return null;

  const body = (await resp.json().catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
  if (!body?.data) return null;

  let movies = 0;
  let episodes = 0;
  const bySource = new Map<string, number>();
  for (const row of body.data) {
    // The SQL API returns aggregates as strings, not numbers.
    const n = Number(row.n) || 0;
    if (row.media_type === "MOVIE") movies += n;
    else if (row.media_type === "SHOW") episodes += n;
    const source = typeof row.source === "string" ? row.source : "UNKNOWN";
    bySource.set(source, (bySource.get(source) ?? 0) + n);
  }

  return {
    totalWatches: movies + episodes,
    movies,
    episodes,
    bySource: [...bySource.entries()].map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n),
    windowDays: GLOBAL_WINDOW_DAYS,
    computedAt: Date.now(),
  };
}
