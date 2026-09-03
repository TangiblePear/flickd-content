import { describe, it, expect } from "vitest";
import { TestD1, seedSession, seedUser, testEnv, uid } from "./testD1";
import {
  handleGetDistribution,
  handleGetFriendsDay,
  handleGetLeaderboard,
  handleGetMine,
  handlePostResult,
} from "./dailyGame";

/**
 * The suite dimension: migration 0052 and the `game` column.
 *
 * dailyGame.test.ts pins the behaviour of ONE game. This pins that there are five, which
 * is a different claim and fails in different places -- almost all of them silently. The
 * failure this suite exists for is a query that forgets its `AND game = ?`: nothing throws,
 * no row goes missing, the numbers are just quietly summed across games. And a stats object
 * zeroed by an unbound parameter looks exactly like a player who has not played.
 *
 * Real SQLite via TestD1, so the migration under test is the one that will run.
 */

const DAY = 86_400_000;
const iso = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

const ANSWER_TMDB = 550;

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The answer bucket, keyed by FULL R2 key rather than by date.
 *
 * dailyGame.test.ts's double strips the prefix and reads what is left as a date, which
 * cannot express the namespaced layout -- `game-state/answers/reel/2026-01-01.json` would
 * parse as a date of "reel/2026-01-01" and miss. Keying on the whole path is what lets this
 * suite assert that Flickdl reads the FLAT key and every other game reads its own.
 */
function answerBucket() {
  const map: Record<string, { tmdbId: number; puzzleNumber: number }> = {};
  for (let i = 0; i < 45; i++) {
    map[`game-state/answers/${iso(-i)}.json`] = { tmdbId: ANSWER_TMDB, puzzleNumber: 1000 - i };
    for (const game of ["reel", "order", "grid", "link"]) {
      map[`game-state/answers/${game}/${iso(-i)}.json`] = { tmdbId: ANSWER_TMDB, puzzleNumber: 500 - i };
    }
  }
  return {
    async get(key: string) {
      const hit = map[key];
      if (!hit) return null;
      return { async json() { return { date: key, title: "Fight Club", ...hit }; } };
    },
  };
}

const env = (db: TestD1) => testEnv(db, { CONTENT_BUCKET: answerBucket() });

const post = (body: unknown, token?: string) =>
  new Request("https://flickto.app/api/daily-game/result", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

const get = (path: string, token?: string) =>
  new Request(`https://flickto.app/api/daily-game/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

async function player(db: TestD1, n: number) {
  const id = uid(n);
  seedUser(db, { id, displayName: `Player ${n}` });
  const token = `token-${n}`;
  seedSession(db, id, await hash(token));
  return { id, token };
}

function befriend(db: TestD1, a: string, b: string) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  db.prepare(
    "INSERT INTO friendships (user_a, user_b, state, requested_by, created_at, updated_at) VALUES (?, ?, 'accepted', ?, ?, ?)",
  ).bind(lo, hi, a, Date.now(), Date.now()).run();
}

/** Solved on guess 3. */
const solvedInThree = (date: string, game?: string) => ({
  ...(game ? { game } : {}),
  results: [{ date, guesses: [111, 222, ANSWER_TMDB], types: [0, 1, 0] }],
});

describe("a request that names no game is Flickdl", () => {
  it("stores the shipped app's gameless submission as flickdl", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    // The SHIPPED Android build predates the suite and posts exactly this shape.
    const res = await handlePostResult(post(solvedInThree(iso()), me.token), env(db));
    expect(res.status).toBe(200);

    const row = db.one<{ game: string; score: number }>(
      "SELECT game, score FROM daily_game_results WHERE user_id = ?",
      me.id,
    );
    expect(row).toEqual({ game: "flickdl", score: 60 });
  });

  it("refuses a game it has never heard of rather than storing it", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(post(solvedInThree(iso(), "sudoku"), me.token), env(db));
    expect(res.status).toBe(400);
    expect(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM daily_game_results")).toEqual({ n: 0 });
  });
});

describe("games do not collide", () => {
  it("keeps one row per game per day, not one row per day", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    await handlePostResult(post(solvedInThree(iso()), me.token), env(db));
    await handlePostResult(post(solvedInThree(iso(), "reel"), me.token), env(db));

    const rows = db.rows<{ game: string }>(
      "SELECT game FROM daily_game_results WHERE user_id = ? AND date = ? ORDER BY game",
      me.id, iso(),
    );
    expect(rows.map((r) => r.game)).toEqual(["flickdl", "reel"]);
  });

  it("still lets the FIRST submission of one game and day win", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    await handlePostResult(post(solvedInThree(iso(), "reel"), me.token), env(db));
    // A second, better attempt at the same game and day must not improve the score.
    await handlePostResult(
      post({ game: "reel", results: [{ date: iso(), guesses: [ANSWER_TMDB], types: [0] }] }, me.token),
      env(db),
    );

    const row = db.one<{ score: number; guess_count: number }>(
      "SELECT score, guess_count FROM daily_game_results WHERE user_id = ? AND game = 'reel'",
      me.id,
    );
    expect(row).toEqual({ score: 60, guess_count: 3 });
  });

  it("reads each game's answer from its OWN key, and Flickdl's from the flat one", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    // The puzzle numbers differ per namespace in the double, so the number that lands
    // says which file was actually read.
    // `reel`, deliberately. Flickdl and Reel are the only games left on the default
    // "the last guess is the answer" semantics -- Chronology, the Grid and Flicklink each
    // have their own verifier and their own answer shape, so none of them can stand in
    // for "a game that reads a namespaced answer file".
    await handlePostResult(post(solvedInThree(iso()), me.token), env(db));
    await handlePostResult(post(solvedInThree(iso(), "reel"), me.token), env(db));

    const rows = db.rows<{ game: string; puzzle_number: number }>(
      "SELECT game, puzzle_number FROM daily_game_results WHERE user_id = ? ORDER BY game", me.id,
    );
    expect(rows).toEqual([
      { game: "flickdl", puzzle_number: 1000 },
      { game: "reel", puzzle_number: 500 },
    ]);
  });
});

describe("picks are bounded per game", () => {
  const nine = [1, 2, 3, 4, 5, 6, 7, 8, ANSWER_TMDB];

  it("lets nine picks through the payload bound for a Grid", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    // Rejected at VERIFICATION (no grid spec in this suite's answer double), not at
    // parsing -- which is the distinction being pinned. A Flickdl round of the same
    // length never reaches the verifier at all; see the next test.
    const res = await handlePostResult(
      post({ game: "grid", results: [{ date: iso(), guesses: nine }] }, me.token), env(db),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unverified" });
  });

  it("refuses those same nine as a Flickdl round", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(
      post({ game: "flickdl", results: [{ date: iso(), guesses: nine }] }, me.token), env(db),
    );
    expect(res.status).toBe(400);
  });

  it("still takes the SIXTH guess from a six-guess Flickdl client", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(
      post({ results: [{ date: iso(), guesses: [1, 2, 3, 4, 5, ANSWER_TMDB] }] }, me.token), env(db),
    );
    expect(res.status).toBe(200);
    // The legacy ladder: a solve on six is worth 15, not nothing.
    expect(db.one<{ score: number }>("SELECT score FROM daily_game_results")).toEqual({ score: 15 });
  });
});

describe("every read is scoped to one game", () => {
  it("keeps the rollups apart, so one game's score is not the other's", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    await handlePostResult(post(solvedInThree(iso()), me.token), env(db));           // 60
    await handlePostResult(post(solvedInThree(iso(-1)), me.token), env(db));         // 60
    await handlePostResult(post(solvedInThree(iso(), "reel"), me.token), env(db));   // 60

    type Mine = { results: unknown[]; stats: { totalScore: number; played: number } };
    const flickdl = await (await handleGetMine(get("mine", me.token), env(db))).json() as Mine;
    const reel = await (await handleGetMine(get("mine?game=reel", me.token), env(db))).json() as Mine;

    expect(flickdl.results).toHaveLength(2);
    expect(flickdl.stats).toMatchObject({ totalScore: 120, played: 2 });
    expect(reel.results).toHaveLength(1);
    expect(reel.stats).toMatchObject({ totalScore: 60, played: 1 });
  });

  it("counts each game's distribution separately, anonymous half included", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    await handlePostResult(post(solvedInThree(iso()), me.token), env(db));
    await handlePostResult(post(solvedInThree(iso(), "reel"), me.token), env(db));
    await handlePostResult(post(solvedInThree(iso(), "reel")), env(db));  // anonymous

    type Dist = { buckets: number[]; total: number };
    const flickdl = await (await handleGetDistribution(get(`distribution?date=${iso()}`), env(db))).json() as Dist;
    const reel = await (await handleGetDistribution(get(`distribution?date=${iso()}&game=reel`), env(db))).json() as Dist;

    expect(flickdl.total).toBe(1);
    expect(reel.total).toBe(2);
    // Bucket 3 is "solved on the third guess" in both.
    expect(flickdl.buckets[3]).toBe(1);
    expect(reel.buckets[3]).toBe(2);
  });

  it("ranks within a game on BOTH board shapes", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const friend = await player(db, 2);
    befriend(db, me.id, friend.id);

    // I play Flickdl, they play Reel. Neither belongs on the other's board.
    await handlePostResult(post(solvedInThree(iso()), me.token), env(db));
    await handlePostResult(post(solvedInThree(iso(), "reel"), friend.token), env(db));

    type Board = { entries: Array<{ userId: string }> };
    // `week` reads daily_game_results (the ?3 shape); `all` reads daily_game_stats (?2).
    // Both are built by boardQuery, whose binds no static check can verify.
    for (const window of ["week", "all"]) {
      const flickdl = await (await handleGetLeaderboard(
        get(`leaderboard?window=${window}`, me.token), env(db))).json() as Board;
      const reel = await (await handleGetLeaderboard(
        get(`leaderboard?window=${window}&game=reel`, me.token), env(db))).json() as Board;

      expect(flickdl.entries.map((e) => e.userId), `flickdl/${window}`).toEqual([me.id]);
      expect(reel.entries.map((e) => e.userId), `reel/${window}`).toEqual([friend.id]);
    }
  });

  it("shows a friend's result for the game asked about, not another one", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const friend = await player(db, 2);
    befriend(db, me.id, friend.id);

    await handlePostResult(post(solvedInThree(iso(), "reel"), friend.token), env(db));

    type Day = { friends: unknown[] };
    const flickdl = await (await handleGetFriendsDay(
      get(`friends?date=${iso()}`, me.token), env(db))).json() as Day;
    const reel = await (await handleGetFriendsDay(
      get(`friends?date=${iso()}&game=reel`, me.token), env(db))).json() as Day;

    expect(flickdl.friends).toHaveLength(0);
    expect(reel.friends).toHaveLength(1);
  });

  it("counts a streak per game, so missing one does not break the other", async () => {
    const db = new TestD1();
    const me = await player(db, 1);

    for (const d of [0, -1, -2]) {
      await handlePostResult(post(solvedInThree(iso(d)), me.token), env(db));
    }
    await handlePostResult(post(solvedInThree(iso(), "reel"), me.token), env(db));

    const rows = db.rows<{ game: string; current_streak: number }>(
      "SELECT game, current_streak FROM daily_game_stats WHERE user_id = ? ORDER BY game", me.id,
    );
    expect(rows).toEqual([
      { game: "flickdl", current_streak: 3 },
      { game: "reel", current_streak: 1 },
    ]);
  });
});
