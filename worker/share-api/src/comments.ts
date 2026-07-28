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
  /**
   * Workers AI, for the inline translation tier. **Optional on purpose**: with no
   * binding every comment comes back flagged untranslated and the client falls
   * back to on-device ML Kit, which is exactly the behaviour when the daily
   * allowance runs out. One code path, two causes.
   */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
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
const notFound = () => json({ error: "not_found" }, 404);

const USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/**
 * Author-minted comment id.
 *
 * ⚠️ **The full A-Z, not Crockford base32.** New ids are `{userId}:{subject}` and
 * would fit the narrower alphabet, but the `social_opinions` migration reuses the
 * existing `{friendId}:{tmdbId}` ids so a re-run and a second device are idempotent
 * — and a **device friendId is `[A-Z0-9]{12,40}`**, which includes I, L, O and U.
 * Crockford excludes exactly those four, so a narrower regex would 400 every
 * migrated comment from any friendId containing one, silently, forever.
 */
const COMMENT_ID_RE = /^[0-9A-Z:]{8,80}$/;

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

/**
 * The six. Fixed, not a picker.
 *
 * No 😡 deliberately: it is a known amplifier of hostile engagement (Facebook's
 * own finding) and has no constructive use on a comment about an episode. 😮
 * earns its place in a TV app specifically — twists, deaths, cliffhangers.
 *
 * ⚠️ This set may be **grown** safely; shrinking it strands existing rows in
 * `comment_reactions`, which then have to be rendered anyway or migrated. Adding
 * is free, removing is not — and the same asymmetry runs the other way for the
 * fixed-set decision itself: fixed → picker later is additive, picker → fixed
 * discards reactions people actually made.
 */
export const REACTION_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const REACTIONS = new Set(REACTION_EMOJI);

/**
 * Wake a user's devices with a payload they can render without asking us anything.
 *
 * Injected rather than imported for the same reason `lists.ts` takes one: the push
 * record lives in R2 and is keyed by the device friendId, neither of which belongs
 * in a D1-only module.
 *
 * ⚠️ **This is the side effect that gets forgotten.** Shared lists (2026-07-27) and
 * friend requests (2026-07-28) both shipped correct server state that no client was
 * ever told about, because the relay POST they replaced had been firing the FCM as a
 * side effect. Fire-and-forget by contract: a reaction must never fail because a
 * push did.
 */
export type CommentNotifier = (userId: string, data: Record<string, string>) => void;

/**
 * How long a comment stays quiet after notifying its author.
 *
 * Volume here is unbounded and attacker-controllable — a stranger can react to
 * anything you have written — and there is **no cron budget** for a scheduled
 * digest, so the write path throttles itself.
 */
const REACTION_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Friends told about one new comment. Bounded so a single comment can never become
 * an unbounded fan-out inside one request — friend counts are tens, so this is a
 * belt rather than a real limit.
 */
const MAX_COMMENT_NOTIFY_FANOUT = 50;

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
 *
 * `reactions` is **counts only** — there is no "who reacted" list, which would
 * cost a per-tap query plus display-name resolution for every reactor. The
 * caller's own reaction is the one reader-specific bit, and it rides
 * `myReactions` on the authenticated path instead.
 */
function toWire(r: CommentRow, reactions: Record<string, number> = {}, translation?: Translated) {
  return {
    reactions,
    /** Server-side translation, when one was asked for and succeeded. */
    translated: translation?.text ?? null,
    /**
     * The cue for tier 3. True means "we tried and could not" — an exhausted
     * daily allowance, a model error, or no AI binding at all — and the client
     * should offer "Translate on this device". False on a comment already in the
     * reader's language, where there is nothing to offer.
     */
    translationFailed: translation?.failed ?? false,
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

// ── The friend feed ─────────────────────────────────────────────────────────

/**
 * Recent comments by [authors], shaped as feed events.
 *
 * **Comments reach the friend feed with NO extra write.** There is deliberately
 * no `feed_events` row for a comment: `schema.sql` commits to fan-out on READ
 * precisely because reads have a 5M/day budget against 100k writes, so the feed
 * query asks `comments` as well and merges. The cost is one extra index —
 * `idx_comments_author_time` — and a second indexed query inside a Worker request
 * that is already happening, so not a second *chargeable* request.
 *
 * **Public and friends-only alike.** Visibility governs who may *read* a comment,
 * not whether your friends learn that you commented — and excluding public ones
 * would be backwards, since public is the *more* visible setting. Every author
 * here is already an accepted friend of the reader, which is also what makes
 * blocking need no separate check: `handleBlock` deletes the friendship row, so a
 * blocked author simply stops matching.
 *
 * Hidden, deleted and empty rows are excluded by the same predicate the comment
 * lists use, so the feed can never advertise a comment the reader cannot open.
 */
export async function loadFriendCommentEvents(
  env: CommentsEnv,
  authors: string[],
  limit: number,
  before: number,
  since: number,
) {
  if (authors.length === 0) return [];
  const placeholders = authors.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.author_id, c.tmdb_id, c.media_type, c.season, c.episode,
            c.body, c.spoiler, c.created_at
       FROM comments c
      WHERE c.author_id IN (${placeholders}) AND c.created_at < ? AND c.created_at > ?
        AND ${RENDERABLE}
      ORDER BY c.created_at DESC
      LIMIT ?`,
  )
    .bind(...authors, before, since, limit)
    .all<{
      id: string;
      author_id: string;
      tmdb_id: number;
      media_type: string;
      season: number;
      episode: number;
      body: string;
      spoiler: number;
      created_at: number;
    }>();

  return (results ?? []).map((r) => ({
    id: `comment:${r.id}`,
    userId: r.author_id,
    kind: "comment",
    tmdbId: r.tmdb_id,
    mediaType: r.media_type,
    // The client needs the comment id to deep-link into the sheet scrolled to it,
    // and `spoiler` so it can blur in the feed as well as in the list — a feed
    // that reveals what the comment page hides would defeat the flag entirely.
    payload: JSON.stringify({
      commentId: r.id,
      season: r.season,
      episode: r.episode,
      body: r.body,
      spoiler: r.spoiler === 1,
    }),
    createdAt: r.created_at,
  }));
}

// ── Reaction counts ─────────────────────────────────────────────────────────

/**
 * Reaction counts for a page of comments — one extra query per page, not per
 * comment, and reader-independent so it caches with the public list.
 *
 * Rows with `n = 0` are skipped rather than deleted when a reaction is removed:
 * deleting would need a second statement in the batch to establish that the row
 * hit zero, and an emoji at zero is indistinguishable from an absent one here.
 */
export async function loadReactionCounts(
  env: CommentsEnv,
  ids: string[],
): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT comment_id, emoji, n FROM comment_reaction_counts WHERE comment_id IN (${placeholders}) AND n > 0`,
  )
    .bind(...ids)
    .all<{ comment_id: string; emoji: string; n: number }>();

  for (const r of results ?? []) {
    (out[r.comment_id] ??= {})[r.emoji] = r.n;
  }
  return out;
}

// ── Translation ─────────────────────────────────────────────────────────────
//
// Three tiers, and most readers never leave the first:
//
//   1. **filter by `lang`** — a WHERE clause on a query already being made. Free,
//      instant, no downloads, no AI. Fragmentation is one line of UI: "14 comments
//      in other languages — show all", which is also where the affordance lives.
//   2. **"show all": translate inline, here.** The request is already paid for, so
//      AI inference and D1 queries inside it are subrequests, not billed
//      invocations — translation costs ZERO extra requests. The response becomes
//      per-*language*, not per-*user*, so it still edge-caches: one entry per
//      language rather than one per reader.
//   3. **allowance exhausted: on-device.** The failure is caught PER COMMENT and
//      the comment comes back flagged rather than failing the whole fetch. The
//      client then offers ML Kit on Android; the PWA has no fallback tier yet.
//
// ⚠️ **Never accept a client-generated translation back into this cache.** It is
// tempting — a device that translated something could warm the cache for everyone
// — and it is an injection vector: a user could upload an arbitrary "translation"
// of someone else's comment and the server would serve it as authoritative.

const TRANSLATION_MODEL = "@cf/meta/m2m100-1.2b";

/**
 * ⚠️ Bounds the AI calls one request can make. **Subrequests are the constraint**
 * — 50 per invocation on the free plan — and the budget is roughly: session +
 * friendships + comments ~3, translation cache lookup 1, one AI call per
 * untranslated comment up to 20, batched writeback 1. About 25. A 50-comment page
 * would blow the limit outright, which is why [PAGE_LIMIT] is 20.
 */
const MAX_TRANSLATIONS_PER_REQUEST = PAGE_LIMIT;

/** m2m100 wants a bare language code; our locales carry regions (`pt-BR`, `pt-PT`). */
const baseLang = (tag: string) => tag.split(/[-_]/)[0].toLowerCase();

interface Translated {
  /** The translated text, or null when this comment could not be translated. */
  text: string | null;
  /** True when translation was attempted and failed — the client's cue to try on-device. */
  failed: boolean;
}

/**
 * Translate [rows] into [target], reading the cache first and writing new results
 * back in one batch.
 *
 * **Top-down, and it STOPS at the first failure.** If the allowance runs out
 * mid-page, the comments at the top — the ones actually being read — are the
 * translated ones, and the remaining twenty subrequests are not spent discovering
 * the same failure nineteen more times. That is what "ordered degradation" buys.
 */
async function translateRows(
  env: CommentsEnv,
  rows: CommentRow[],
  target: string,
  ctx?: ExecutionContext,
): Promise<Record<string, Translated>> {
  const out: Record<string, Translated> = {};
  const needed = rows.filter((r) => r.body !== "" && r.lang != null && baseLang(r.lang) !== baseLang(target));
  if (needed.length === 0) return out;

  const placeholders = needed.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT comment_id, text, src_updated_at FROM comment_translations
      WHERE lang = ? AND comment_id IN (${placeholders})`,
  )
    .bind(target, ...needed.map((r) => r.id))
    .all<{ comment_id: string; text: string; src_updated_at: number }>();

  const cached = new Map((results ?? []).map((r) => [r.comment_id, r]));
  const writes: D1PreparedStatement[] = [];
  let exhausted = !env.AI;
  let spent = 0;

  for (const row of needed) {
    const hit = cached.get(row.id);
    // `src_updated_at` is what makes editing safe: a stale translation would
    // otherwise stay cached forever while readers see text that no longer
    // matches the original.
    if (hit && hit.src_updated_at === row.updated_at) {
      out[row.id] = { text: hit.text, failed: false };
      continue;
    }
    if (exhausted || spent >= MAX_TRANSLATIONS_PER_REQUEST) {
      out[row.id] = { text: null, failed: true };
      continue;
    }

    try {
      spent++;
      const result = (await env.AI!.run(TRANSLATION_MODEL, {
        text: row.body,
        source_lang: baseLang(row.lang!),
        target_lang: baseLang(target),
      })) as { translated_text?: string } | null;
      const text = result?.translated_text ?? "";
      if (!text) throw new Error("empty translation");
      out[row.id] = { text, failed: false };
      writes.push(
        env.DB
          .prepare(
            `INSERT INTO comment_translations (comment_id, lang, text, src_updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(comment_id, lang) DO UPDATE
               SET text = excluded.text, src_updated_at = excluded.src_updated_at`,
          )
          .bind(row.id, target, text, row.updated_at),
      );
    } catch {
      // Per comment, never per fetch. One model hiccup must not empty the page.
      out[row.id] = { text: null, failed: true };
      exhausted = true;
    }
  }

  // Batched, because each write would otherwise be its own subrequest against the
  // same 50-per-invocation budget the AI calls are already spending.
  if (writes.length > 0) {
    const put = env.DB.batch(writes);
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return out;
}

// ── Path 1: the public list (unauthenticated, edge-cached) ──────────────────

/**
 * Canonical cache key. Built from the parsed subject rather than `req.url` so
 * `?episode=2&season=1` and `?season=1&episode=2` are one cache entry, not two —
 * `caches.default` keys on the URL byte-for-byte and would otherwise fork.
 */
function publicCacheKey(s: Subject, lang: string, all: boolean, cursor: number): Request {
  return new Request(
    `https://comments.invalid/${s.mediaType}/${s.tmdbId}/${s.season}/${s.episode}` +
      `?lang=${lang}&all=${all ? 1 : 0}&cursor=${cursor}`,
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
  // "Show all": stop filtering by language and translate what comes back. The
  // response is still per-language rather than per-reader, so it still caches.
  const all = url.searchParams.get("all") === "1";
  const cursor = Number(url.searchParams.get("cursor")) || Number.MAX_SAFE_INTEGER;

  const cache = edgeCache();
  const key = publicCacheKey(s, lang, all, cursor);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const rows = await loadPublicComments(env, s, all ? "" : lang, cursor);
  const counts = await loadReactionCounts(env, rows.map((r) => r.id));
  const translations = all && lang ? await translateRows(env, rows, lang, ctx) : {};
  const res = json({
    comments: rows.map((r) => toWire(r, counts[r.id], translations[r.id])),
    otherLanguages: all ? 0 : await otherLanguageCount(env, s, lang),
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
  const counts = await loadReactionCounts(env, rows.map((r) => r.id));
  return json({
    comments: rows.map((r) => toWire(r, counts[r.id])),
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
  notify?: CommentNotifier,
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

  // ⚠️ **Only on a NEW comment.** Editing is allowed forever, so notifying on every
  // write would let one person re-notify all their friends by retyping a word — and
  // "Alex commented" arriving twice about the same comment is indistinguishable from
  // Alex commenting twice.
  if (!existing) {
    ctx?.waitUntil(notifyFriendsOfComment(env, session.userId, id, subject, notify));
  }

  return json({ id: existing?.id ?? id, createdAt: existing?.created_at ?? now, updatedAt: now });
}

/**
 * Tell the author's friends that they commented.
 *
 * Fan-out on **write** here, unlike the feed, and that asymmetry is deliberate: a
 * notification has to be *pushed* to be a notification, so there is no read-side
 * equivalent. It stays affordable because it is bounded by friend count (tens) and
 * fires once per comment rather than once per view.
 *
 * **Every accepted friend is notified regardless of visibility.** A friends-only
 * comment is readable by exactly this set, and a public one is readable by more —
 * so there is no visibility under which a friend may not open what they were told
 * about. Blocking needs no separate check either: `handleBlock` deletes the
 * friendship row, so a blocked user simply stops appearing in `accepted`.
 *
 * The display name rides the payload because the client cannot render "Alex
 * commented" from an opaque user id, and making each recipient look it up would
 * turn one push into one Worker request per friend.
 */
async function notifyFriendsOfComment(
  env: CommentsEnv,
  authorId: string,
  commentId: string,
  subject: Subject,
  notify?: CommentNotifier,
): Promise<void> {
  if (!notify) return;

  const { accepted } = await loadFriendships(env as any, authorId);
  if (accepted.length === 0) return;

  const profile = await env.DB.prepare("SELECT display_name FROM profiles WHERE user_id = ?")
    .bind(authorId)
    .first<{ display_name: string | null }>();

  const data = {
    kind: "friend_comment",
    commentId,
    authorId,
    authorName: profile?.display_name ?? "",
    tmdbId: String(subject.tmdbId),
    mediaType: subject.mediaType,
    season: String(subject.season),
    episode: String(subject.episode),
  };
  // Bounded so one account with an enormous friend list cannot turn a single
  // comment into an unbounded fan-out inside one request.
  for (const friendId of accepted.slice(0, MAX_COMMENT_NOTIFY_FANOUT)) notify(friendId, data);
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

// ── Reacting ────────────────────────────────────────────────────────────────

/**
 * `POST /api/comments/{id}/reaction` `{ emoji }` — set or change the caller's
 * reaction. `DELETE` on the same path removes it.
 *
 * One reaction per user per comment, changeable, which is why the PK is
 * `(comment_id, user_id)` and a change is a decrement plus an increment rather
 * than a second row.
 *
 * **Counts move by atomic upsert, never a JSON blob.** `ON CONFLICT DO UPDATE SET
 * n = n + 1` is atomic; a `reactions_json` column on `comments` would be a
 * read-modify-write and WILL lose reactions under concurrency.
 *
 * You may only react to a comment you may read — otherwise reacting becomes an
 * oracle for the existence and id of friends-only comments.
 */
export async function handleReactToComment(
  id: string,
  req: Request,
  env: CommentsEnv,
  ctx?: ExecutionContext,
  notify?: CommentNotifier,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const removing = req.method === "DELETE";
  let emoji = "";
  if (!removing) {
    let payload: Record<string, unknown>;
    try {
      payload = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    emoji = typeof payload.emoji === "string" ? payload.emoji : "";
    if (!REACTIONS.has(emoji)) return json({ error: "invalid_payload" }, 400);
  }

  const comment = await env.DB.prepare(
    "SELECT id, author_id, visibility, hidden_at, deleted_at FROM comments WHERE id = ?",
  )
    .bind(id)
    .first<CommentRow>();
  // Identical answer for "does not exist" and "you may not see it": any other
  // behaviour makes this endpoint a probe for which comments exist.
  if (!comment || !(await mayReadComment(env, session.userId, comment))) return notFound();

  const mine = await env.DB.prepare("SELECT emoji FROM comment_reactions WHERE comment_id = ? AND user_id = ?")
    .bind(id, session.userId)
    .first<{ emoji: string }>();
  if (mine?.emoji === emoji) return noContent(); // idempotent re-tap

  const statements: D1PreparedStatement[] = [];
  // The old count comes down first. Doing it after the insert would be fine
  // inside a transaction, but reading it in this order keeps the no-change case
  // (handled above) from ever emitting a statement pair that nets to zero.
  if (mine) {
    statements.push(
      env.DB
        .prepare("UPDATE comment_reaction_counts SET n = MAX(n - 1, 0) WHERE comment_id = ? AND emoji = ?")
        .bind(id, mine.emoji),
    );
  }
  if (removing) {
    statements.push(
      env.DB.prepare("DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ?").bind(id, session.userId),
    );
  } else {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(comment_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`,
        )
        .bind(id, session.userId, emoji, Date.now()),
      env.DB
        .prepare(
          `INSERT INTO comment_reaction_counts (comment_id, emoji, n) VALUES (?, ?, 1)
           ON CONFLICT(comment_id, emoji) DO UPDATE SET n = n + 1`,
        )
        .bind(id, emoji),
    );
  }
  await env.DB.batch(statements);

  // Removing a reaction never notifies: "someone un-reacted" is not news, and it
  // would double the volume of the noisiest event in the app.
  if (!removing) ctx?.waitUntil(notifyReaction(env, comment, session.userId, notify));
  return noContent();
}

/**
 * Tell the author that people are reacting — **bundled, cooled down, and anonymous**.
 *
 * This is the one notification a *stranger* can trigger, so its volume is
 * attacker-controllable by definition and every guard below is load-bearing:
 *
 * - **never notify yourself** — reacting to your own comment is not news;
 * - **never notify across a block**, checked in both directions;
 * - **one push per [REACTION_NOTIFY_COOLDOWN_MS]**, carrying the *current total*
 *   rather than one push per reaction. A comment that does well can draw hundreds;
 * - **the reactors are not named.** Reaction display is counts-only, so naming them
 *   would be inconsistent *and* would expose non-friend identities that stay hidden
 *   everywhere else in the app;
 * - the payload carries the count, so the client composes the notification with **no
 *   sync round trip**. Otherwise every reaction would cost the *recipient* a Worker
 *   request, which is the exact cost model this whole feature is shaped around.
 *
 * `last_notified_at` is claimed with a **conditional UPDATE**, never a read-then-write:
 * two reactions landing together would both see a stale timestamp and both notify.
 * `meta.changes === 0` means another request won the race, and this one stays quiet.
 */
async function notifyReaction(
  env: CommentsEnv,
  comment: CommentRow,
  reactorId: string,
  notify?: CommentNotifier,
): Promise<void> {
  if (!notify) return;
  if (comment.author_id === reactorId) return;
  if (await isBlockedEitherWay(env as any, reactorId, comment.author_id)) return;

  const now = Date.now();
  const claimed = await env.DB.prepare(
    "UPDATE comments SET last_notified_at = ? WHERE id = ? AND last_notified_at < ?",
  )
    .bind(now, comment.id, now - REACTION_NOTIFY_COOLDOWN_MS)
    .run();
  if (!claimed.meta?.changes) return;

  const tally = await env.DB.prepare(
    "SELECT COALESCE(SUM(n), 0) AS n FROM comment_reaction_counts WHERE comment_id = ?",
  )
    .bind(comment.id)
    .first<{ n: number }>();

  notify(comment.author_id, {
    kind: "comment_reaction",
    commentId: comment.id,
    tmdbId: String(comment.tmdb_id),
    mediaType: comment.media_type,
    season: String(comment.season),
    episode: String(comment.episode),
    count: String(tally?.n ?? 1),
  });
}

// ── Reporting ───────────────────────────────────────────────────────────────

/**
 * The two report kinds a comment can attract, and the reason they are two.
 *
 * ⚠️ **Spoiler reports must NOT count toward `REPORT_AUTOHIDE`.** If they did,
 * "report as spoiler" becomes a censorship lever: three people who dislike an
 * opinion tag it and it vanishes. So the counts are kept entirely separate by
 * `kind` — abuse reports hide, spoiler reports blur.
 */
const KIND_ABUSE = "comment";
const KIND_SPOILER = "comment_spoiler";

/**
 * **Threshold 2, not 3.** A spoiler is a mislabelling rather than a rules
 * violation: the comment is fine, its state is wrong. The consequence is mild and
 * reversible, so acting sooner is cheap.
 */
const SPOILER_AUTOFLAG = 2;
const DEFAULT_REPORT_AUTOHIDE = 3;
const MAX_REPORT_CONTEXT = 1000;
const REPORT_REASONS = new Set(["spoiler", "abuse", "harassment", "hate", "sexual", "spam", "other"]);

/** 128-bit opaque id, Crockford base32 — same shape as `users.id`. */
function newId(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * `POST /api/comments/{id}/report` `{ reason, context? }`.
 *
 * `reason: "spoiler"` blurs at [SPOILER_AUTOFLAG] distinct open reports; every
 * other reason hides at `REPORT_AUTOHIDE`. The two never mix — see above.
 *
 * ⚠️ **The body is snapshotted into the report row.** Editing is allowed forever,
 * so an author can rewrite a comment after it is flagged; without the snapshot the
 * admin decides on text that is no longer what was reported. The live row is kept
 * too: when the two diverge, that divergence is itself a signal, because editing
 * straight after a report is usually damage control.
 *
 * **Auto-hide is provisional, never terminal.** It hides *pending review* and an
 * admin can restore. Without that the threshold is a brigading tool — three
 * coordinated accounts could silently delete anyone's comment permanently.
 */
export async function handleReportComment(
  id: string,
  req: Request,
  env: CommentsEnv & { REPORT_AUTOHIDE?: string },
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
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  if (!REPORT_REASONS.has(reason)) return json({ error: "invalid_payload" }, 400);
  const note = typeof payload.context === "string" ? payload.context.trim().slice(0, MAX_REPORT_CONTEXT) : "";
  const context = note ? `${reason} — ${note}` : reason;
  const kind = reason === "spoiler" ? KIND_SPOILER : KIND_ABUSE;

  const comment = await env.DB.prepare(
    `SELECT id, tmdb_id, media_type, season, episode, author_id, body, visibility,
            spoiler, hidden_at, deleted_at, media_id
       FROM comments WHERE id = ?`,
  )
    .bind(id)
    .first<CommentRow>();
  if (!comment || !(await mayReadComment(env, session.userId, comment))) return notFound();
  // Reporting your own comment is a no-op that would otherwise let an author
  // self-brigade to a hidden state and blame the system.
  if (comment.author_id === session.userId) return noContent();

  // One open report per reporter per target **per kind**: the two thresholds are
  // independent, so someone who flagged a spoiler must still be able to report
  // abuse on the same comment.
  const existing = await env.DB.prepare(
    "SELECT id FROM reports WHERE reporter_id = ? AND target_id = ? AND kind = ? AND state = 'open'",
  )
    .bind(session.userId, id, kind)
    .first<{ id: string }>();
  if (existing) return noContent();

  await env.DB.prepare(
    `INSERT INTO reports (id, reporter_id, target_id, kind, context, state, created_at, body_snapshot)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(newId(), session.userId, id, kind, context, Date.now(), comment.body)
    .run();

  // ⚠️ **Only `open` reports count.** Dismissing marks them `dismissed`, so a
  // restored comment needs a fresh set rather than being re-tripped by the next
  // single report — which would let one person overturn a moderator.
  const tally = await env.DB.prepare(
    "SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_id = ? AND kind = ? AND state = 'open'",
  )
    .bind(id, kind)
    .first<{ n: number }>();
  const n = tally?.n ?? 0;

  if (kind === KIND_SPOILER) {
    // A spoiler report BLURS, it does not hide: the action is `spoiler`, never
    // `hidden_at`. Once community-flagged only an admin can clear it — otherwise
    // the author simply unticks it.
    if (n >= SPOILER_AUTOFLAG && comment.spoiler !== 1) {
      await env.DB.prepare("UPDATE comments SET spoiler = 1 WHERE id = ?").bind(id).run();
    }
    return noContent();
  }

  const threshold = Number(env.REPORT_AUTOHIDE ?? DEFAULT_REPORT_AUTOHIDE);
  if (n >= threshold && comment.hidden_at == null) {
    await setHidden(env, comment, true);
  }
  return noContent();
}

/**
 * Hide or restore a comment, moving `n_public` with it in the same batch.
 *
 * Shared by the auto-hide threshold and the admin action, because getting the
 * counter right in one of those two places and not the other is exactly how a
 * counter drifts.
 */
export async function setHidden(env: CommentsEnv, row: CommentRow, hidden: boolean): Promise<void> {
  const subject: Subject = {
    tmdbId: row.tmdb_id,
    mediaType: row.media_type as "movie" | "show",
    season: row.season,
    episode: row.episode,
  };
  const was = countable(row);
  const now = countable({ ...row, hidden_at: hidden ? Date.now() : null });
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE comments SET hidden_at = ? WHERE id = ?").bind(hidden ? Date.now() : null, row.id),
  ];
  const count = countStatement(env, subject, (now ? 1 : 0) - (was ? 1 : 0));
  if (count) statements.push(count);
  await env.DB.batch(statements);
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
