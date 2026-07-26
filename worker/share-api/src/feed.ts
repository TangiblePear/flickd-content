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
 * Exported so `/api/me/bootstrap` can carry the first page — the Worker request
 * cap binds far tighter than rows, so app-open should cost one request, not two.
 */
export async function loadFeed(env: FeedEnv, userId: string, limit: number, before?: number) {
  const { accepted } = await loadFriendships(env as any, userId);
  // Your own events are deliberately included: the feed reads as "what my circle
  // has been watching", and omitting yourself makes a solo user's feed empty.
  const authors = [userId, ...accepted].slice(0, MAX_AUTHORS_PER_QUERY);
  const placeholders = authors.map(() => "?").join(",");
  const cutoff = before && Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;

  const { results } = await env.DB.prepare(
    `SELECT id, author_id, kind, tmdb_id, media_type, payload, created_at
       FROM feed_events
      WHERE author_id IN (${placeholders}) AND created_at < ?
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(...authors, cutoff, limit)
    .all<FeedEventRow>();

  return (results ?? []).map(toWire);
}

/** GET /api/feed?limit=&before= — the reader's friends' recent activity. */
export async function handleGetFeed(req: Request, env: FeedEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || DEFAULT_PAGE, 1), MAX_PAGE);
  const before = Number(url.searchParams.get("before")) || undefined;
  const events = await loadFeed(env, session.userId, limit, before);
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

  const now = Date.now();
  const rows = body.events
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

  if (rows.length === 0) return json({ written: 0 });

  const statements = rows.map((r) =>
    env.DB
      .prepare(
        `INSERT INTO feed_events (id, author_id, kind, tmdb_id, media_type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(r.id, session.userId, r.kind, r.tmdbId, r.mediaType, r.payload, r.createdAt),
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
      .bind(session.userId, session.userId, MAX_EVENTS_PER_AUTHOR),
  );

  await env.DB.batch(statements);
  return json({ written: rows.length });
}

/** DELETE /api/me/feed — drop everything this user has published. */
export async function handleClearFeed(req: Request, env: FeedEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  await env.DB.prepare("DELETE FROM feed_events WHERE author_id = ?").bind(session.userId).run();
  return new Response(null, { status: 204, headers: CORS });
}
