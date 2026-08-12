import { describe, it, expect } from "vitest";
import { TestD1, seedSession, seedUser, testEnv, uid } from "./testD1";
import {
  handleGetDistribution,
  handleGetFriendsDay,
  handleGetLeaderboard,
  handleGetMine,
  handlePostResult,
} from "./dailyGame";
import { eraseAccount } from "./friends";

/**
 * One Take submission and reads, against REAL SQL.
 *
 * These handlers issue a CASE/GROUP BY, a subquery IN over `friendships`' canonical
 * (user_a < user_b) ordering, and a UNION that folds the caller into their own
 * leaderboard. A string-matching D1 double would prove each was *called* and nothing
 * about whether any of them returns the right rows, so this uses `TestD1` — a real SQLite
 * built from the real migrations, 0032 included.
 *
 * The load-bearing claim in the whole feature is that a stored score is trustworthy. Most
 * of what follows is an attempt to store an untrue one.
 */

const DAY = 86_400_000;
const iso = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

const ANSWER_TMDB = 550;

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stands in for the R2 bucket daily-ai writes answers to. Answers exist for the last 45
 * days and nothing else, mirroring the worker's 40-day retention plus slack.
 */
function answerBucket(answers: Record<string, { tmdbId: number; puzzleNumber: number }> | null = null) {
  const map =
    answers ??
    Object.fromEntries(
      Array.from({ length: 45 }, (_, i) => [
        iso(-i),
        { tmdbId: ANSWER_TMDB, puzzleNumber: 1000 - i },
      ]),
    );
  return {
    async get(key: string) {
      const date = key.replace("game-state/answers/", "").replace(/\.json$/, "");
      const hit = map[date];
      if (!hit) return null;
      return { async json() { return { date, title: "Fight Club", ...hit }; } };
    },
  };
}

function env(db: TestD1, over: Record<string, unknown> = {}) {
  return testEnv(db, { CONTENT_BUCKET: answerBucket(), ...over });
}

const post = (body: unknown, token?: string) =>
  new Request("https://flickto.app/api/daily-game/result", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

/** A signed-in player, and the bearer token that resolves to them. */
async function player(db: TestD1, n: number, displayName?: string) {
  const id = uid(n);
  seedUser(db, { id, displayName: displayName ?? `Player ${n}` });
  const token = `token-${n}`;
  seedSession(db, id, await hash(token));
  return { id, token };
}

function befriend(db: TestD1, a: string, b: string) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  db.prepare(
    "INSERT INTO friendships (user_a, user_b, state, requested_by, created_at, updated_at) VALUES (?, ?, 'accepted', ?, ?, ?)",
  )
    .bind(lo, hi, a, Date.now(), Date.now())
    .run();
}

/** Solved on guess 3 — two wrong ids then the answer. */
const solvedInThree = (date: string) => ({
  results: [{ date, guesses: [111, 222, ANSWER_TMDB], types: [0, 1, 0] }],
});

describe("submission is verified, never trusted", () => {
  it("derives the score from the guess list rather than taking one", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    // The body carries no score at all; there is nowhere to put a lie.
    const res = await handlePostResult(post(solvedInThree(iso()), me.token), env(db));
    expect(res.status).toBe(200);

    const row = db.one<{ score: number; guess_count: number; solved: number }>(
      "SELECT score, guess_count, solved FROM daily_game_results WHERE user_id = ?",
      me.id,
    );
    expect(row).toEqual({ score: 60, guess_count: 3, solved: 1 });
  });

  it("records a wrong final guess as played-and-lost, scoring zero", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    await handlePostResult(
      post({ results: [{ date: iso(), guesses: [111, 222, 333, 444, 555, 666] }] }, me.token),
      env(db),
    );

    const row = db.one<{ score: number; solved: number }>(
      "SELECT score, solved FROM daily_game_results WHERE user_id = ?",
      me.id,
    );
    // Turning up and losing still counts as playing — it is the streak that survives a
    // loss, not the score.
    expect(row).toEqual({ score: 0, solved: 0 });
  });

  it("rejects a result dated in the future", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    const res = await handlePostResult(post(solvedInThree(iso(1)), me.token), env(db));

    expect(res.status).toBe(400);
    expect(db.count("daily_game_results")).toBe(0);
  });

  it("rejects a result older than the backfill window even when the answer still exists", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    // The answer file MUST be present for this to test anything. With the default bucket
    // (45 days) a 60-day-old date is rejected for having no answer, and the age check
    // could be deleted without this failing -- which is exactly what a positive control
    // caught it doing.
    const ancient = testEnv(db, {
      CONTENT_BUCKET: answerBucket({ [iso(-60)]: { tmdbId: ANSWER_TMDB, puzzleNumber: 940 } }),
    });

    const res = await handlePostResult(post(solvedInThree(iso(-60)), me.token), ancient);

    expect(res.status).toBe(400);
    expect(db.count("daily_game_results")).toBe(0);
  });

  it("accepts the oldest day still inside the backfill window", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    // The other side of the boundary, so the window is proven to be a window rather than
    // a blanket rejection of anything not today.
    const res = await handlePostResult(post(solvedInThree(iso(-30)), me.token), env(db));

    expect(res.status).toBe(200);
    expect(db.count("daily_game_results")).toBe(1);
  });

  it("rejects a date with no archived answer, so nothing unverifiable is stored", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const empty = testEnv(db, { CONTENT_BUCKET: answerBucket({}) });

    const res = await handlePostResult(post(solvedInThree(iso()), me.token), empty);

    expect(res.status).toBe(400);
    expect(db.count("daily_game_results")).toBe(0);
  });

  it("rejects a guess list containing the answer before the final slot", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    // Play stops the moment the answer is guessed, so this list did not come from a game.
    // Without the check it would have been recorded as a 3-guess LOSS.
    const res = await handlePostResult(
      post({ results: [{ date: iso(), guesses: [ANSWER_TMDB, 222, 333] }] }, me.token),
      env(db),
    );

    expect(res.status).toBe(400);
    expect(db.count("daily_game_results")).toBe(0);
  });

  it("rejects a puzzle number that disagrees with the archived answer", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    const res = await handlePostResult(
      post({ results: [{ date: iso(), puzzleNumber: 99999, guesses: [ANSWER_TMDB] }] }, me.token),
      env(db),
    );

    expect(res.status).toBe(400);
  });

  it("keeps the first submission for a day, so a score cannot be improved", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const e = env(db);

    await handlePostResult(post(solvedInThree(iso()), me.token), e);
    await handlePostResult(
      post({ results: [{ date: iso(), guesses: [ANSWER_TMDB] }] }, me.token),
      e,
    );

    const row = db.one<{ score: number }>("SELECT score FROM daily_game_results WHERE user_id = ?", me.id);
    expect(row?.score).toBe(60);
    expect(db.count("daily_game_results")).toBe(1);
  });

  it("rejects a malformed body rather than storing a partial row", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const e = env(db);

    for (const body of [
      {},
      { results: [] },
      { results: [{ date: "not-a-date", guesses: [1] }] },
      { results: [{ date: iso(), guesses: [] }] },
      { results: [{ date: iso(), guesses: [1, 2, 3, 4, 5, 6, 7] }] },
      { results: [{ date: iso(), guesses: ["550"] }] },
    ]) {
      expect((await handlePostResult(post(body, me.token), e)).status).toBe(400);
    }
    expect(db.count("daily_game_results")).toBe(0);
  });
});

describe("anonymous play counts, but buys less", () => {
  it("accepts today from a caller with no session and moves the distribution", async () => {
    const db = new TestD1();

    const res = await handlePostResult(post(solvedInThree(iso())), env(db));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ anonymous: true, accepted: 1 });
    // Counted, but not attributed: there is no user to key a row on.
    expect(db.count("daily_game_results")).toBe(0);
    expect(
      db.one<{ count: number }>(
        "SELECT count FROM daily_game_anon_distribution WHERE date = ? AND guess_count = 3",
        iso(),
      )?.count,
    ).toBe(1);
  });

  it("refuses a backfill array without a session, so one call cannot add a month", async () => {
    const db = new TestD1();

    const res = await handlePostResult(
      post({ results: [solvedInThree(iso()).results[0], solvedInThree(iso(-1)).results[0]] }),
      env(db),
    );

    expect(res.status).toBe(400);
    expect(db.count("daily_game_anon_distribution")).toBe(0);
  });

  it("refuses a back-dated anonymous result", async () => {
    const db = new TestD1();

    const res = await handlePostResult(post(solvedInThree(iso(-1))), env(db));

    expect(res.status).toBe(400);
    expect(db.count("daily_game_anon_distribution")).toBe(0);
  });

  it("verifies an anonymous submission exactly as it verifies a signed-in one", async () => {
    const db = new TestD1();

    const res = await handlePostResult(
      post({ results: [{ date: iso(), guesses: [ANSWER_TMDB, 222] }] }),
      env(db),
    );

    expect(res.status).toBe(400);
    expect(db.count("daily_game_anon_distribution")).toBe(0);
  });

  it("honours the rate limiter when one is bound", async () => {
    const db = new TestD1();
    const limited = env(db, { ANON_RATE_LIMITER: { async limit() { return { success: false }; } } });

    const res = await handlePostResult(post(solvedInThree(iso())), limited);

    expect(res.status).toBe(429);
    expect(db.count("daily_game_anon_distribution")).toBe(0);
  });
});

describe("the distribution counts everybody", () => {
  it("sums signed-in rows and anonymous counters together", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const e = env(db);

    await handlePostResult(post(solvedInThree(iso()), me.token), e);   // signed in, bucket 3
    await handlePostResult(post(solvedInThree(iso())), e);             // anonymous, bucket 3
    await handlePostResult(
      post({ results: [{ date: iso(), guesses: [1, 2, 3, 4, 5, 6] }] }),
      e,
    );                                                                  // anonymous, lost

    const res = await handleGetDistribution(
      new Request(`https://flickto.app/api/daily-game/distribution?date=${iso()}`),
      e,
    );
    const body = (await res.json()) as { buckets: number[]; total: number };

    expect(res.status).toBe(200);
    expect(body.buckets[3]).toBe(2);
    expect(body.buckets[0]).toBe(1);
    expect(body.total).toBe(3);
  });

  it("answers without a session, because a signed-out player is shown this figure", async () => {
    const db = new TestD1();

    const res = await handleGetDistribution(
      new Request(`https://flickto.app/api/daily-game/distribution?date=${iso()}`),
      env(db),
    );

    expect(res.status).toBe(200);
  });

  it("drops an erased account from every historical total, with no counter to unpick", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const e = env(db);
    await handlePostResult(post(solvedInThree(iso()), me.token), e);

    const before = (await (await handleGetDistribution(
      new Request(`https://flickto.app/api/daily-game/distribution?date=${iso()}`), e,
    )).json()) as { total: number };
    expect(before.total).toBe(1);

    await eraseAccount(e, me.id);

    const after = (await (await handleGetDistribution(
      new Request(`https://flickto.app/api/daily-game/distribution?date=${iso()}`), e,
    )).json()) as { total: number };

    // This is why signed-in results are GROUPED on read rather than counted into the
    // anon table: erasure removes the rows, and the totals follow for free.
    expect(after.total).toBe(0);
    expect(db.count("daily_game_results")).toBe(0);
    expect(db.count("daily_game_stats")).toBe(0);
  });
});

describe("the rollup", () => {
  it("counts a streak of consecutive days played", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    await handlePostResult(
      post({ results: [0, -1, -2].map((d) => solvedInThree(iso(d)).results[0]) }, me.token),
      env(db),
    );

    const stats = db.one<{ current_streak: number; best_streak: number; played: number; wins: number }>(
      "SELECT current_streak, best_streak, played, wins FROM daily_game_stats WHERE user_id = ?",
      me.id,
    );
    expect(stats).toEqual({ current_streak: 3, best_streak: 3, played: 3, wins: 3 });
  });

  it("breaks the current streak on a missed day but keeps the best", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    // Played today, then a gap, then three in a row. Newest-first the run is 1.
    await handlePostResult(
      post({ results: [0, -3, -4, -5].map((d) => solvedInThree(iso(d)).results[0]) }, me.token),
      env(db),
    );

    const stats = db.one<{ current_streak: number; best_streak: number }>(
      "SELECT current_streak, best_streak FROM daily_game_stats WHERE user_id = ?",
      me.id,
    );
    expect(stats).toEqual({ current_streak: 1, best_streak: 3 });
  });

  it("joins two runs when a backfill fills the gap between them", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const e = env(db);

    await handlePostResult(
      post({ results: [0, -1, -3, -4].map((d) => solvedInThree(iso(d)).results[0]) }, me.token),
      e,
    );
    expect(
      db.one<{ current_streak: number }>("SELECT current_streak FROM daily_game_stats WHERE user_id = ?", me.id)
        ?.current_streak,
    ).toBe(2);

    // Signing in after a spell of anonymous play can insert a day in the MIDDLE of an
    // existing history. Nothing incremental could see that; the rollup is recomputed.
    await handlePostResult(post(solvedInThree(iso(-2)), me.token), e);

    const stats = db.one<{ current_streak: number; best_streak: number; played: number }>(
      "SELECT current_streak, best_streak, played FROM daily_game_stats WHERE user_id = ?",
      me.id,
    );
    expect(stats).toEqual({ current_streak: 5, best_streak: 5, played: 5 });
  });

  it("keeps a streak alive through a loss", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    await handlePostResult(
      post({
        results: [
          solvedInThree(iso()).results[0],
          { date: iso(-1), guesses: [1, 2, 3, 4, 5, 6] },
          solvedInThree(iso(-2)).results[0],
        ],
      }, me.token),
      env(db),
    );

    const stats = db.one<{ current_streak: number; played: number; wins: number }>(
      "SELECT current_streak, played, wins FROM daily_game_stats WHERE user_id = ?",
      me.id,
    );
    expect(stats).toEqual({ current_streak: 3, played: 3, wins: 2 });
  });

  it("records the guess histogram with losses in bucket zero", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    await handlePostResult(
      post({
        results: [
          { date: iso(), guesses: [ANSWER_TMDB] },
          { date: iso(-1), guesses: [1, ANSWER_TMDB] },
          { date: iso(-2), guesses: [1, 2, 3, 4, 5, 6] },
        ],
      }, me.token),
      env(db),
    );

    const raw = db.one<{ guess_histogram: string }>(
      "SELECT guess_histogram FROM daily_game_stats WHERE user_id = ?",
      me.id,
    );
    expect(JSON.parse(raw!.guess_histogram)).toEqual({ "1": 1, "2": 1, "0": 1 });
  });
});

describe("friends and leaderboard", () => {
  it("returns friends' results for a day and nobody else's", async () => {
    const db = new TestD1();
    const me = await player(db, 1, "Me");
    const mate = await player(db, 2, "Mate");
    const stranger = await player(db, 3, "Stranger");
    befriend(db, me.id, mate.id);
    const e = env(db);

    await handlePostResult(post(solvedInThree(iso()), mate.token), e);
    await handlePostResult(post(solvedInThree(iso()), stranger.token), e);

    const res = await handleGetFriendsDay(
      new Request(`https://flickto.app/api/daily-game/friends?date=${iso()}`, {
        headers: { Authorization: `Bearer ${me.token}` },
      }),
      e,
    );
    const body = (await res.json()) as { friends: Array<{ userId: string; displayName: string }> };

    expect(body.friends).toHaveLength(1);
    expect(body.friends[0]).toMatchObject({ userId: mate.id, displayName: "Mate", score: 60 });
  });

  it("401s without a session", async () => {
    const db = new TestD1();
    const res = await handleGetFriendsDay(
      new Request("https://flickto.app/api/daily-game/friends"),
      env(db),
    );
    expect(res.status).toBe(401);
  });

  it("ranks the caller among their friends and includes the caller", async () => {
    const db = new TestD1();
    const me = await player(db, 1, "Me");
    const mate = await player(db, 2, "Mate");
    befriend(db, me.id, mate.id);
    const e = env(db);

    // Mate solves on 1 (100); I solve on 3 (60).
    await handlePostResult(post({ results: [{ date: iso(), guesses: [ANSWER_TMDB] }] }, mate.token), e);
    await handlePostResult(post(solvedInThree(iso()), me.token), e);

    const res = await handleGetLeaderboard(
      new Request("https://flickto.app/api/daily-game/leaderboard?window=week", {
        headers: { Authorization: `Bearer ${me.token}` },
      }),
      e,
    );
    const body = (await res.json()) as {
      entries: Array<{ rank: number; userId: string; score: number; isSelf: boolean }>;
    };

    expect(body.entries.map((x) => [x.rank, x.userId, x.score])).toEqual([
      [1, mate.id, 100],
      [2, me.id, 60],
    ]);
    // A leaderboard the caller is absent from is not a leaderboard.
    expect(body.entries.find((x) => x.isSelf)?.userId).toBe(me.id);
  });

  it("excludes days outside the rolling week", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const e = env(db);

    await handlePostResult(
      post({ results: [solvedInThree(iso()).results[0], solvedInThree(iso(-20)).results[0]] }, me.token),
      e,
    );

    const week = (await (await handleGetLeaderboard(
      new Request("https://flickto.app/api/daily-game/leaderboard?window=week", {
        headers: { Authorization: `Bearer ${me.token}` },
      }), e,
    )).json()) as { entries: Array<{ score: number; played: number }> };

    const all = (await (await handleGetLeaderboard(
      new Request("https://flickto.app/api/daily-game/leaderboard?window=all", {
        headers: { Authorization: `Bearer ${me.token}` },
      }), e,
    )).json()) as { entries: Array<{ score: number; played: number }> };

    expect(week.entries[0]).toMatchObject({ score: 60, played: 1 });
    expect(all.entries[0]).toMatchObject({ score: 120, played: 2 });
  });

  it("401s on the leaderboard without a session", async () => {
    const db = new TestD1();
    const res = await handleGetLeaderboard(
      new Request("https://flickto.app/api/daily-game/leaderboard"),
      env(db),
    );
    expect(res.status).toBe(401);
  });
});

describe("the account remembers what you have played", () => {
  const mine = (token?: string, since?: string) =>
    new Request(
      `https://flickto.app/api/daily-game/mine${since ? `?since=${since}` : ""}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );

  it("refuses without a session — there is no 'my results' for nobody", async () => {
    const db = new TestD1();
    expect((await handleGetMine(mine(), env(db))).status).toBe(401);
  });

  it("hands back the day, the score AND the guess list, so another device redraws the board", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    await handlePostResult(post(solvedInThree(iso()), me.token), env(db));

    const body = await (await handleGetMine(mine(me.token), env(db))).json() as {
      results: Array<{
        date: string; guessCount: number; solved: boolean; score: number;
        guesses: number[]; types: number[];
      }>;
      stats: { currentStreak: number; totalScore: number; lastPlayedDate: string | null };
    };

    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      date: iso(), guessCount: 3, solved: true, score: 60,
    });
    // The whole point of migration 0033: the ids come back in the order they were guessed,
    // WITH their namespaces — an id alone cannot say film or show.
    expect(body.results[0].guesses).toEqual([111, 222, ANSWER_TMDB]);
    expect(body.results[0].types).toEqual([0, 1, 0]);
    expect(body.stats.totalScore).toBe(60);
    expect(body.stats.lastPlayedDate).toBe(iso());
  });

  it("is what stops a replay: the day comes back already finished", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    await handlePostResult(post(solvedInThree(iso()), me.token), env(db));

    // A second device asks before offering today's board.
    const body = await (await handleGetMine(mine(me.token), env(db))).json() as {
      results: Array<{ date: string }>;
    };
    expect(body.results.some((r) => r.date === iso())).toBe(true);
  });

  it("does not leak anyone else's rows", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const them = await player(db, 2);
    await handlePostResult(post(solvedInThree(iso()), them.token), env(db));

    const body = await (await handleGetMine(mine(me.token), env(db))).json() as {
      results: unknown[];
    };
    expect(body.results).toHaveLength(0);
  });

  it("clamps `since` to the verifiable window rather than trusting it", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    await handlePostResult(post(solvedInThree(iso(-2)), me.token), env(db));

    const body = await (await handleGetMine(mine(me.token, "1999-01-01"), env(db))).json() as {
      since: string;
      results: Array<{ date: string }>;
    };
    // Clamped to the backfill window, and the row inside it still comes back.
    expect(body.since > "1999-01-01").toBe(true);
    expect(body.results.some((r) => r.date === iso(-2))).toBe(true);
  });

  it("reads the rollup WITHOUT rewriting it", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    await handlePostResult(post(solvedInThree(iso()), me.token), env(db));

    const before = db.one<{ updated_at: number }>(
      "SELECT updated_at FROM daily_game_stats WHERE user_id = ?", me.id,
    );
    await handleGetMine(mine(me.token), env(db));
    const after = db.one<{ updated_at: number }>(
      "SELECT updated_at FROM daily_game_stats WHERE user_id = ?", me.id,
    );
    // A read on every launch must not become a write on every launch.
    expect(after!.updated_at).toBe(before!.updated_at);
  });
});

describe("guess types are additive, never trusted blindly", () => {
  const mine = (token: string) =>
    new Request("https://flickto.app/api/daily-game/mine", {
      headers: { Authorization: `Bearer ${token}` },
    });

  async function typesFor(payloadTypes: unknown): Promise<number[]> {
    const db = new TestD1();
    const me = await player(db, 1);
    await handlePostResult(
      post({ results: [{ date: iso(), guesses: [111, 222, ANSWER_TMDB], types: payloadTypes }] }, me.token),
      env(db),
    );
    const body = await (await handleGetMine(mine(me.token), env(db))).json() as {
      results: Array<{ types: number[] }>;
    };
    return body.results[0]?.types ?? [];
  }

  it("keeps a well-formed parallel array", async () => {
    expect(await typesFor([0, 1, 0])).toEqual([0, 1, 0]);
  });

  it("drops a WRONG-LENGTH array rather than pairing ids with the wrong namespace", async () => {
    expect(await typesFor([0, 1])).toEqual([]);
  });

  it("drops values that are not 0 or 1", async () => {
    expect(await typesFor([0, 7, 1])).toEqual([]);
  });

  it("accepts a submission with no types at all — old clients still count", async () => {
    expect(await typesFor(undefined)).toEqual([]);
  });
});

describe("leaderboard windows", () => {
  const board = (token: string, window?: string) =>
    new Request(
      `https://flickto.app/api/daily-game/leaderboard${window ? `?window=${window}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

  async function scores(window: string | undefined, days: number[]): Promise<number> {
    const db = new TestD1();
    const me = await player(db, 1);
    for (const d of days) {
      await handlePostResult(post(solvedInThree(iso(-d)), me.token), env(db));
    }
    const body = await (await handleGetLeaderboard(board(me.token, window), env(db))).json() as {
      entries: Array<{ score: number; isSelf: boolean }>;
    };
    return body.entries.find((e) => e.isSelf)?.score ?? 0;
  }

  // Solved-in-three is 60 points a day, so the totals below are day counts x 60.
  it("today counts TODAY only", async () => {
    expect(await scores("today", [0, 1, 2])).toBe(60);
  });

  it("week reaches back six days, not seven", async () => {
    expect(await scores("week", [0, 6])).toBe(120);
    expect(await scores("week", [7])).toBe(0);
  });

  it("month reaches back to day 29", async () => {
    expect(await scores("month", [0, 29])).toBe(120);
  });

  it("all time does not throw on a missing span, and counts everything", async () => {
    // `all` reads the lifetime rollup and has no `since`. Reading a span for it
    // unguarded threw RangeError and 500ed only this window.
    expect(await scores("all", [0, 29])).toBe(120);
  });

  it("falls back to week for a window it does not recognise", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    await handlePostResult(post(solvedInThree(iso()), me.token), env(db));
    const body = await (await handleGetLeaderboard(board(me.token, "fortnight"), env(db))).json() as {
      window: string;
    };
    expect(body.window).toBe("week");
  });
});
