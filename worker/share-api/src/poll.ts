/**
 * Episode community poll — an app-wide average rating, plus the share of voters who
 * picked each emotion and each character.
 *
 * ## One table, aggregated on read
 *
 * `episode_votes` is the whole poll: one changeable row per user, and every total is
 * derived from it with `COUNT`/`GROUP BY` at read time. The materialised counter
 * tables that used to front this were dropped — voting is a hot write and each vote
 * touched several counter rows, which is exactly the D1 write volume this removes. The
 * read is protected by the 60-second edge cache below and an index on the subject, so
 * the aggregate scan runs at most once per subject per minute per colo.
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

// ── Reading ─────────────────────────────────────────────────────────────────

export async function loadPoll(
  env: PollEnv,
  s: Subject,
): Promise<{ totals: PollTotals; options: PollOption[] }> {
  const totalsRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n_voters,
            COUNT(rating) AS n_ratings,
            COALESCE(SUM(rating), 0) AS rating_sum
       FROM episode_votes
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

  // Character/person options: one GROUP BY over the favourite column.
  const { results: personResults } = await env.DB.prepare(
    `SELECT 'person' AS kind, favourite_option_id AS option_id, COUNT(*) AS n
       FROM episode_votes
      WHERE tmdb_id = ? AND media_type = ? AND season = ? AND episode = ?
        AND favourite_option_id IS NOT NULL
      GROUP BY favourite_option_id`,
  )
    .bind(s.tmdbId, s.mediaType, s.season, s.episode)
    .all<{ kind: string; option_id: string; n: number }>();

  // Emotions are stored comma-joined in one column, so counting each one means
  // splitting the string. A recursive CTE peels one emotion off the front per step;
  // the leading '' seed row is filtered out by `emotion <> ''`.
  const { results: emotionResults } = await env.DB.prepare(
    `WITH split(emotion, rest) AS (
       SELECT '', emotions || ','
         FROM episode_votes
        WHERE tmdb_id = ? AND media_type = ? AND season = ? AND episode = ?
          AND emotions IS NOT NULL AND emotions <> ''
       UNION ALL
       SELECT SUBSTR(rest, 1, INSTR(rest, ',') - 1),
              SUBSTR(rest, INSTR(rest, ',') + 1)
         FROM split WHERE rest <> ''
     )
     SELECT 'emotion' AS kind, emotion AS option_id, COUNT(*) AS n
       FROM split WHERE emotion <> ''
      GROUP BY emotion`,
  )
    .bind(s.tmdbId, s.mediaType, s.season, s.episode)
    .all<{ kind: string; option_id: string; n: number }>();

  const options: PollOption[] = [
    ...(emotionResults ?? []).map((r) => ({
      kind: r.kind as OptionKind,
      optionId: r.option_id,
      n: r.n,
    })),
    ...(personResults ?? []).map((r) => ({
      kind: r.kind as OptionKind,
      optionId: r.option_id,
      n: r.n,
    })),
  ];
  return { totals, options };
}

/**
 * The wire body, shared by the read and the vote response.
 *
 * One function on purpose: the vote answers with the recomputed poll so the client
 * never has to derive it, and the moment the two shapes could drift the client would
 * be parsing one as the other.
 */
function pollBody(totals: PollTotals, options: PollOption[]) {
  return {
    nVoters: totals.nVoters,
    nRatings: totals.nRatings,
    ratingSum: totals.ratingSum,
    options: options.map((o) => ({ kind: o.kind, id: o.optionId, n: o.n })),
  };
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
  const res = json(pollBody(totals, options));
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
    // ⚠️ Validated, not trusted: it is stored on `episode_votes` and grouped
    // on to derive the per-character counts, and the client is not the only thing that
    // can send it. The charset is also what keeps the value bounded -- an unbounded id
    // would be an unbounded index entry.
    if (!/^[A-Z]{2,12}:[cp][0-9]{1,12}$/.test(p.favouriteOptionId)) return null;
    favouriteOptionId = p.favouriteOptionId;
  }

  return { rating, emotions, favouriteOptionId };
}

/**
 * `PUT /api/titles/{type}/{tmdbId}/vote?season=&episode=`
 *
 * The whole vote as one idempotent upsert: rating, emotions and favourite character
 * together, because they are captured on one screen and splitting them would make
 * three round trips out of one intent.
 *
 * ## One write, no counters
 *
 * The vote row is the only write. Totals and per-option shares are derived from
 * `episode_votes` on read ([loadPoll]), so changing a vote is a single upsert with no
 * counter arithmetic to keep in sync - and no read-then-batch race to reason about.
 */
export async function handlePutVote(
  req: Request,
  env: PollEnv,
  s: Subject,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  // A movie has no episodes; a title-level vote would fork a poll nothing reads.
  if (s.season < 0 || s.episode < 0) return json({ error: "invalid_payload" }, 400);

  const vote = parseVote(await req.json().catch(() => null));
  if (!vote) return json({ error: "invalid_payload" }, 400);

  // Single upsert - the only D1 write. Everything else is derived on read.
  await env.DB.prepare(
    `INSERT INTO episode_votes
       (user_id, tmdb_id, media_type, season, episode, rating, emotions, favourite_option_id, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, tmdb_id, media_type, season, episode) DO UPDATE SET
       rating = excluded.rating,
       emotions = excluded.emotions,
       favourite_option_id = excluded.favourite_option_id,
       updated_at = excluded.updated_at`,
  )
    .bind(
      session.userId,
      s.tmdbId,
      s.mediaType,
      s.season,
      s.episode,
      vote.rating,
      vote.emotions.join(","),
      vote.favouriteOptionId,
      Date.now(),
    )
    .run();

  // ⚠️ Drop the edge copy, or the voter can be served their own pre-vote numbers.
  // Device-found 2026-07-29: open an episode (the read is cached for 60s), vote, come
  // straight back — the refetch hit the cached copy, so `nVoters` was 0, every option
  // was missing, and the client rendered 0% for everything including the vote just
  // cast. `caches.default` is per-colo, so this only clears the colo that took the
  // vote; the answer below is what actually guarantees the voter sees the truth.
  const cache = edgeCache();
  if (cache) {
    const purge = cache.delete(pollCacheKey(s));
    if (ctx) ctx.waitUntil(purge);
    else await purge;
  }

  // ⚠️ Answer with the recomputed poll rather than 204. The client cannot derive these
  // numbers reliably on its own — it does not know whether this user already had a vote
  // row, so it cannot tell a new voter from an edit, and it guessed wrong every time
  // someone rated an episode in an earlier session (the rating IS a vote, so `n_voters`
  // was already 1 and the client added a phantom second one: one vote rendered as 50%).
  // One extra read here removes that entire class of bug instead of re-deriving it.
  const { totals, options } = await loadPoll(env, s);
  return json(pollBody(totals, options));
}
