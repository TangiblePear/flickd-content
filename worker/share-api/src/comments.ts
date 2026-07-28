// ── Comments, server-side ────────────────────────────────────────────────────
// Flat comments at two levels — title (movie or show) and episode — replacing the
// E2EE `social_opinions` surface.
//
// The forcing argument for moving off E2EE is moderation: `reports.kind` already
// anticipated 'comment', but a report against a comment the server cannot read is
// unactionable, and Play expects UGC moderation to actually work. The promise
// being made is "only your friends can read this", NOT "not even we can" — a
// server-side friendship check delivers the former completely, and D1 is encrypted
// at rest, so a stolen disk is not the exposure E2EE would be defending against.
//
// ── Two read paths, never one query ─────────────────────────────────────────
// Never `WHERE visibility='public' OR author_id IN (<friends>)`. An `IN` list
// beside `ORDER BY … LIMIT` defeats the index ordering — every comment on the
// title is gathered before sorting — and it makes the response per-reader, so it
// can never be cached.
//
//   1. the public list is unauthenticated and identical for every reader, so it
//      edge-caches: a thousand people on a hot episode cost ONE D1 query.
//   2. the friends slice is authenticated and NEVER cached. `caches.default` keys
//      on URL, so caching it would serve one user's friends-only comments to
//      another — the same cross-account leak already hit on the client, where
//      OkHttp keyed on URL and `/api/me/profile` is one URL for every user.
//
// The client merges the two by timestamp. Signed out, only path 1 runs.
//
// ⚠️ **Loading comments ALWAYS costs a Worker request.** D1 is reachable only from
// a Worker, and a Worker on a route always runs — Cloudflare does not serve its
// response from CDN cache without invoking it. `caches.default` saves the D1
// QUERY, not the request. That is why the client must never load comments on
// detail-page open, and why there is no comment count on the detail page.

import { areFriends, isBlockedEitherWay } from "./authz";
import { resolveSession } from "./auth";
import { loadFriendships } from "./friends";

export interface CommentsEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
  /** Per-author hourly cap. Config, not a constant, so it tunes without a deploy. */
  COMMENTS_PER_HOUR?: string;
}

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
const noContent = () => new Response(null, { status: 204, headers: CORS });

const USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Author-minted comment id. Same alphabet as `users.id`; length is the client's business. */
const COMMENT_ID_RE = /^[0-9A-HJKMNP-TV-Z:]{8,80}$/;

export const MAX_BODY = 500;
const MAX_REACTION = 32;
const MAX_MEDIA_URL = 512;
const MAX_MEDIA_ID = 128;
const MAX_LANG = 8;
/**
 * ⚠️ **20, and the number is load-bearing.** Free-plan Workers allow 50
 * subrequests per invocation, and the translation tier spends one AI call per
 * untranslated comment on top of the session, friendship, comment and
 * reaction-count queries. A 50-comment page blows the limit outright. Same cap
 * that already forced `FRESHNESS_CHUNK = 25`.
 */
export const PAGE_LIMIT = 20;
/** Bounds the "N comments in other languages" probe so it can never become a scan. */
const OTHER_LANG_PROBE = 500;
/** The caller's own reactions on one subject. Realistically a handful; this is the belt. */
const MY_REACTIONS_LIMIT = 200;
const DEFAULT_COMMENTS_PER_HOUR = 30;
/** Public list TTL. Also the exact size of the public → friends-only leak window. */
export const PUBLIC_CACHE_SECONDS = 60;

const MEDIA_KINDS = new Set(["gif", "image"]);
const MEDIA_PROVIDERS = new Set(["giphy", "r2"]);

// ── Subject ─────────────────────────────────────────────────────────────────

/**
 * What a comment is attached to. `season`/`episode` are **-1 for title level, never
 * null**: SQLite permits NULL in composite PRIMARY KEY columns, so nullable
 * columns in `comment_counts`' key would not enforce uniqueness and the counter
 * would silently fork into duplicate rows.
 */
export interface Subject {
  tmdbId: number;
  mediaType: "movie" | "show";
  season: number;
  episode: number;
}

/**
 * -1 unless BOTH season and episode are present and non-negative.
 *
 * ⚠️ The absence check is not redundant with the range check. `Number(null)` is
 * **0**, so a missing `episode` parameter parses as episode 0 — which made every
 * title-level read on a movie look like an episode subject and answer 400.
 */
function level(season: unknown, episode: unknown): [number, number] {
  if (season == null || season === "" || episode == null || episode === "") return [-1, -1];
  const s = Number(season);
  const e = Number(episode);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 0) return [-1, -1];
  return [s, e];
}

/**
 * Parse a subject out of `/api/titles/{type}/{tmdbId}/comments…` plus the query
 * string. Returns null for anything malformed — an episode subject on a movie
 * included, since a movie has no episodes and accepting one would fork the
 * counter into a row nothing ever reads.
 */
export function parseSubject(mediaType: string, rawId: string, params: URLSearchParams): Subject | null {
  if (mediaType !== "movie" && mediaType !== "show") return null;
  const tmdbId = Number(rawId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const [season, episode] = level(params.get("season"), params.get("episode"));
  if (season >= 0 && mediaType !== "show") return null;
  return { tmdbId, mediaType, season, episode };
}

// ── Rows and wire shape ─────────────────────────────────────────────────────

export interface CommentRow {
  id: string;
  tmdb_id: number;
  media_type: string;
  season: number;
  episode: number;
  author_id: string;
  body: string;
  reaction: string | null;
  visibility: string;
  spoiler: number;
  lang: string | null;
  media_kind: string | null;
  media_provider: string | null;
  media_id: string | null;
  media_url: string | null;
  media_w: number | null;
  media_h: number | null;
  hidden_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  display_name?: string | null;
  avatar_id?: string | null;
  picture_url?: string | null;
}

/**
 * Everything a comment row needs to be rendered, minus the reader-specific bits
 * (`myReaction`, block filtering) which are deliberately not on the cached path.
 *
 * `edited` rather than exposing `updated_at` on its own: the UI shows a marker,
 * and the raw timestamp invites a client to sort by it and reorder the list.
 */
function toWire(r: CommentRow) {
  return {
    id: r.id,
    authorId: r.author_id,
    authorName: r.display_name ?? null,
    authorAvatarId: r.avatar_id ?? null,
    authorPictureUrl: r.picture_url ?? null,
    body: r.body,
    reaction: r.reaction,
    visibility: r.visibility,
    spoiler: r.spoiler === 1,
    lang: r.lang,
    media:
      r.media_id == null
        ? null
        : {
            kind: r.media_kind,
            provider: r.media_provider,
            id: r.media_id,
            url: r.media_url,
            w: r.media_w,
            h: r.media_h,
          },
    edited: r.updated_at > r.created_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLUMNS = `c.id, c.tmdb_id, c.media_type, c.season, c.episode, c.author_id, c.body,
       c.reaction, c.visibility, c.spoiler, c.lang, c.media_kind, c.media_provider,
       c.media_id, c.media_url, c.media_w, c.media_h, c.hidden_at, c.deleted_at,
       c.created_at, c.updated_at,
       p.display_name, p.avatar_id, p.picture_url`;

/**
 * A comment is only rendered — and only counted — when it has something to show.
 *
 * ⚠️ `body <> ''` alone is WRONG once media exists: keeping the media reaction as
 * a column preserves "react without commenting" (empty body, non-null reaction),
 * and a GIF-only comment is also empty-bodied. Both halves of this predicate have
 * to appear identically in the read queries and in `n_public`, or the badge stops
 * matching the list.
 */
const RENDERABLE = `c.hidden_at IS NULL AND c.deleted_at IS NULL AND (c.body <> '' OR c.media_id IS NOT NULL)`;

// ── Path 1: the public list (unauthenticated, edge-cached) ──────────────────

/**
 * Canonical cache key. Built from the parsed subject rather than `req.url` so
 * `?episode=2&season=1` and `?season=1&episode=2` are one cache entry, not two —
 * `caches.default` keys on the URL byte-for-byte and would otherwise fork.
 */
function publicCacheKey(s: Subject, lang: string, cursor: number): Request {
  return new Request(
    `https://comments.invalid/${s.mediaType}/${s.tmdbId}/${s.season}/${s.episode}?lang=${lang}&cursor=${cursor}`,
  );
}

/** `caches.default` where it exists (Workers). Node/vitest has no Cache API. */
function edgeCache(): Cache | null {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

/**
 * Public comments on [subject], newest first.
 *
 * **Keyset pagination, never `OFFSET`.** `LIMIT 20 OFFSET 200` scans and discards
 * 200 rows, so page 50 costs 50× page 1.
 *
 * [lang] filters to one language — tier 1 of the translation design, and a `WHERE`
 * clause on a query already being made, so it is free. A comment whose language
 * was never detected (`lang IS NULL`) always shows: failed detection must not
 * silently hide content.
 */
export async function loadPublicComments(env: CommentsEnv, s: Subject, lang: string, cursor: number) {
  const langFilter = lang ? " AND (c.lang IS NULL OR c.lang = ?)" : "";
  const binds: unknown[] = [s.tmdbId, s.mediaType, s.season, s.episode, cursor];
  if (lang) binds.push(lang);
  binds.push(PAGE_LIMIT);

  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM comments c LEFT JOIN profiles p ON p.user_id = c.author_id
      WHERE c.tmdb_id = ? AND c.media_type = ? AND c.season = ? AND c.episode = ?
        AND c.visibility = 'public' AND c.created_at < ? AND ${RENDERABLE}${langFilter}
      ORDER BY c.created_at DESC
      LIMIT ?`,
  )
    .bind(...binds)
    .all<CommentRow>();

  return results ?? [];
}

/**
 * How many public comments on [subject] are in some *other* language — the number
 * behind "14 comments in other languages — show all", which is also where the
 * translate affordance lives.
 *
 * Bounded by [OTHER_LANG_PROBE] rather than counting honestly: an unbounded
 * `COUNT(*)` on a hot episode scans thousands of rows for a number rendered as one
 * line of text. "500+" is a perfectly good answer.
 */
async function otherLanguageCount(env: CommentsEnv, s: Subject, lang: string): Promise<number> {
  if (!lang) return 0;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM comments c
        WHERE c.tmdb_id = ? AND c.media_type = ? AND c.season = ? AND c.episode = ?
          AND c.visibility = 'public' AND ${RENDERABLE}
          AND c.lang IS NOT NULL AND c.lang <> ?
        LIMIT ?)`,
  )
    .bind(s.tmdbId, s.mediaType, s.season, s.episode, lang, OTHER_LANG_PROBE)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * `GET /api/titles/{type}/{tmdbId}/comments?season=&episode=&lang=&cursor=`
 *
 * ⚠️ **Caching a Worker response is not automatic.** Unlike the R2-direct paths
 * (home rails, unified detail) where Cloudflare's CDN caches for free, a Worker
 * runs *in front of* the cache, so its response is never stored just because it
 * carries `Cache-Control`. It has to be put there explicitly, below.
 *
 * `caches.default` is **per-colo**, so the win scales with concurrent readers in
 * one region and is near-zero at low traffic. Built in anyway: retrofitting
 * caching around an endpoint's contract later is worse than writing it now.
 */
export async function handleGetComments(req: Request, env: CommentsEnv, s: Subject, ctx?: ExecutionContext) {
  const url = new URL(req.url);
  const lang = (url.searchParams.get("lang") ?? "").slice(0, MAX_LANG);
  const cursor = Number(url.searchParams.get("cursor")) || Number.MAX_SAFE_INTEGER;

  const cache = edgeCache();
  const key = publicCacheKey(s, lang, cursor);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const rows = await loadPublicComments(env, s, lang, cursor);
  const res = json({
    comments: rows.map(toWire),
    otherLanguages: await otherLanguageCount(env, s, lang),
    cursor: rows.length === PAGE_LIMIT ? rows[rows.length - 1].created_at : null,
  });
  res.headers.set("Cache-Control", `public, max-age=${PUBLIC_CACHE_SECONDS}`);

  // Fire-and-forget: a response must never be delayed by storing it.
  const put = cache?.put(key, res.clone());
  if (put) {
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

// ── Path 2: the friends slice (authenticated, NEVER cached) ─────────────────

/**
 * `GET /api/titles/{type}/{tmdbId}/comments/friends?season=&episode=`
 *
 * The friends-only comments the caller may read, plus the caller's own comment on
 * this subject whatever its visibility, plus the caller's own reactions across the
 * whole subject.
 *
 * The `IN` list is acceptable **here** and not on the public path: the index prefix
 * reaches `visibility='friends'` so the ordering survives and the engine walks
 * newest-first and stops at 20. Worst case it walks every friends-only comment on
 * the subject, a small minority of them. On the public path the same `IN` would sit
 * beside `OR` and defeat the ordering entirely.
 *
 * The caller's own id joins the author list rather than being `OR`-ed in, which is
 * how "my own friends-only comment is visible to me" costs nothing extra.
 *
 * `myReactions` rides this response rather than a request of its own: the toggle
 * state is needed for public comments too, and this is the one authenticated call
 * the sheet already makes.
 */
export async function handleGetFriendComments(
  req: Request,
  env: CommentsEnv,
  s: Subject,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const cursor = Number(url.searchParams.get("cursor")) || Number.MAX_SAFE_INTEGER;
  const { accepted } = await loadFriendships(env as any, session.userId);
  const authors = [session.userId, ...accepted];
  const placeholders = authors.map(() => "?").join(",");

  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM comments c LEFT JOIN profiles p ON p.user_id = c.author_id
      WHERE c.tmdb_id = ? AND c.media_type = ? AND c.season = ? AND c.episode = ?
        AND c.visibility = 'friends' AND c.author_id IN (${placeholders})
        AND c.created_at < ? AND ${RENDERABLE}
      ORDER BY c.created_at DESC
      LIMIT ?`,
  )
    .bind(s.tmdbId, s.mediaType, s.season, s.episode, ...authors, cursor, PAGE_LIMIT)
    .all<CommentRow>();

  const rows = results ?? [];
  return json({
    comments: rows.map(toWire),
    myReactions: await loadMyReactions(env, s, session.userId),
    cursor: rows.length === PAGE_LIMIT ? rows[rows.length - 1].created_at : null,
  });
}

/**
 * The caller's own reaction on every comment they have reacted to on this subject.
 *
 * Scoped by subject rather than by an id list so the client never has to send the
 * page back, which also means it covers public comments the caller reacted to —
 * the toggle state has to render on those too, and they arrive on the cached path
 * that by definition cannot carry anything reader-specific.
 */
async function loadMyReactions(env: CommentsEnv, s: Subject, userId: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT r.comment_id, r.emoji
       FROM comment_reactions r
       JOIN comments c ON c.id = r.comment_id
      WHERE r.user_id = ?
        AND c.tmdb_id = ? AND c.media_type = ? AND c.season = ? AND c.episode = ?
      LIMIT ?`,
  )
    .bind(userId, s.tmdbId, s.mediaType, s.season, s.episode, MY_REACTIONS_LIMIT)
    .all<{ comment_id: string; emoji: string }>();

  const out: Record<string, string> = {};
  for (const r of results ?? []) out[r.comment_id] = r.emoji;
  return out;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Does this row contribute to `comment_counts.n_public`?
 *
 * Public only. Including friends-only comments leaks that private ones exist and
 * shows a number the reader cannot reconcile with what they see.
 */
function countable(r: {
  visibility: string;
  hidden_at: number | null;
  deleted_at: number | null;
  body: string;
  media_id: string | null;
}): boolean {
  return (
    r.visibility === "public" &&
    r.hidden_at == null &&
    r.deleted_at == null &&
    (r.body !== "" || r.media_id != null)
  );
}

/**
 * The `comment_counts` upsert for a ±1 change, or null when nothing moved.
 *
 * **Always batched with the write it accounts for.** D1 batches are transactional,
 * so the counter cannot diverge from the rows — and a counter that drifts is worse
 * than no counter, because nothing ever recomputes it.
 */
export function countStatement(env: CommentsEnv, s: Subject, delta: number): D1PreparedStatement | null {
  if (delta === 0) return null;
  if (delta > 0) {
    return env.DB.prepare(
      `INSERT INTO comment_counts (tmdb_id, media_type, season, episode, n_public)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tmdb_id, media_type, season, episode)
       DO UPDATE SET n_public = n_public + ?`,
    ).bind(s.tmdbId, s.mediaType, s.season, s.episode, delta, delta);
  }
  // `MAX(…, 0)` is a floor, not a fix: a negative count would be a bug, but one
  // that renders as "-1 comments" rather than staying invisible until someone looks.
  return env.DB.prepare(
    `UPDATE comment_counts SET n_public = MAX(n_public + ?, 0)
      WHERE tmdb_id = ? AND media_type = ? AND season = ? AND episode = ?`,
  ).bind(delta, s.tmdbId, s.mediaType, s.season, s.episode);
}

/** Per-author hourly cap, the same shape as the friend-request limiter. */
async function rateLimited(env: CommentsEnv, userId: string): Promise<boolean> {
  const limit = Number(env.COMMENTS_PER_HOUR ?? DEFAULT_COMMENTS_PER_HOUR);
  if (limit <= 0) return false;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE author_id = ? AND created_at > ?")
    .bind(userId, Date.now() - 3600_000)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= limit;
}

interface MediaInput {
  kind: string | null;
  provider: string | null;
  id: string | null;
  url: string | null;
  w: number | null;
  h: number | null;
}

/** One media item per comment, or none. Any malformed part drops the whole item. */
function parseMedia(raw: unknown): MediaInput {
  const none: MediaInput = { kind: null, provider: null, id: null, url: null, w: null, h: null };
  if (!raw || typeof raw !== "object") return none;
  const m = raw as Record<string, unknown>;
  const kind = typeof m.kind === "string" ? m.kind : "";
  const provider = typeof m.provider === "string" ? m.provider : "";
  const id = typeof m.id === "string" ? m.id.slice(0, MAX_MEDIA_ID) : "";
  const url = typeof m.url === "string" ? m.url.slice(0, MAX_MEDIA_URL) : "";
  if (!MEDIA_KINDS.has(kind) || !MEDIA_PROVIDERS.has(provider) || !id || !url) return none;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
  return { kind, provider, id, url, w: num(m.w), h: num(m.h) };
}

/**
 * `POST /api/comments` — write or edit the caller's comment on a subject.
 *
 * One comment per user per subject, editable forever. That is the primary
 * anti-spam control: spam is bounded by how many subjects someone can be bothered
 * to visit. So this is an upsert on `(author_id, subject)`, not an insert — and
 * the id is the caller's, stable, so a retry after a dropped response is the same
 * comment rather than a second one.
 *
 * ⚠️ The **existing row's id wins** on an edit. A client that regenerates its id
 * would otherwise orphan every reaction on the comment it thinks it is editing.
 *
 * Editing forever is safe only because a report snapshots the body it was filed
 * against — see `handleReportComment`.
 */
export async function handlePostComment(
  req: Request,
  env: CommentsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const id = typeof payload.id === "string" ? payload.id : "";
  const mediaType = typeof payload.mediaType === "string" ? payload.mediaType : "";
  const params = new URLSearchParams();
  params.set("season", String(payload.season ?? -1));
  params.set("episode", String(payload.episode ?? -1));
  const subject = parseSubject(mediaType, String(payload.tmdbId ?? ""), params);

  if (!COMMENT_ID_RE.test(id) || !subject) return json({ error: "invalid_payload" }, 400);

  const body = typeof payload.body === "string" ? payload.body.trim().slice(0, MAX_BODY) : "";
  const reaction = typeof payload.reaction === "string" ? payload.reaction.slice(0, MAX_REACTION) : null;
  const media = parseMedia(payload.media);
  const lang = typeof payload.lang === "string" ? payload.lang.slice(0, MAX_LANG) || null : null;
  const spoiler = payload.spoiler === true ? 1 : 0;
  // ⚠️ Lenient parse in the SAFE direction. An unrecognised value must never widen
  // access, so anything that is not exactly 'public' is friends-only.
  const visibility = payload.visibility === "public" ? "public" : "friends";

  // A comment with no text, no media and no media reaction is not a comment.
  if (!body && !media.id && !reaction) return json({ error: "invalid_payload" }, 400);

  const existing = await env.DB.prepare(
    `SELECT id, visibility, hidden_at, deleted_at, body, media_id, created_at
       FROM comments
      WHERE author_id = ? AND tmdb_id = ? AND media_type = ? AND season = ? AND episode = ?`,
  )
    .bind(session.userId, subject.tmdbId, subject.mediaType, subject.season, subject.episode)
    .first<{
      id: string;
      visibility: string;
      hidden_at: number | null;
      deleted_at: number | null;
      body: string;
      media_id: string | null;
      created_at: number;
    }>();

  // Only a NEW comment spends rate-limit budget. Editing is not posting, and
  // charging for it would make a typo fix cost the same as a new comment.
  if (!existing && (await rateLimited(env, session.userId))) return json({ error: "rate_limited" }, 429);

  const now = Date.now();
  // A hidden comment stays hidden through an edit: letting an author clear
  // `hidden_at` by editing would make moderation a suggestion.
  const after = {
    visibility,
    hidden_at: existing?.hidden_at ?? null,
    deleted_at: null,
    body,
    media_id: media.id,
  };
  const before = existing
    ? countable(existing)
    : false;
  const delta = (countable(after) ? 1 : 0) - (before ? 1 : 0);

  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(
      env.DB.prepare(
        `UPDATE comments
            SET body = ?, reaction = ?, visibility = ?, spoiler = ?, lang = ?,
                media_kind = ?, media_provider = ?, media_id = ?, media_url = ?,
                media_w = ?, media_h = ?, deleted_at = NULL, updated_at = ?
          WHERE id = ? AND author_id = ?`,
      ).bind(
        body,
        reaction,
        visibility,
        spoiler,
        lang,
        media.kind,
        media.provider,
        media.id,
        media.url,
        media.w,
        media.h,
        now,
        existing.id,
        session.userId,
      ),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO comments (id, tmdb_id, media_type, season, episode, author_id, body,
                               reaction, visibility, spoiler, lang, media_kind, media_provider,
                               media_id, media_url, media_w, media_h, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        subject.tmdbId,
        subject.mediaType,
        subject.season,
        subject.episode,
        session.userId,
        body,
        reaction,
        visibility,
        spoiler,
        lang,
        media.kind,
        media.provider,
        media.id,
        media.url,
        media.w,
        media.h,
        now,
        now,
      ),
    );
  }

  const count = countStatement(env, subject, delta);
  if (count) statements.push(count);
  await env.DB.batch(statements);

  return json({ id: existing?.id ?? id, createdAt: existing?.created_at ?? now, updatedAt: now });
}

/**
 * `DELETE /api/comments/{id}` — tombstone the caller's own comment.
 *
 * **The row is retained**, body included, so moderation history survives an author
 * deleting something after it was reported. The comment vanishes from every read
 * path (see `RENDERABLE`) with no "[deleted]" placeholder — that is only needed
 * when replies would be orphaned, and there are no replies.
 *
 * Reaction rows and their counts go for real: they are other people's rows about a
 * comment that no longer renders, so keeping them would leak the comment's
 * existence through the reaction counts of a subject.
 */
export async function handleDeleteComment(
  id: string,
  req: Request,
  env: CommentsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const row = await env.DB.prepare(
    `SELECT id, tmdb_id, media_type, season, episode, visibility, hidden_at, deleted_at, body, media_id
       FROM comments WHERE id = ? AND author_id = ?`,
  )
    .bind(id, session.userId)
    .first<CommentRow>();
  // 204 even for an unknown id, so this cannot be used to probe which ids exist.
  if (!row) return noContent();

  const subject: Subject = {
    tmdbId: row.tmdb_id,
    mediaType: row.media_type as "movie" | "show",
    season: row.season,
    episode: row.episode,
  };
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE comments SET deleted_at = ?, updated_at = ? WHERE id = ? AND author_id = ?").bind(
      Date.now(),
      Date.now(),
      id,
      session.userId,
    ),
    env.DB.prepare("DELETE FROM comment_reactions WHERE comment_id = ?").bind(id),
    env.DB.prepare("DELETE FROM comment_reaction_counts WHERE comment_id = ?").bind(id),
  ];
  const count = countStatement(env, subject, countable(row) ? -1 : 0);
  if (count) statements.push(count);
  await env.DB.batch(statements);
  return noContent();
}

/**
 * Whether [viewerId] may read [authorId]'s friends-only comment.
 *
 * Exported for the notification and permalink paths, which resolve a single
 * comment rather than a page and therefore cannot lean on the `IN` list above.
 * Blocks are checked **first and bidirectionally**, the same rule `canView`
 * already applies to profiles.
 */
export async function mayReadComment(env: CommentsEnv, viewerId: string, row: CommentRow): Promise<boolean> {
  if (row.hidden_at != null || row.deleted_at != null) return false;
  if (row.author_id === viewerId) return true;
  if (await isBlockedEitherWay(env as any, viewerId, row.author_id)) return false;
  if (row.visibility === "public") return true;
  return areFriends(env as any, viewerId, row.author_id);
}

export { USER_ID_RE, COMMENT_ID_RE, countable, toWire };
