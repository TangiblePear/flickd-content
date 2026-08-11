/**
 * One Take — the daily film puzzle: submission, friends, leaderboard, distribution.
 *
 * ## The server derives the score. It never takes one.
 *
 * A client posts the GUESS LIST, not a result. This worker reads the day's archived
 * answer out of R2 — a key no client can fetch, because the Pages function routes
 * `content/*` and nothing else — checks the final guess really is the answer, and derives
 * the guess count and the score itself. That is the difference between rows worth ranking
 * and rows that would have to be thrown away the first time anyone checked.
 *
 * One array shape serves both today's submission and the sign-in backfill, so there is no
 * second endpoint and no second trust model: a player who spent a fortnight signed out
 * gets each of those days verified against its own archived answer on the way in.
 *
 * ## What this deliberately does NOT defend against
 *
 * Someone who digs the obfuscation key out of a client can read today's answer and post
 * it as guess #1. That is unfixable while the client grades offline, and it is why
 * ranking is FRIENDS ONLY — forging there moves you up a list of people who know you, so
 * the incentive never really appears. A global leaderboard would supply that incentive
 * and would need server-validated guessing first. See docs/game/grading-fixtures.json.
 */
import { resolveSession } from "./auth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

export interface DailyGameEnv {
  DB: D1Database;
  /** flickto-content. Read-only here, and only for `game-state/answers/*`. */
  CONTENT_BUCKET?: R2Bucket;
  /**
   * Optional, and the only defence on the one unauthenticated WRITE in this worker.
   *
   * Anonymous submissions are fully verified, so nobody can inflate a "solved in 1"
   * without naming the right title. What remains is someone posting many VALID results
   * to skew a display statistic, for no gain — proportionate to answer with a rate limit
   * rather than with per-anonymous-player dedupe rows, which would mean a write per
   * anonymous player per day plus IP retention, to make a fun figure marginally sharper.
   *
   * Declared optional so the worker deploys with or without the binding; see
   * wrangler.toml for how to enable it. Absent, this degrades to no limit rather than
   * to a broken endpoint.
   */
  ANON_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/**
 * MUST match docs/game/grading-fixtures.json and both clients. The clients compute this
 * for display; the value stored is always the one derived here.
 */
const SCORE_LADDER = [100, 80, 60, 45, 30, 15];
const MAX_GUESSES = 6;
const UNSOLVED_SCORE = 0;

/** How far back a sign-in backfill may reach. Answer files are kept 40 days, so this fits. */
const BACKFILL_DAYS = 30;

/** Bounds one request. A month of catch-up is the most an honest client ever sends. */
const MAX_RESULTS_PER_REQUEST = 31;

const ANSWER_PREFIX = "game-state/answers/";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86_400_000,
  );
}

function scoreFor(guessCount: number, solved: boolean): number {
  if (!solved) return UNSOLVED_SCORE;
  const i = guessCount - 1;
  return i >= 0 && i < SCORE_LADDER.length ? SCORE_LADDER[i] : UNSOLVED_SCORE;
}

/** Histogram bucket: 0 is "did not solve", 1..6 is "solved on N". */
function bucketFor(guessCount: number, solved: boolean): number {
  return solved ? guessCount : 0;
}

type ArchivedAnswer = { date: string; puzzleNumber: number; tmdbId: number; title: string };

async function readAnswer(env: DailyGameEnv, date: string): Promise<ArchivedAnswer | null> {
  if (!env.CONTENT_BUCKET) return null;
  const obj = await env.CONTENT_BUCKET.get(`${ANSWER_PREFIX}${date}.json`);
  if (!obj) return null;
  try {
    return (await obj.json()) as ArchivedAnswer;
  } catch {
    return null;
  }
}

type SubmittedResult = { date: string; puzzleNumber?: number; guesses: number[] };
type VerifiedResult = {
  date: string;
  puzzleNumber: number;
  guessCount: number;
  solved: boolean;
  score: number;
};

function parseBody(body: unknown): SubmittedResult[] | null {
  if (!body || typeof body !== "object") return null;
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return null;
  if (results.length > MAX_RESULTS_PER_REQUEST) return null;

  const out: SubmittedResult[] = [];
  for (const raw of results) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as { date?: unknown; puzzleNumber?: unknown; guesses?: unknown };
    if (typeof r.date !== "string" || !DATE_RE.test(r.date)) return null;
    if (!Array.isArray(r.guesses)) return null;
    if (r.guesses.length < 1 || r.guesses.length > MAX_GUESSES) return null;
    if (!r.guesses.every((g) => Number.isInteger(g))) return null;
    out.push({
      date: r.date,
      puzzleNumber: typeof r.puzzleNumber === "number" ? r.puzzleNumber : undefined,
      guesses: r.guesses as number[],
    });
  }
  return out;
}

/**
 * Checks one submitted result against the day's real answer.
 *
 * Returns null for anything that cannot be trusted, and the caller drops it silently
 * rather than failing the whole request: a backfill spanning a day whose answer has aged
 * out should still land the other twenty-nine.
 */
async function verify(
  env: DailyGameEnv,
  submitted: SubmittedResult,
  today: string,
  maxAgeDays: number,
): Promise<VerifiedResult | null> {
  const age = daysBetween(submitted.date, today);
  if (age < 0) return null;              // dated in the future
  if (age > maxAgeDays) return null;     // outside the window we can still verify

  const answer = await readAnswer(env, submitted.date);
  if (!answer) return null;

  // A client claiming a different puzzle for this date is either confused or probing.
  if (submitted.puzzleNumber !== undefined && submitted.puzzleNumber !== answer.puzzleNumber) {
    return null;
  }

  const guesses = submitted.guesses;
  const last = guesses[guesses.length - 1];
  const solved = last === answer.tmdbId;

  // The answer cannot appear before the final slot: play stops the moment it is guessed.
  // A list containing it earlier did not come from the game.
  if (guesses.slice(0, -1).includes(answer.tmdbId)) return null;

  const guessCount = guesses.length;
  return {
    date: submitted.date,
    puzzleNumber: answer.puzzleNumber,
    guessCount,
    solved,
    score: scoreFor(guessCount, solved),
  };
}

type StatsRow = {
  played: number;
  wins: number;
  currentStreak: number;
  bestStreak: number;
  totalScore: number;
  histogram: Record<string, number>;
  lastPlayedDate: string | null;
};

/**
 * Rebuilds the rollup from the daily rows.
 *
 * Recomputed rather than incremented, because a backfill can insert days in the MIDDLE of
 * an existing history — signing in after a fortnight of anonymous play can join two runs
 * into one longer streak, which no incremental update could have seen.
 */
async function recomputeStats(env: DailyGameEnv, userId: string): Promise<StatsRow> {
  const { results } = await env.DB.prepare(
    "SELECT date, solved, score, guess_count FROM daily_game_results WHERE user_id = ? ORDER BY date DESC",
  )
    .bind(userId)
    .all<{ date: string; solved: number; score: number; guess_count: number }>();

  const rows = results ?? [];
  const histogram: Record<string, number> = {};
  let played = 0;
  let wins = 0;
  let totalScore = 0;

  for (const r of rows) {
    played++;
    if (r.solved) wins++;
    totalScore += r.score;
    const bucket = String(bucketFor(r.guess_count, r.solved === 1));
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }

  // Streaks count PLAYED days, won or lost. Losing does not break one; only not turning
  // up does. rows are newest-first, so the run that is still unbroken at index i — that
  // is, run === i + 1 — is the CURRENT streak.
  let currentStreak = 0;
  let bestStreak = 0;
  let run = 0;
  for (let i = 0; i < rows.length; i++) {
    const consecutive = i > 0 && daysBetween(rows[i].date, rows[i - 1].date) === 1;
    run = consecutive ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    if (run === i + 1) currentStreak = run;
  }

  const lastPlayedDate = rows[0]?.date ?? null;

  await env.DB.prepare(
    `INSERT INTO daily_game_stats
       (user_id, played, wins, current_streak, best_streak, total_score, guess_histogram, last_played_date, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(user_id) DO UPDATE SET
       played = excluded.played, wins = excluded.wins,
       current_streak = excluded.current_streak, best_streak = excluded.best_streak,
       total_score = excluded.total_score, guess_histogram = excluded.guess_histogram,
       last_played_date = excluded.last_played_date, updated_at = excluded.updated_at`,
  )
    .bind(
      userId, played, wins, currentStreak, bestStreak, totalScore,
      JSON.stringify(histogram), lastPlayedDate, Date.now(),
    )
    .run();

  return { played, wins, currentStreak, bestStreak, totalScore, histogram, lastPlayedDate };
}

/**
 * POST /api/daily-game/result — **session OPTIONAL**, deliberately.
 *
 * ⚠️ This is one of two handlers in this file that does not gate on a session, and in a
 * worker where `resolveSession` -> 401 is the house style that reads as the bug the
 * others were written to avoid. It is not. The game is fully playable signed out, most
 * web players never sign in, and verification has never needed a session — the answer
 * comes from R2 either way. Rejecting anonymous submissions would exclude the majority of
 * players from the distribution figure they are being shown.
 *
 * What a session DOES decide is how much is written: with one, a personal row and the
 * rollup; without one, only the anonymous counter. And an anonymous caller may submit
 * TODAY ONLY, one result — backfill is what a session buys, so a single unauthenticated
 * request can never add a month of counts.
 */
export async function handlePostResult(
  req: Request,
  env: DailyGameEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);

  const body = await req.json().catch(() => null);
  const submitted = parseBody(body);
  if (!submitted) return json({ error: "invalid_payload" }, 400);

  const today = todayIso();

  if (!session) {
    if (submitted.length !== 1) return json({ error: "anonymous_single_result_only" }, 400);
    if (submitted[0].date !== today) return json({ error: "anonymous_today_only" }, 400);

    // Keyed on the connecting IP, which is the only stable handle an anonymous caller
    // has. Not stored — passed to the limiter and discarded.
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    const limit = await env.ANON_RATE_LIMITER?.limit({ key: `dg:${ip}` });
    if (limit && !limit.success) return json({ error: "rate_limited" }, 429);

    const verified = await verify(env, submitted[0], today, 0);
    if (!verified) return json({ error: "unverified" }, 400);

    await bumpAnonDistribution(env, verified);
    return json({ accepted: 1, anonymous: true });
  }

  const verified: VerifiedResult[] = [];
  for (const s of submitted) {
    const v = await verify(env, s, today, BACKFILL_DAYS);
    if (v) verified.push(v);
  }
  if (verified.length === 0) return json({ error: "unverified" }, 400);

  const now = Date.now();
  await env.DB.batch(
    verified.map((v) =>
      env.DB
        .prepare(
          `INSERT INTO daily_game_results
             (user_id, date, puzzle_number, guess_count, solved, score, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(user_id, date) DO NOTHING`,
        )
        .bind(session.userId, v.date, v.puzzleNumber, v.guessCount, v.solved ? 1 : 0, v.score, now),
    ),
  );

  const stats = await recomputeStats(env, session.userId);
  return json({ accepted: verified.length, stats });
}

async function bumpAnonDistribution(env: DailyGameEnv, v: VerifiedResult): Promise<void> {
  const bucket = bucketFor(v.guessCount, v.solved);
  await env.DB
    .prepare(
      `INSERT INTO daily_game_anon_distribution (date, guess_count, count)
       VALUES (?1, ?2, 1)
       ON CONFLICT(date, guess_count) DO UPDATE SET count = count + 1`,
    )
    .bind(v.date, bucket)
    .run();
}

/** GET /api/daily-game/friends?date=YYYY-MM-DD — how your friends did on one day. */
export async function handleGetFriendsDay(
  req: Request,
  env: DailyGameEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const date = new URL(req.url).searchParams.get("date") ?? todayIso();
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400);

  const { results } = await env.DB.prepare(
    `SELECT r.user_id, r.guess_count, r.solved, r.score, p.display_name, p.avatar_id
       FROM daily_game_results r
       LEFT JOIN profiles p ON p.user_id = r.user_id
      WHERE r.date = ?1
        AND r.user_id IN (
          SELECT CASE WHEN f.user_a = ?2 THEN f.user_b ELSE f.user_a END
            FROM friendships f
           WHERE (f.user_a = ?2 OR f.user_b = ?2) AND f.state = 'accepted'
        )
      ORDER BY r.solved DESC, r.guess_count ASC`,
  )
    .bind(date, session.userId)
    .all<{
      user_id: string; guess_count: number; solved: number; score: number;
      display_name: string | null; avatar_id: string | null;
    }>();

  return json({
    date,
    friends: (results ?? []).map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      avatarId: r.avatar_id,
      guessCount: r.guess_count,
      solved: r.solved === 1,
      score: r.score,
    })),
  });
}

/**
 * GET /api/daily-game/leaderboard?window=week|all — ranked among friends, and you.
 *
 * `week` is a rolling 7 days rather than a calendar week, and it is the tab that serves
 * the point of the feature: it rewards turning up and forgives one missed day, where a
 * single-day ranking is mostly ties and an all-time one is unwinnable for anyone who
 * starts late.
 */
export async function handleGetLeaderboard(
  req: Request,
  env: DailyGameEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const window = new URL(req.url).searchParams.get("window") === "all" ? "all" : "week";

  // Friends PLUS the caller: a leaderboard you are absent from is not a leaderboard.
  const membership = `(
      SELECT CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
        FROM friendships f
       WHERE (f.user_a = ?1 OR f.user_b = ?1) AND f.state = 'accepted'
      UNION SELECT ?1
    )`;

  const query =
    window === "all"
      ? `SELECT s.user_id, s.total_score AS score, s.played, s.wins, s.current_streak,
                p.display_name, p.avatar_id
           FROM daily_game_stats s
           LEFT JOIN profiles p ON p.user_id = s.user_id
          WHERE s.user_id IN ${membership}
          ORDER BY score DESC, s.wins DESC`
      : `SELECT r.user_id, SUM(r.score) AS score, COUNT(*) AS played,
                SUM(r.solved) AS wins, 0 AS current_streak,
                p.display_name, p.avatar_id
           FROM daily_game_results r
           LEFT JOIN profiles p ON p.user_id = r.user_id
          WHERE r.date >= ?2
            AND r.user_id IN ${membership}
          GROUP BY r.user_id
          ORDER BY score DESC, wins DESC`;

  const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const stmt =
    window === "all"
      ? env.DB.prepare(query).bind(session.userId)
      : env.DB.prepare(query).bind(session.userId, since);

  const { results } = await stmt.all<{
    user_id: string; score: number; played: number; wins: number;
    current_streak: number; display_name: string | null; avatar_id: string | null;
  }>();

  return json({
    window,
    since: window === "week" ? since : null,
    entries: (results ?? []).map((r, i) => ({
      rank: i + 1,
      userId: r.user_id,
      displayName: r.display_name,
      avatarId: r.avatar_id,
      score: r.score ?? 0,
      played: r.played ?? 0,
      wins: r.wins ?? 0,
      currentStreak: r.current_streak ?? 0,
      isSelf: r.user_id === session.userId,
    })),
  });
}

/**
 * GET /api/daily-game/distribution?date= — how everyone did, for the percentile.
 *
 * ⚠️ UNAUTHENTICATED on purpose, and the second of the two handlers here that is. A
 * signed-out player is shown this figure and must be able to fetch it. It exposes nothing
 * but seven aggregate counts.
 *
 * Signed-in results are counted by GROUPING the rows, not from a counter, so an erased
 * account drops out of every historical total automatically — the same reason poll totals
 * are derived. Anonymous submissions have no row to group and come from the counter table.
 * Both halves are needed; either alone under-reports.
 */
export async function handleGetDistribution(req: Request, env: DailyGameEnv): Promise<Response> {
  const date = new URL(req.url).searchParams.get("date") ?? todayIso();
  if (!DATE_RE.test(date)) return json({ error: "invalid_date" }, 400);

  const [signedIn, anonymous] = await Promise.all([
    env.DB.prepare(
      `SELECT (CASE WHEN solved = 1 THEN guess_count ELSE 0 END) AS bucket, COUNT(*) AS n
         FROM daily_game_results WHERE date = ?1 GROUP BY bucket`,
    ).bind(date).all<{ bucket: number; n: number }>(),
    env.DB.prepare(
      "SELECT guess_count AS bucket, count AS n FROM daily_game_anon_distribution WHERE date = ?1",
    ).bind(date).all<{ bucket: number; n: number }>(),
  ]);

  const buckets: number[] = new Array(MAX_GUESSES + 1).fill(0);
  for (const row of [...(signedIn.results ?? []), ...(anonymous.results ?? [])]) {
    if (row.bucket >= 0 && row.bucket <= MAX_GUESSES) buckets[row.bucket] += row.n;
  }

  const total = buckets.reduce((a, b) => a + b, 0);
  return json(
    { date, buckets, total },
    200,
    // Short: it moves all day as people play, and a stale percentile is worse than a
    // slightly expensive one.
    { "Cache-Control": "public, max-age=60" },
  );
}
