// ── Activity feed (Phase 6) ─────────────────────────────────────────────────
// Watch activity and achievements move off the E2EE relay and into D1. Opinions
// and comments stay end-to-end encrypted — those are the genuine private
// communication; a "so-and-so watched Dune" event is not.
//
// **Fan-out on READ.** Each author's events are stored once and a feed request
// asks for recent events from that reader's accepted friends. The alternative —
// writing a copy into every friend's feed — multiplies each event by friend count
// against the free plan's 100k writes/day, while reads have a 5M/day budget. With
// friend counts in the tens there is no reason to pay that.
//
// Two properties fall out of scoping the query to *accepted friendships*:
// blocking needs no separate check (handleBlock deletes the row, so a blocked
// author simply stops matching), and neither does visibility.

import { loadFriendships } from "./friends";
import { loadFriendCommentEvents } from "./comments";
import { resolveSession } from "./auth";

export interface FeedEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-Revoke-Session",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const MAX_PUBLISH_BATCH = 200;
const MAX_PAYLOAD_CHARS = 2048;
const MAX_ID = 64;
/** Retention. Unbounded growth is the classic version of this table going wrong. */
const MAX_EVENTS_PER_AUTHOR = 100;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
/** A reader with more friends than this pages rather than widening the IN clause. */
const MAX_AUTHORS_PER_QUERY = 200;
/**
 * Hard floor on how far back any feed read reaches. The client renders a 30-day
 * window, so a cold first fetch has no reason to be bounded by retention instead.
 */
export const FEED_FLOOR_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Publishable kinds. `comment` is deliberately NOT here: comments reach the feed
 * by being read out of `comments`, and accepting a client-published `comment`
 * event would duplicate every one of them.
 */
const KINDS = new Set(["watch", "achievement", "personality"]);

export interface FeedEventRow {
  id: string;
  author_id: string;
  kind: string;
  tmdb_id: number | null;
  media_type: string | null;
  payload: string | null;
  created_at: number;
}

const toWire = (r: FeedEventRow) => ({
  id: r.id,
  userId: r.author_id,
  kind: r.kind,
  tmdbId: r.tmdb_id ?? 0,
  mediaType: r.media_type ?? "",
  payload: r.payload ?? "",
  createdAt: r.created_at,
});

/**
 * Recent events from [userId]'s accepted friends, newest first.
 *
 * Exported so `/api/me/bootstrap` and `/api/sync` can carry the first page — the
 * Worker request cap binds far tighter than rows, so app-open should cost one
 * request, not two.
 *
 * **[since] is what keeps D1 from binding.** Ordering across an `IN` list forces the
 * engine to gather every matching row before sorting, and D1 bills rows *scanned*: a
 * reader with 10 friends at the per-author retention cap scans ~1,000 rows to return
 * 50. With `created_at > ?` a no-op refresh — the overwhelmingly common case — scans
 * ~0 rows here, leaving only the session row plus one per friendship.
 *
 * [FEED_FLOOR_MS] bounds a cold first fetch by the window the client actually
 * renders rather than by whatever retention happens to be.
 *
 * @param since newest event the caller already holds; 0/undefined means "cold".
 */
export async function loadFeed(env: FeedEnv, userId: string, limit: number, before?: number, since?: number) {
  const { accepted } = await loadFriendships(env as any, userId);
  // Friends ONLY. The client renders this as a friends feed and drops anything it
  // cannot attribute to a friend row, so returning the caller's own events wastes
  // the page: a heavy user's 100 events would fill the limit and crowd out every
  // friend they have.
  const authors = accepted.slice(0, MAX_AUTHORS_PER_QUERY);
  if (authors.length === 0) return [];
  const placeholders = authors.map(() => "?").join(",");
  const cutoff = before && Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;
  const floor = Date.now() - FEED_FLOOR_MS;
  const from = Math.max(since && Number.isFinite(since) ? since : 0, floor);

  const { results } = await env.DB.prepare(
    `SELECT id, author_id, kind, tmdb_id, media_type, payload, created_at
       FROM feed_events
      WHERE author_id IN (${placeholders}) AND created_at < ? AND created_at > ?
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(...authors, cutoff, from, limit)
    .all<FeedEventRow>();

  // Comments are merged in on READ rather than written here as `feed_events`
  // rows. Same reasoning that made this whole table fan-out-on-read: reads have a
  // 5M/day budget against 100k writes, and this is a second indexed query inside
  // a request that is already happening, not a second chargeable request.
  //
  // Both queries take the same `limit`, so the merge can always fill a page even
  // when one source dominates the window; the slice below trims the surplus.
  const comments = await loadFriendCommentEvents(env, authors, limit, cutoff, from);
  return [...(results ?? []).map(toWire), ...comments]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * Insert this user's own events and prune them back to [MAX_EVENTS_PER_AUTHOR].
 *
 * Split out of [handlePublishFeed] so `/api/sync` can fold a publish into the same
 * request as the read. Returns how many rows were offered (ids are client-supplied
 * and stable, so a retry is a no-op rather than a duplicate).
 */
export async function publishEvents(env: FeedEnv, userId: string, events: unknown[]): Promise<number> {
  const now = Date.now();
  const rows = events
    .slice(0, MAX_PUBLISH_BATCH)
    .map((e) => e as Record<string, unknown>)
    .filter((e) => typeof e.id === "string" && e.id.length > 0 && e.id.length <= MAX_ID)
    .filter((e) => typeof e.kind === "string" && KINDS.has(e.kind))
    .map((e) => ({
      id: e.id as string,
      kind: e.kind as string,
      tmdbId: typeof e.tmdbId === "number" ? e.tmdbId : null,
      mediaType: typeof e.mediaType === "string" ? e.mediaType.slice(0, 16) : null,
      payload: typeof e.payload === "string" ? e.payload.slice(0, MAX_PAYLOAD_CHARS) : null,
      // Never trust a client clock to order other people's feeds: a future
      // timestamp would pin an event to the top of every friend's feed forever.
      createdAt: typeof e.createdAt === "number" && e.createdAt > 0 ? Math.min(e.createdAt, now) : now,
    }));

  if (rows.length === 0) return 0;

  const statements = rows.map((r) =>
    env.DB
      .prepare(
        `INSERT INTO feed_events (id, author_id, kind, tmdb_id, media_type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(r.id, userId, r.kind, r.tmdbId, r.mediaType, r.payload, r.createdAt),
  );

  // Retention, on the write path — this account is at its cron limit, so nothing
  // else will ever come along and tidy up.
  statements.push(
    env.DB
      .prepare(
        `DELETE FROM feed_events
          WHERE author_id = ?
            AND id NOT IN (
              SELECT id FROM feed_events WHERE author_id = ? ORDER BY created_at DESC LIMIT ?
            )`,
      )
      .bind(userId, userId, MAX_EVENTS_PER_AUTHOR),
  );

  await env.DB.batch(statements);
  return rows.length;
}

/** GET /api/feed?limit=&before=&since= — the reader's friends' recent activity. */
export async function handleGetFeed(req: Request, env: FeedEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || DEFAULT_PAGE, 1), MAX_PAGE);
  const before = Number(url.searchParams.get("before")) || undefined;
  const since = Number(url.searchParams.get("since")) || undefined;
  const events = await loadFeed(env, session.userId, limit, before, since);
  return json({ events });
}

/**
 * POST /api/me/feed — publish this user's own events.
 *
 * Body `{ events: [{ id, kind, tmdbId?, mediaType?, payload?, createdAt }] }`.
 * Ids are client-supplied and stable so a retry cannot duplicate a row, which
 * matters because publishing is best-effort and retried on the next sync.
 *
 * Prunes the author back to the newest [MAX_EVENTS_PER_AUTHOR] in the same batch:
 * retention has to happen on the write path, since there is no cron budget here.
 */
export async function handlePublishFeed(req: Request, env: FeedEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  let body: { events?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!Array.isArray(body.events)) return json({ error: "invalid_payload" }, 400);

  return json({ written: await publishEvents(env, session.userId, body.events) });
}

/** DELETE /api/me/feed — drop everything this user has published. */
export async function handleClearFeed(req: Request, env: FeedEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  await env.DB.prepare("DELETE FROM feed_events WHERE author_id = ?").bind(session.userId).run();
  return new Response(null, { status: 204, headers: CORS });
}
