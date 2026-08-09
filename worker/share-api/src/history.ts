/**
 * Server-side watch history: one gzipped R2 document per user, one D1 pointer row.
 *
 * ## Why not rows
 *
 * This app imports whole back-catalogues at signup, so users arrive with 10–30k events
 * rather than a few hundred a year. Measured on real data: per-event D1 rows cost **362
 * bytes each** — 725 GB at 100k users, against a 10 GB database ceiling Cloudflare states
 * cannot be raised. The same events packed per-title and gzipped cost **6.1 bytes**: 12 GB,
 * no ceiling, and an import that is literally one write. See `historyDoc.ts`.
 *
 * ## Everything here is ADDITIVE to a device that works without it
 *
 * The app is account-free by design. This is a sync layer bolted to the side of Room, and
 * the client gates every call on holding a session. Nothing here is ever the primary copy,
 * and nothing can make a client delete local data it did not itself delete — the one
 * exception being a tombstone, which is a deletion the same user made on another device.
 *
 * ## An idle sync writes NOTHING
 *
 * A device with an empty outbox and a current version costs one indexed D1 read and no
 * writes at all. The previous design wrote a cursor row on every pass — ~192 rows/device/
 * day for data nothing read, which alone capped the free tier at ~500 users.
 *
 * ## No third-party tokens live here
 *
 * Trakt/SIMKL OAuth stays on the device; Phase 3 has the server say WHAT needs pushing and
 * the device do it. `pendingPush` is on the response shape already so the first shipped
 * client never needs a second parser.
 */

import { resolveSession } from "./auth";
import { claimPushes, connectedTargets, queuePushes, queueRemoval, type PendingPush } from "./integrations";
import {
  applyToDoc,
  emptyDoc,
  parseDoc,
  parseEventId,
  recentEvents,
  serialiseDoc,
  statsFor,
  type HistoryDoc,
  type IncomingEvent,
  type IncomingRating,
  type PackedTitle,
  dailyActivity,
} from "./historyDoc";
import { notifyHistoryWrite, type NotifyEnv } from "./notify";
import { maybeRollup, recordTelemetry } from "./telemetry";

// Re-exported: it lives with the document model now (the merge needs it to recover a
// tombstone's real identity), but callers and tests still reach for it here.
export { parseEventId };

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
  /** The history documents live here. Without it the feature cannot work at all. */
  BUCKET: R2Bucket;
  /** Derived-stats cache. Optional — absent simply means "always derive". */
  HISTORY_STATS_KV?: KVNamespace;
  /** One data point per TITLE per sync (never per event — see writeAnalytics). */
  HISTORY_ANALYTICS?: { writeDataPoint(event: AnalyticsDataPoint): void };
  CF_ACCOUNT_ID?: string;
  ANALYTICS_API_TOKEN?: string;
  /**
   * Directed push, for waking the account's other devices after a write. Optional —
   * absent means no wake, and the periodic pull still covers it.
   */
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_EMAIL?: string;
  FCM_PRIVATE_KEY?: string;
}

/**
 * Injected so tests can assert that a write wakes and an idle pass does not, without a
 * network call. Production always takes the default.
 */
export type HistoryNotifier = (env: NotifyEnv, userId: string, srcDeviceId: string) => Promise<void>;

interface AnalyticsDataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

// ── Keys ────────────────────────────────────────────────────────────────────

/** PRIVATE. Never served to anyone but the owner. */
export const historyKey = (userId: string) => `history/${userId}.json`;

/**
 * PUBLIC, and deliberately a different object.
 *
 * Serving the private document to the web profile would expose a user's entire viewing
 * history to anyone with the URL. This holds only a recent slice and headline totals —
 * the same reasoning as the `public_layout`/`public_stats` split in migration 0017, which
 * exists because one blob cannot honestly serve two audiences.
 */
export const publicRecentKey = (userId: string) => `profile/${userId}/recent.json`;

// ── Limits ──────────────────────────────────────────────────────────────────

/**
 * Events accepted in one sync call.
 *
 * Far larger than the old per-row design allowed, because the cost of a batch is no longer
 * proportional to its size: the whole document is one R2 write whether it carries 1 event
 * or 5,000. The cap now exists only to bound Worker CPU and request size.
 */
const MAX_EVENTS_PER_SYNC = 5000;
const MAX_RATINGS_PER_SYNC = 2000;

/** Events in the public recent slice, and the default page of `GET /api/history`. */
const RECENT_LIMIT = 200;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;

/** A watch counts toward totals at this much progress. Below it, it is an abandon. */
const WATCHED_THRESHOLD_PCT = 80;

const STATS_TTL_SECONDS = 300;
const GLOBAL_STATS_TTL_SECONDS = 3600;

const statsKey = (userId: string) => `history:stats:${userId}`;
const GLOBAL_STATS_KEY = "history:stats:global";

/**
 * Attempts at the read-merge-write cycle before giving up.
 *
 * Two devices syncing at once both read the document, both merge, and the second write
 * would silently discard the first's events. The conditional PUT below turns that into a
 * detectable failure; this is how many times we redo the merge against the newer document.
 * Exhausting it returns 409 so the CLIENT keeps its outbox and retries — never a 200 with
 * the events dropped.
 */
const MAX_CAS_ATTEMPTS = 4;

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
// Validated rather than trusted: the client is not the only thing that can reach an
// authenticated endpoint, and a `watchedAt` of NaN or a 4 MB id would be packed into the
// document happily and only surface later as a broken history page.

const isFiniteInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Null for anything malformed, so a bad event is dropped rather than half-applied. */
export function parseEvent(raw: unknown): WatchEventPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;

  if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > 200) return null;

  const mediaType = typeof e.mediaType === "string" ? e.mediaType.toUpperCase() : "";
  if (!MEDIA_TYPES.has(mediaType)) return null;

  if (!isFiniteInt(e.tmdbId) || e.tmdbId <= 0) return null;
  if (!isFiniteInt(e.watchedAt) || e.watchedAt <= 0) return null;

  const season = e.seasonNumber == null ? null : isFiniteInt(e.seasonNumber) ? e.seasonNumber : NaN;
  const episode = e.episodeNumber == null ? null : isFiniteInt(e.episodeNumber) ? e.episodeNumber : NaN;
  if (Number.isNaN(season) || Number.isNaN(episode)) return null;

  const tvdbId = e.tvdbId == null ? null : isFiniteInt(e.tvdbId) ? e.tvdbId : null;
  const showTmdbId =
    mediaType === "SHOW" ? (isFiniteInt(e.showTmdbId) && e.showTmdbId > 0 ? e.showTmdbId : e.tmdbId) : null;

  // Clamped, not rejected: a percentage outside 0–100 is a client rounding bug, and
  // discarding the user's watch over it is a worse answer than storing the nearest legal value.
  const progressRaw = isFiniteInt(e.progressPct) ? e.progressPct : 100;
  const progressPct = Math.max(0, Math.min(100, progressRaw));

  const source = typeof e.source === "string" && e.source ? e.source.slice(0, 32).toUpperCase() : "INTERNAL";
  const deviceId = typeof e.deviceId === "string" && e.deviceId ? e.deviceId.slice(0, 64) : null;
  const deletedAt = isFiniteInt(e.deletedAt) && e.deletedAt > 0 ? e.deletedAt : null;
  const updatedAt = isFiniteInt(e.updatedAt) && e.updatedAt > 0 ? e.updatedAt : Date.now();

  return {
    id: e.id, mediaType, tmdbId: e.tmdbId, tvdbId, showTmdbId,
    seasonNumber: season, episodeNumber: episode, watchedAt: e.watchedAt,
    source, progressPct, deviceId, deletedAt, updatedAt,
  };
}

export function parseRating(raw: unknown): RatingPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const mediaType = typeof r.mediaType === "string" ? r.mediaType.toUpperCase() : "";
  if (!MEDIA_TYPES.has(mediaType)) return null;
  if (!isFiniteInt(r.tmdbId) || r.tmdbId <= 0) return null;
  if (!isFiniteInt(r.updatedAt) || r.updatedAt <= 0) return null;

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

const toIncomingEvent = (e: WatchEventPayload): IncomingEvent => ({
  id: e.id,
  mediaType: e.mediaType,
  tmdbId: e.tmdbId,
  seasonNumber: e.seasonNumber,
  episodeNumber: e.episodeNumber,
  watchedAt: e.watchedAt,
  source: e.source,
  progressPct: e.progressPct,
  tvdbId: e.tvdbId,
  deletedAt: e.deletedAt,
});

const toIncomingRating = (r: RatingPayload): IncomingRating => ({
  mediaType: r.mediaType,
  tmdbId: r.tmdbId,
  rating: r.rating,
  watchStatus: r.watchStatus,
  feedback: r.feedback,
  updatedAt: r.updatedAt,
});

// ── The pointer row ─────────────────────────────────────────────────────────

interface MetaRow {
  version: number;
  event_count: number;
  title_count: number;
  last_watched_at: number | null;
}

async function readMeta(env: HistoryEnv, userId: string): Promise<MetaRow | null> {
  return env.DB.prepare(
    "SELECT version, event_count, title_count, last_watched_at FROM history_meta WHERE user_id = ?",
  )
    .bind(userId)
    .first<MetaRow>();
}

// ── Reading and writing the document ────────────────────────────────────────

interface LoadedDoc {
  doc: HistoryDoc;
  /** Null when the object does not exist yet — the create case for the conditional PUT. */
  etag: string | null;
}

async function loadDoc(env: HistoryEnv, userId: string): Promise<LoadedDoc> {
  const obj = await env.BUCKET.get(historyKey(userId));
  if (!obj) return { doc: emptyDoc(), etag: null };
  return { doc: await parseDoc(await obj.arrayBuffer()), etag: obj.etag };
}

/**
 * Merge and store, retrying against a newer document if another device won the race.
 *
 * ## The conditional PUT is what makes concurrent devices safe
 *
 * Two devices syncing simultaneously both read the document, both merge their own events
 * into their own copy, and whichever writes second would overwrite the first's work — the
 * first client having already been told 200 and cleared its outbox. That is silent,
 * permanent data loss, and it is the single most dangerous property of a
 * read-modify-write store.
 *
 * `onlyIf.etagMatches` turns it into a detectable collision: the losing write fails, and
 * we redo the merge against what actually landed. Because merging is commutative
 * (see `historyDoc.ts`), the retry is guaranteed to converge rather than ping-pong.
 *
 * Returns null when every attempt lost — the caller MUST then answer 409 rather than 200,
 * so the client keeps its outbox.
 */
async function mergeAndStore(
  env: HistoryEnv,
  userId: string,
  events: IncomingEvent[],
  ratings: IncomingRating[],
  now: number,
): Promise<HistoryDoc | null> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const { doc, etag } = await loadDoc(env, userId);
    applyToDoc(doc, events, ratings, now);
    const body = await serialiseDoc(doc);

    const stored = await env.BUCKET.put(historyKey(userId), body, {
      // No etag ⇒ the object must not exist. Without this guard two devices arriving at
      // once on a brand-new account would both take the "create" path and one would lose
      // its entire first upload — which for a fresh sign-in is the whole back-catalogue.
      onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    });

    if (stored) return doc;
  }
  console.error("history: exhausted CAS attempts", userId);
  return null;
}

/**
 * One data point per TITLE per sync, never per event.
 *
 * Analytics Engine includes 10M data points/month; at 2 billion events a per-event write
 * would be ~$497/month. Per title it is ~18x fewer (a 20k import emits ~1,100 points, not
 * 20,000) and stays inside the allowance — while additionally making "most-watched title"
 * answerable, which per-event points did not.
 *
 * ⚠️ Queries must be `SUM(_sample_interval * double1)`, never `COUNT()`. The count lives
 * IN the data point; counting rows would report the number of sync batches instead.
 */
function writeAnalytics(env: HistoryEnv, userId: string, before: HistoryDoc, after: HistoryDoc): void {
  if (!env.HISTORY_ANALYTICS) return;
  const prev = new Map(statsFor(before).perTitle.map((t) => [`${t.mediaType}|${t.tmdbId}`, t.count]));
  for (const t of statsFor(after).perTitle) {
    const delta = t.count - (prev.get(`${t.mediaType}|${t.tmdbId}`) ?? 0);
    if (delta <= 0) continue; // a re-sent batch must not double-count
    env.HISTORY_ANALYTICS.writeDataPoint({
      blobs: [t.mediaType, t.source, String(t.tmdbId)],
      doubles: [delta],
      // Sampling is per index, so one enormous library cannot dominate the fleet totals.
      indexes: [userId],
    });
  }
}

/** Publish the small public slice. Best-effort: never fail a sync over the profile copy. */
async function writePublicRecent(env: HistoryEnv, userId: string, doc: HistoryDoc): Promise<void> {
  try {
    const s = statsFor(doc);
    const body = JSON.stringify({
      recent: recentEvents(doc, RECENT_LIMIT),
      totals: { events: s.eventCount, titles: s.titleCount, lastWatchedAt: s.lastWatchedAt },
      updatedAt: doc.updatedAt,
    });
    await env.BUCKET.put(publicRecentKey(userId), body, {
      httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=300" },
    });
  } catch (e) {
    console.error("history: public recent write failed", e);
  }
}

async function invalidateStats(env: HistoryEnv, userId: string): Promise<void> {
  await env.HISTORY_STATS_KV?.delete(statsKey(userId)).catch(() => {});
}

// ── POST /api/history/sync ──────────────────────────────────────────────────

/**
 * Push this device's queued changes, and learn whether it is behind.
 *
 * The client sends the `version` it last saw. If it has nothing to push and its version
 * matches, this is a pure read: **zero writes, no R2 access at all.**
 */
export async function handleHistorySync(
  req: Request,
  env: HistoryEnv,
  ctx?: ExecutionContext,
  notify: HistoryNotifier = notifyHistoryWrite,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ error: "invalid_payload" }, 400);

  // ── Product telemetry, riding a request that was happening anyway ──────────
  //
  // ⚠️ Placed HERE, before the zero-write early return below, and that is the whole
  // point: the idle path is the overwhelmingly common one, so recording only on the
  // write paths would reproduce the coverage hole this exists to close.
  //
  // Telemetry used to be written ONLY by `/api/sync`, which is reached only by
  // `SocialSyncWorker` — a 24h-periodic job whose one prompt firing is spent on an
  // install's first launch, before the user has signed in. Measured 2026-08-02: 9
  // accounts, 6 telemetry rows, and the 3 missing were the 3 newest. This endpoint is
  // reached on every app open, on an FCM wake, and 6-hourly (it was 15-minutely until the
  // poll was dropped), is scheduled unconditionally, and is not gated on the social
  // subsystem, so coverage stops depending on whether anyone opened Friends.
  //
  // It is also, for that reason, almost always the write that CLAIMS the UTC day — see the
  // second WHERE clause in `recordTelemetry`, without which the rich block that arrives
  // later on `/api/sync` is discarded and the row never gains a model or a build.
  //
  // No new request and no new field: `X-App-Version` is already stamped on every call
  // by the client's OkHttp interceptor, Cloudflare already attaches `cf.country`, and
  // `deviceId` is already in this body. The once-per-UTC-day guard inside
  // `recordTelemetry` means this costs at most one write per device per day.
  //
  // `if (ctx)` rather than `ctx?.waitUntil(...)`: optional chaining short-circuits the
  // ENTIRE call expression including its arguments, so with no `ctx` the promise would
  // never be constructed and the write would silently never happen. Same shape as the
  // `finish()` dispatch further down.
  const recordFleet = async () => {
    await recordTelemetry(env, session.userId, req, {
      deviceId: deviceIdOf(body),
      // Build identity rides this request because this is the request that happens. It
      // does NOT make the row complete — `model` is the marker for that — so the rich
      // block arriving later on `/api/sync` is still let through exactly once.
      //
      // Passed raw: `TelemetryBlock` fields are `unknown` and `recordTelemetry` sanitises
      // and caps every one of them. Sanitising here as well would be a second definition
      // of the same rule, and the second one is what rots.
      versionName: body.versionName,
      buildType: body.buildType,
    }).catch(() => {});
    await maybeRollup(env).catch(() => {});
  };
  if (ctx) ctx.waitUntil(recordFleet());
  else await recordFleet();

  const rawEvents = Array.isArray(body.events) ? body.events : [];
  const rawRatings = Array.isArray(body.ratings) ? body.ratings : [];
  if (rawEvents.length > MAX_EVENTS_PER_SYNC || rawRatings.length > MAX_RATINGS_PER_SYNC) {
    return json({ error: "too_many_items", maxEvents: MAX_EVENTS_PER_SYNC, maxRatings: MAX_RATINGS_PER_SYNC }, 413);
  }

  // Malformed entries are DROPPED, never fatal. The client's outbox clears only on
  // success, so failing a batch over one bad row would wedge that queue permanently.
  const events: IncomingEvent[] = [];
  for (const raw of rawEvents) {
    const parsed = parseEvent(raw);
    if (parsed) events.push(toIncomingEvent(parsed));
  }
  const ratings: IncomingRating[] = [];
  for (const raw of rawRatings) {
    const parsed = parseRating(raw);
    if (parsed) ratings.push(toIncomingRating(parsed));
  }

  const clientVersion = isFiniteInt(body.version) && body.version > 0 ? body.version : 0;
  const meta = await readMeta(env, session.userId);
  const serverVersion = meta?.version ?? 0;

  // ── The zero-write path ──────────────────────────────────────────────────
  // Nothing to push and nothing to learn. One indexed D1 read, no R2, no writes. This is
  // the overwhelmingly common case for an installed app and the reason an idle fleet of
  // 100k devices costs nothing.
  if (events.length === 0 && ratings.length === 0 && clientVersion === serverVersion) {
    // ⚠️ Still claims pending pushes. An account whose OTHER device recorded a watch has
    // work owed to Trakt that this device may be the only one online to perform — so
    // "nothing changed for me" is not the same as "nothing to do". The claim query reads
    // an indexed handful of rows and writes only when it actually takes a job, so the
    // idle case stays free.
    return json({
      version: serverVersion,
      upToDate: true,
      stats: metaStats(meta),
      pendingPush: await claimPushes(env, session.userId, deviceIdOf(body), Date.now()),
      integrations: await connectedTargets(env, session.userId),
    });
  }

  let doc: HistoryDoc;
  let version = serverVersion;

  if (events.length > 0 || ratings.length > 0) {
    const before = (await loadDoc(env, session.userId)).doc;
    const merged = await mergeAndStore(env, session.userId, events, ratings, Date.now());
    // ⚠️ 409, never 200. A 200 here would have the client clear an outbox whose contents
    // were never stored.
    if (!merged) return json({ error: "write_conflict" }, 409);
    doc = merged;
    // ⚠️ From the DOCUMENT, never `serverVersion + 1`.
    //
    // `serverVersion` was read before the merge, so two devices arriving together both
    // read 19 and both label their result 20 — two different states sharing a version.
    // With whole-document pulls that self-heals on the next write; with deltas a client
    // sitting at 20 never receives one of them, permanently and silently. The R2 CAS
    // serialises writers, so the version carried by the document that was actually
    // stored is the only one that cannot collide.
    version = doc.ver ?? serverVersion + 1;

    const s = statsFor(doc);
    await env.DB.prepare(
      `INSERT INTO history_meta (user_id, version, event_count, title_count, last_watched_at, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         version = excluded.version, event_count = excluded.event_count,
         title_count = excluded.title_count, last_watched_at = excluded.last_watched_at,
         updated_at = excluded.updated_at`,
    )
      .bind(session.userId, version, s.eventCount, s.titleCount, s.lastWatchedAt, Date.now())
      .run();

    // Phase 3: queue outward pushes for whatever this account has connected. Costs
    // nothing when nothing is connected — `queuePushes` returns after one indexed read.
    //
    // ⚠️ Deliberately given the events with their SOURCE. An event that came FROM Trakt
    // must never be queued back TO Trakt; see the echo guard in integrations.ts.
    const pushNow = Date.now();
    // Additions: queue outward pushes, excluding anything sourced from the target.
    await queuePushes(
      env,
      session.userId,
      events.filter((e) => e.deletedAt == null).map((e) => ({ id: e.id, source: e.source })),
      pushNow,
    );
    // Removals: same guard, and here it prevents REMOTE data loss rather than a wasted
    // call — a deletion learned from Trakt must never be sent back to Trakt. The client
    // puts that origin in `source` on the tombstone.
    for (const e of events.filter((e) => e.deletedAt != null)) {
      await queueRemoval(env, session.userId, e.id, pushNow, e.source);
    }

    const after = doc;
    const finish = async () => {
      writeAnalytics(env, session.userId, before, after);
      await writePublicRecent(env, session.userId, after);
      await invalidateStats(env, session.userId);
      // Hung off the WRITE, never the request: the idle path is the overwhelmingly
      // common one and must stay free of an OAuth round trip and an FCM publish.
      await notify(env, session.userId, deviceIdOf(body));
    };
    if (ctx) ctx.waitUntil(finish());
    else await finish();
  } else {
    // Nothing to push, but the client is behind — read only.
    doc = (await loadDoc(env, session.userId)).doc;
  }

  // Hand back the whole document when the client is behind. Applying it is idempotent
  // (see historyDoc.ts), so there is no delta to compute and no partial-apply state.
  const behind = clientVersion !== version;
  return json({
    version,
    upToDate: !behind,
    doc: behind ? docFor(doc, clientVersion, version) : undefined,
    // ⚠️ Always the FULL document, never the delta.
    //
    // `ServerHistoryRepository.resyncIfServerLostHistory` reads `stats.events == 0` as
    // "the server lost my history" and re-uploads the device's entire database. Reporting
    // a delta's counts here would fire that on a routine two-title pull.
    stats: docStats(doc),
    pendingPush: await claimPushes(env, session.userId, deviceIdOf(body), Date.now()),
    // ⚠️ Sent on EVERY response, including the idle path, and deliberately so.
    //
    // Registration used to happen only when the user CONNECTED an integration. Anyone
    // already connected when Phase 3 shipped never re-traverses that path — the token was
    // stored months ago — so the server never learned the integration existed and queued
    // zero pushes, silently and forever. Found on a live account with Trakt connected and
    // 2,916 Trakt-sourced events, and `user_integrations` empty.
    //
    // Reporting the server's belief on every pass lets the client reconcile against its
    // own state with no marker to go stale, so it also self-heals if this table is ever
    // lost. One extra indexed read per pass, against 25 billion included per month.
    integrations: await connectedTargets(env, session.userId),
  });
}

/** The reporting device, used only to name a push claim. Absent is fine — see claimPushes. */
const deviceIdOf = (body: Record<string, unknown>): string =>
  typeof body.deviceId === "string" ? body.deviceId.slice(0, 64) : "";

const metaStats = (meta: MetaRow | null) => ({
  events: meta?.event_count ?? 0,
  titles: meta?.title_count ?? 0,
  lastWatchedAt: meta?.last_watched_at ?? 0,
});

/**
 * What to actually send a client that is behind: the whole document, or only the titles
 * it has not seen.
 *
 * The document is a snapshot rather than a log, so this is a FILTER, not a replay — there
 * is no changelog to retain and no window to fall outside. A client at v5 against a server
 * at v50 is answered exactly the same way as one at v49.
 *
 * Falls back to the whole document whenever the question cannot be answered honestly:
 *
 * - `clientVersion === 0` — a first sync or a recovery; it has nothing to build on.
 * - `clientVersion > version` — a restored backup or a rolled-back bucket. Nothing sane
 *   can be computed from a client claiming to be ahead of the server.
 *
 * ⚠️ A title with **no** `mv` is always included. Every title stored before the stamp
 * existed lacks it, and excluding those would answer a behind client with an empty
 * document that it would accept as current — silent loss on exactly the accounts that
 * already have history. They cost a full document until their next write stamps them.
 */
function docFor(doc: HistoryDoc, clientVersion: number, version: number): HistoryDoc {
  if (clientVersion === 0 || clientVersion > version) return doc;

  const titles: Record<string, PackedTitle> = {};
  for (const [key, title] of Object.entries(doc.titles)) {
    if (title.mv === undefined || title.mv > clientVersion) titles[key] = title;
  }
  // Tombstones ship whole. They are how a device learns about a deletion, and the title
  // it belonged to may legitimately not be in the delta at all — or may have been pruned
  // from the document entirely once its last watch went. Capped at MAX_TOMBSTONES.
  return { ...doc, titles };
}

const docStats = (doc: HistoryDoc) => {
  const s = statsFor(doc);
  return { events: s.eventCount, titles: s.titleCount, lastWatchedAt: s.lastWatchedAt };
};

// ── GET /api/history ────────────────────────────────────────────────────────

/**
 * The account's history, newest first.
 *
 * Flattened from the document rather than paged in SQL. The offset cursor is safe here
 * because the whole list is materialised and sorted in one pass from a consistent
 * snapshot — unlike the old keyset over a live table, where rows shifting under the
 * cursor could skip events sharing a timestamp.
 */
export async function handleGetHistory(req: Request, env: HistoryEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const params = new URL(req.url).searchParams;
  const limitRaw = Number(params.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_PAGE) : DEFAULT_PAGE;
  const offsetRaw = Number(params.get("offset"));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
  const typeRaw = (params.get("type") ?? "").toUpperCase();
  const type = MEDIA_TYPES.has(typeRaw) ? typeRaw : null;

  const { doc } = await loadDoc(env, session.userId);
  const all = recentEvents(doc, Number.MAX_SAFE_INTEGER).filter((e) => !type || e.mediaType === type);
  const page = all.slice(offset, offset + limit);

  return json({
    events: page,
    total: all.length,
    nextOffset: offset + page.length < all.length ? offset + page.length : null,
  });
}

// ── GET /api/history/stats ──────────────────────────────────────────────────

export async function handleGetHistoryStats(req: Request, env: HistoryEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const key = statsKey(session.userId);
  if (env.HISTORY_STATS_KV) {
    const cached = await env.HISTORY_STATS_KV.get(key, "json").catch(() => null);
    if (cached) return json(cached);
  }

  // The counters live on the pointer row precisely so the common case never touches R2.
  const meta = await readMeta(env, session.userId);
  const stats = { ...metaStats(meta), version: meta?.version ?? 0, computedAt: Date.now() };

  if (env.HISTORY_STATS_KV) {
    const put = env.HISTORY_STATS_KV.put(key, JSON.stringify(stats), { expirationTtl: STATS_TTL_SECONDS });
    if (ctx) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return json(stats);
}

// ── DELETE /api/history/{id} ────────────────────────────────────────────────

/**
 * Soft-delete one watch event.
 *
 * A tombstone rather than a removal, because the deletion has to REACH the account's other
 * devices: a row that had merely vanished is indistinguishable from one that never synced,
 * and the offline device would push it straight back.
 *
 * The id encodes the title and the watch second, so it is parsed rather than looked up.
 * An id that matches nothing is a no-op that still answers 200 — distinguishing "not
 * yours" from "does not exist" would make this a probe for which events exist.
 */
export async function handleDeleteHistory(
  id: string,
  req: Request,
  env: HistoryEnv,
  ctx?: ExecutionContext,
  notify: HistoryNotifier = notifyHistoryWrite,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const target = parseEventId(id);
  if (!target) return json({ error: "invalid_id" }, 400);

  const now = Date.now();
  const merged = await mergeAndStore(env, session.userId, [{ ...target, deletedAt: now }], [], now);
  if (!merged) return json({ error: "write_conflict" }, 409);

  const s = statsFor(merged);
  const meta = await readMeta(env, session.userId);
  // Same rule as the sync path: the version comes from the document the CAS actually
  // stored, never from a `readMeta` taken around it. Two writers deriving it from meta
  // can label two different states with one version, which a delta client never recovers
  // from. See HistoryDoc.ver.
  const version = merged.ver ?? (meta?.version ?? 0) + 1;
  await env.DB.prepare(
    `INSERT INTO history_meta (user_id, version, event_count, title_count, last_watched_at, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       version = excluded.version, event_count = excluded.event_count,
       title_count = excluded.title_count, last_watched_at = excluded.last_watched_at,
       updated_at = excluded.updated_at`,
  )
    .bind(session.userId, version, s.eventCount, s.titleCount, s.lastWatchedAt, now)
    .run();

  // A deletion must reach Trakt too, or the user removes a watch here and it silently
  // survives on the service they actually look at. `DELETE /api/history/{id}` is always a
  // USER action, so there is no origin to exclude — a deletion observed FROM an
  // integration arrives as a tombstone on the sync path instead, carrying its origin.
  await queueRemoval(env, session.userId, id, now);

  const finish = async () => {
    await writePublicRecent(env, session.userId, merged);
    await invalidateStats(env, session.userId);
    // A removal has to reach the other devices as promptly as an addition; otherwise a
    // watch deleted on one device lingers on the rest for up to a full periodic cycle.
    await notify(env, session.userId, "");
  };
  if (ctx) ctx.waitUntil(finish());
  else await finish();

  return json({ ok: true, deletedAt: now, version });
}


// ── GET /api/stats/global ───────────────────────────────────────────────────

interface GlobalStats {
  totalWatches: number;
  totalTitles: number;
  users: number;
  topTitles: Array<{ mediaType: string; tmdbId: number; n: number }>;
  windowDays: number;
  computedAt: number;
}

/**
 * Platform-wide numbers. Public and unauthenticated by design — one aggregate for
 * everybody, identifying nobody, and therefore edge-cacheable.
 *
 * Two sources, each doing what the other cannot:
 *
 *  - **Exact totals** from `SUM()` over the pointer rows. One small row per user, so this
 *    is ~100k rows read at 100k users against an included 25 BILLION/month — free, and
 *    exact rather than sampled. It is emphatically NOT a scan of anyone's history.
 *  - **Most-watched titles** from Analytics Engine, which is the only thing that can
 *    answer a cross-user question about an opaque document store.
 *
 * A missing Analytics credential degrades to totals-only rather than failing: the headline
 * number is the one users see, and it does not depend on the optional half.
 */
export async function handleGetGlobalStats(req: Request, env: HistoryEnv, ctx?: ExecutionContext): Promise<Response> {
  if (env.HISTORY_STATS_KV) {
    const cached = await env.HISTORY_STATS_KV.get(GLOBAL_STATS_KEY, "json").catch(() => null);
    if (cached) return json(cached, 200, { "Cache-Control": `public, max-age=${GLOBAL_STATS_TTL_SECONDS}` });
  }

  const totals = await env.DB.prepare(
    "SELECT COALESCE(SUM(event_count),0) AS e, COALESCE(SUM(title_count),0) AS t, COUNT(*) AS u FROM history_meta",
  ).first<{ e: number; t: number; u: number }>();

  const stats: GlobalStats = {
    totalWatches: totals?.e ?? 0,
    totalTitles: totals?.t ?? 0,
    users: totals?.u ?? 0,
    topTitles: await queryTopTitles(env).catch(() => []),
    windowDays: GLOBAL_WINDOW_DAYS,
    computedAt: Date.now(),
  };

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

/**
 * Most-watched titles across everyone, from Analytics Engine.
 *
 * `SUM(_sample_interval * double1)`, never `COUNT()`. Analytics Engine samples under load
 * and `_sample_interval` is the weight each surviving row stands for — and `double1` is
 * the number of events that data point represents, since we write one per title per sync
 * rather than one per event. Counting rows would report the number of sync batches.
 */
async function queryTopTitles(env: HistoryEnv): Promise<GlobalStats["topTitles"]> {
  if (!env.CF_ACCOUNT_ID || !env.ANALYTICS_API_TOKEN) return [];
  const sql = `SELECT blob1 AS media_type, blob3 AS tmdb_id,
                      SUM(_sample_interval * double1) AS n
               FROM history_events
               WHERE timestamp > NOW() - INTERVAL '${GLOBAL_WINDOW_DAYS}' DAY
               GROUP BY media_type, tmdb_id
               ORDER BY n DESC
               LIMIT 20`;
  const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`, "Content-Type": "text/plain" },
    body: sql,
  });
  if (!resp.ok) return [];
  const body = (await resp.json().catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
  return (body?.data ?? [])
    .map((r) => ({
      mediaType: typeof r.media_type === "string" ? r.media_type : "",
      tmdbId: Number(r.tmdb_id) || 0,
      n: Number(r.n) || 0,
    }))
    // ⚠️ Drop rows with no title id. The dataset still holds points written by the
    // PER-EVENT scheme this replaced, which carried only two blobs — so `blob3` is null
    // and they collapse into a single phantom "title 0" that outweighs every real one
    // and sits at the top of the list. Observed live immediately after the cutover.
    // They age out of the 30-day window on their own; until then this filters them.
    .filter((t) => t.tmdbId > 0 && t.mediaType !== "");
}

/** Exported for the account-deletion path, which must remove BOTH objects. */
export const historyObjectKeys = (userId: string) => [historyKey(userId), publicRecentKey(userId)];

export { WATCHED_THRESHOLD_PCT, MAX_EVENTS_PER_SYNC, MAX_RATINGS_PER_SYNC };


/** A year is what the heatmap draws; older days would be fetched and thrown away. */
const HEATMAP_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Day-by-day watch counts for [userId], for a profile heatmap.
 *
 * Exported for `profiles.ts`, which cannot reach `loadDoc` and must not read
 * the bucket itself — the document's shape and its versioning belong to this
 * module. Returns `{}` rather than throwing when there is no document.
 *
 * ⚠️ Costs one R2 read. The caller is expected to ask ONLY when the profile it
 * is serving actually publishes the block, so a profile without a heatmap costs
 * nothing.
 */
export async function dailyActivityFor(
  env: HistoryEnv,
  userId: string,
  now: number = Date.now(),
): Promise<Record<string, [number, number]>> {
  try {
    const { doc } = await loadDoc(env, userId);
    return dailyActivity(doc, now - HEATMAP_WINDOW_MS);
  } catch {
    // A heatmap is decoration; a profile must still render without it.
    return {};
  }
}
