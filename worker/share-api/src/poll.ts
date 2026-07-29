/**
 * Episode community poll — an app-wide average rating, plus the share of voters who
 * picked each emotion and each character.
 *
 * ## Why there are three tables and not one
 *
 * `episode_votes` exists so a vote is changeable and one-per-user; it is **never read
 * by the display**. The display reads `episode_vote_counts` (one row) and
 * `episode_option_counts` (one row per option with at least one vote). `COUNT(*)`
 * would scan every vote on the episode, on every page open, for every reader who
 * never votes — which is the cost this design exists to avoid, the same argument the
 * comments counters were built on.
 *
 * ## The percentages are computed on the CLIENT
 *
 * The response carries counts, not percentages. That keeps one response correct for
 * every reader, which is what makes it cacheable at the edge. A per-reader response
 * could never be.
 *
 * ## Subject identity is shared with comments
 *
 * `Subject` and `parseSubject` come from `comments.ts` deliberately: the two features
 * must agree on what an episode is, and a second parser would drift.
 */

import { resolveSession } from "./auth";
import { type Subject } from "./comments";

// Local, matching `comments.ts` — there is no shared http module in this worker, and
// inventing one just for this would touch every other file.
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

export interface PollEnv {
  DB: D1Database;
}

/** Mirrors the public comments read. Kept identical so both age together. */
export const POLL_CACHE_SECONDS = 60;

/** Bounds the fan-out of one vote. Fifteen emotions ship; the cap is slack, not policy. */
const MAX_EMOTIONS = 20;
const MAX_EMOTION_ID = 32;

export type OptionKind = "emotion" | "person";

export interface PollTotals {
  nVoters: number;
  nRatings: number;
  ratingSum: number;
}

export interface PollOption {
  kind: OptionKind;
  optionId: string;
  n: number;
}

/** A vote as it arrives on the wire, already validated. */
export interface VoteInput {
  rating: number | null;
  emotions: string[];
  /**
   * The favourite CHARACTER, as one opaque source-qualified key -- `TVMAZE:c14839`
   * or `TMDB:p9999`. See `migrations/0005_poll_character_options.sql` for why this is
   * not a bare person id.
   */
  favouriteOptionId: string | null;
}

interface VoteRow {
  rating: number | null;
  emotions: string;
  favourite_option_id: string | null;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function loadPoll(
  env: PollEnv,
  s: Subject,
): Promise<{ totals: PollTotals; options: PollOption[] }> {
  const totalsRow = await env.DB.prepare(
    `SELECT n_voters, n_ratings, rating_sum FROM episode_vote_counts
      WHERE tmdb_id = ? AND media_type = ? AND season = ? AND episode = ?`,
  )
    .bind(s.tmdbId, s.mediaType, s.season, s.episode)
    .first<{ n_voters: number; n_ratings: number; rating_sum: number }>();

  // An episode nobody has voted on has no rows at all and costs an index seek that
  // finds nothing. Zeroes are the correct answer, not an error.
  const totals: PollTotals = {
    nVoters: totalsRow?.n_voters ?? 0,
    nRatings: totalsRow?.n_ratings ?? 0,
    ratingSum: totalsRow?.rating_sum ?? 0,
  };
  if (totals.nVoters === 0) return { totals, options: [] };

  const { results } = await env.DB.prepare(
    `SELECT kind, option_id, n FROM episode_option_counts
      WHERE tmdb_id = ? AND media_type = ? AND season = ? AND episode = ? AND n > 0`,
  )
    .bind(s.tmdbId, s.mediaType, s.season, s.episode)
    .all<{ kind: string; option_id: string; n: number }>();

  const options = (results ?? []).map((r) => ({
    kind: r.kind as OptionKind,
    optionId: r.option_id,
    n: r.n,
  }));
  return { totals, options };
}

function pollCacheKey(s: Subject): Request {
  return new Request(`https://poll.invalid/${s.mediaType}/${s.tmdbId}/${s.season}/${s.episode}`);
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
 * `GET /api/titles/{type}/{tmdbId}/poll?season=&episode=`
 *
 * Unauthenticated and identical for every reader, so a thousand people on a hot
 * episode cost one D1 read.
 *
 * ⚠️ **Caching a Worker response is not automatic.** A Worker runs in front of the
 * cache, so a `Cache-Control` header alone stores nothing — the `cache.put` below is
 * what does it. `caches.default` is per-colo, so the win scales with concurrent
 * readers in one region and is near-zero at low traffic; it is built in anyway
 * because retrofitting caching around an endpoint's contract is worse than writing
 * it now.
 *
 * The **rating average is spoiler-safe and public**; emotions and favourite
 * character are spoilers, and the watched-gate that hides them is a CLIENT decision.
 * That is deliberate: gating server-side would make the response per-reader and
 * uncacheable, for a rule the client can enforce from local watch history at no cost.
 */
export async function handleGetPoll(
  req: Request,
  env: PollEnv,
  s: Subject,
  ctx?: ExecutionContext,
): Promise<Response> {
  const cache = edgeCache();
  const key = pollCacheKey(s);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const { totals, options } = await loadPoll(env, s);
  const res = json({
    nVoters: totals.nVoters,
    nRatings: totals.nRatings,
    ratingSum: totals.ratingSum,
    options: options.map((o) => ({ kind: o.kind, id: o.optionId, n: o.n })),
  });
  res.headers.set("Cache-Control", `public, max-age=${POLL_CACHE_SECONDS}`);

  // Fire-and-forget: a response must never be delayed by storing it.
  const put = cache?.put(key, res.clone());
  if (put) {
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** Null for anything malformed, so a bad vote is a 400 and never a partial write. */
export function parseVote(payload: unknown): VoteInput | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  let rating: number | null = null;
  if (p.rating != null) {
    const r = Number(p.rating);
    if (!Number.isInteger(r) || r < 1 || r > 10) return null;
    rating = r;
  }

  const rawEmotions = Array.isArray(p.emotions) ? p.emotions : [];
  if (rawEmotions.length > MAX_EMOTIONS) return null;
  const emotions: string[] = [];
  for (const e of rawEmotions) {
    if (typeof e !== "string") return null;
    // Ids are the client's `EpisodeEmotions` catalogue: uppercase A-Z and underscore.
    // Validated rather than trusted because they become primary-key values.
    if (!/^[A-Z_]{1,32}$/.test(e) || e.length > MAX_EMOTION_ID) return null;
    if (!emotions.includes(e)) emotions.push(e);
  }

  let favouriteOptionId: string | null = null;
  if (p.favouriteOptionId != null) {
    if (typeof p.favouriteOptionId !== "string") return null;
    // ⚠️ Validated, not trusted: it becomes a PRIMARY KEY value in
    // `episode_option_counts`, and the client is not the only thing that can send it.
    // The charset is also what keeps the key bounded -- an unbounded id would be an
    // unbounded index entry. (The kind/id packing below joins on NUL, which no input
    // can contain, so that separator is not what this is defending.)
    if (!/^[A-Z]{2,12}:[cp][0-9]{1,12}$/.test(p.favouriteOptionId)) return null;
    favouriteOptionId = p.favouriteOptionId;
  }

  return { rating, emotions, favouriteOptionId };
}

/** The options a vote contributes, as `kind`/`id` pairs. */
function optionsOf(v: { emotions: string[]; favouriteOptionId: string | null }): Array<[OptionKind, string]> {
  const out: Array<[OptionKind, string]> = v.emotions.map((e) => ["emotion" as OptionKind, e]);
  // Still `person` as the kind: it is the slot for "the one thing you picked out of the
  // cast", and renaming it would orphan every emotion-free reader for no gain.
  if (v.favouriteOptionId != null) out.push(["person", v.favouriteOptionId]);
  return out;
}

function optionDelta(env: PollEnv, s: Subject, kind: OptionKind, id: string, delta: number) {
  // Upsert rather than UPDATE: the first vote for an option has no row yet, and
  // `MAX(0, …)` keeps a decrement from ever going negative if a vote is somehow
  // retracted twice.
  return env.DB.prepare(
    `INSERT INTO episode_option_counts (tmdb_id, media_type, season, episode, kind, option_id, n)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(tmdb_id, media_type, season, episode, kind, option_id)
       DO UPDATE SET n = MAX(0, n + ?)`,
  ).bind(s.tmdbId, s.mediaType, s.season, s.episode, kind, id, Math.max(0, delta), delta);
}

/**
 * `PUT /api/titles/{type}/{tmdbId}/vote?season=&episode=`
 *
 * The whole vote as one idempotent upsert: rating, emotions and favourite character
 * together, because they are captured on one screen and splitting them would make
 * three round trips out of one intent.
 *
 * ## Counters are adjusted by DIFF, in the same batch as the vote
 *
 * Changing a vote needs the old one, so this reads the existing row first and then
 * issues one `DB.batch()` of decrement-old → increment-new → upsert-vote. D1 batches
 * are transactional, so the counts cannot drift from the votes they summarise.
 *
 * The read-then-batch has a theoretical race when the same user votes from two of
 * their own devices at once. Accepted rather than defended against: the blast radius
 * is one user's own counts being off by one, and locking costs more than that is
 * worth.
 *
 * ⚠️ `n_voters` increments only when the vote row is **new**. Incrementing on an edit
 * would inflate the denominator every time someone changed their mind, which is
 * exactly the number every percentage is divided by.
 */
export async function handlePutVote(
  req: Request,
  env: PollEnv,
  s: Subject,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  // A movie has no episodes; a title-level vote would fork a counter nothing reads.
  if (s.season < 0 || s.episode < 0) return json({ error: "invalid_payload" }, 400);

  const vote = parseVote(await req.json().catch(() => null));
  if (!vote) return json({ error: "invalid_payload" }, 400);

  const key = [s.tmdbId, s.mediaType, s.season, s.episode] as const;
  const existing = await env.DB.prepare(
    `SELECT rating, emotions, favourite_option_id FROM episode_votes
      WHERE user_id = ? AND tmdb_id = ? AND media_type = ? AND season = ? AND episode = ?`,
  )
    .bind(session.userId, ...key)
    .first<VoteRow>();

  const old = existing
    ? {
        rating: existing.rating,
        emotions: existing.emotions ? existing.emotions.split(",").filter(Boolean) : [],
        favouriteOptionId: existing.favourite_option_id,
      }
    : null;

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  // ── Totals ──
  const voterDelta = old ? 0 : 1;
  const ratingCountDelta = (vote.rating != null ? 1 : 0) - (old?.rating != null ? 1 : 0);
  const ratingSumDelta = (vote.rating ?? 0) - (old?.rating ?? 0);
  statements.push(
    env.DB.prepare(
      `INSERT INTO episode_vote_counts (tmdb_id, media_type, season, episode, n_voters, n_ratings, rating_sum)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(tmdb_id, media_type, season, episode) DO UPDATE SET
         n_voters   = MAX(0, n_voters + ?),
         n_ratings  = MAX(0, n_ratings + ?),
         rating_sum = MAX(0, rating_sum + ?)`,
    ).bind(
      ...key,
      Math.max(0, voterDelta),
      Math.max(0, ratingCountDelta),
      Math.max(0, ratingSumDelta),
      voterDelta,
      ratingCountDelta,
      ratingSumDelta,
    ),
  );

  // ── Options, by set difference so an unchanged pick costs nothing ──
  const before = new Set(optionsOf(old ?? { emotions: [], favouriteOptionId: null }).map((o) => o.join(" ")));
  const after = new Set(optionsOf(vote).map((o) => o.join(" ")));
  for (const k of before) {
    if (!after.has(k)) {
      const [kind, id] = k.split(" ");
      statements.push(optionDelta(env, s, kind as OptionKind, id, -1));
    }
  }
  for (const k of after) {
    if (!before.has(k)) {
      const [kind, id] = k.split(" ");
      statements.push(optionDelta(env, s, kind as OptionKind, id, 1));
    }
  }

  // ── The vote itself ──
  statements.push(
    env.DB.prepare(
      `INSERT INTO episode_votes
         (user_id, tmdb_id, media_type, season, episode, rating, emotions, favourite_option_id, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, tmdb_id, media_type, season, episode) DO UPDATE SET
         rating = excluded.rating,
         emotions = excluded.emotions,
         favourite_option_id = excluded.favourite_option_id,
         updated_at = excluded.updated_at`,
    ).bind(
      session.userId,
      ...key,
      vote.rating,
      vote.emotions.join(","),
      vote.favouriteOptionId,
      now,
    ),
  );

  await env.DB.batch(statements);
  return noContent();
}
