import { describe, it, expect } from "vitest";
import { TestD1, seedUser, testEnv, uid } from "./testD1";
import { readDistribution } from "./dailyGame";

/**
 * "How everyone did", per game.
 *
 * ## The bug this exists for
 *
 * readDistribution summed two halves. The anonymous half called `bucketFor`. The signed-in
 * half bucketed IN SQL, as `CASE WHEN solved = 1 THEN guess_count ELSE 0 END` -- which is
 * the guessing games' rule, written out by hand and applied to all five games.
 *
 * FlickGrid and Flickology do not use that rule. They have no losing state, so they bucket
 * on their own headline number regardless of `solved`, and under the SQL rule every one of
 * their signed-in rows collapsed into bucket 0. What a player saw was a chart that
 * highlighted the correct bar for their score and drew it EMPTY -- their result had been
 * counted, just into a bucket nobody was looking at.
 *
 * ⚠️ Nothing threw and no row went missing, so only a test that reads the SHAPE of the
 * distribution catches it. Rows are seeded directly rather than posted: the point is what
 * comes back OUT of the query, and routing a submission through verify() to get there
 * would need a grid spec and a title index for a claim that has nothing to do with either.
 *
 * Real SQLite via TestD1, so the query under test is the one that will run.
 */

const DATE = "2026-09-04";

function seedResult(
  db: TestD1,
  n: number,
  game: string,
  guessCount: number,
  solved: boolean,
): void {
  const id = uid(n);
  seedUser(db, { id, displayName: `Player ${n}` });
  db.prepare(
    `INSERT INTO daily_game_results
       (user_id, game, date, puzzle_number, guess_count, solved, score, created_at, guesses, guess_types)
     VALUES (?, ?, ?, 1, ?, ?, 0, ?, '[]', '[]')`,
  ).bind(id, game, DATE, guessCount, solved ? 1 : 0, Date.now()).run();
}

const env = (db: TestD1) => testEnv(db);

describe("a signed-in result lands in the bucket its own game uses", () => {
  it("buckets a Flickology board on places out, not on whether it was perfect", async () => {
    const db = new TestD1();
    // Four places out. Not perfect, so `solved` is 0 -- which under the old SQL rule sent
    // it to bucket 0, the bucket that means a PERFECT order for this game.
    seedResult(db, 1, "flickology", 4, false);

    const dist = await readDistribution(env(db), "flickology", DATE);

    expect(dist.total).toBe(1);
    expect(dist.buckets[4]).toBe(1);
    expect(dist.buckets[0]).toBe(0);
  });

  it("buckets a FlickGrid board on squares placed right", async () => {
    const db = new TestD1();
    seedResult(db, 1, "flickgrid", 6, false);
    seedResult(db, 2, "flickgrid", 9, true);

    const dist = await readDistribution(env(db), "flickgrid", DATE);

    expect(dist.total).toBe(2);
    expect(dist.buckets[6]).toBe(1);
    expect(dist.buckets[9]).toBe(1);
    expect(dist.buckets[0]).toBe(0);
  });

  /*
   * ⚠️ The regression in one line.
   *
   * Every one of these boards scored differently and none of them was perfect, so under
   * the old rule all four stacked into bucket 0 and the chart showed a single bar reading
   * "everyone got a perfect order" -- while each of those four players was told their own
   * bucket held nothing.
   */
  it("spreads a day of imperfect Flickology boards across the axis", async () => {
    const db = new TestD1();
    [2, 4, 6, 8].forEach((places, i) => seedResult(db, i + 1, "flickology", places, false));

    const dist = await readDistribution(env(db), "flickology", DATE);

    expect(dist.total).toBe(4);
    expect([0, 2, 4, 6, 8].map((b) => dist.buckets[b])).toEqual([0, 1, 1, 1, 1]);
  });
});

describe("the guessing games keep the ladder they always had", () => {
  it("buckets a solved round on its guess count", async () => {
    const db = new TestD1();
    seedResult(db, 1, "flickreel", 3, true);

    const dist = await readDistribution(env(db), "flickreel", DATE);

    expect(dist.buckets[3]).toBe(1);
    expect(dist.buckets[0]).toBe(0);
  });

  it("sends an UNSOLVED round to bucket 0, whatever it spent getting there", async () => {
    const db = new TestD1();
    seedResult(db, 1, "flickreel", 6, false);

    const dist = await readDistribution(env(db), "flickreel", DATE);

    // The X row. Six guesses and no answer is not "solved on six".
    expect(dist.buckets[0]).toBe(1);
    expect(dist.buckets[6]).toBe(0);
  });
});

describe("the halves stay separate", () => {
  it("sums the anonymous counter into the same buckets", async () => {
    const db = new TestD1();
    seedResult(db, 1, "flickology", 4, false);
    db.prepare(
      `INSERT INTO daily_game_anon_distribution (game, date, guess_count, count)
       VALUES (?, ?, ?, ?)`,
    ).bind("flickology", DATE, 4, 7).run();

    const dist = await readDistribution(env(db), "flickology", DATE);

    expect(dist.buckets[4]).toBe(8);
    expect(dist.total).toBe(8);
  });

  it("counts only the game it was asked about", async () => {
    const db = new TestD1();
    seedResult(db, 1, "flickology", 4, false);
    seedResult(db, 2, "flickgrid", 4, false);

    expect((await readDistribution(env(db), "flickology", DATE)).total).toBe(1);
    expect((await readDistribution(env(db), "flickgrid", DATE)).total).toBe(1);
  });
});
