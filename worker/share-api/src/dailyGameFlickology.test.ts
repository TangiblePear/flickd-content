import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { placesOut, maxPlacesOut, orderScore } from "./dailyGame";

/**
 * The shared contract, read by BOTH implementations.
 *
 * flickto-web/lib/games/flickology.ts has its own copy of this arithmetic so the board can
 * show a score without a round trip, and flickto-web/test/gamesFlickology.test.mjs pins it
 * to this same file. Drift between them is silent and the symptom is a score that changes
 * on reload, which is the cross-language failure mode the grading fixture already exists
 * for.
 */
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "..", "..", "..", "docs", "game", "flickology-fixtures.json"), "utf8"),
) as {
  maxPlacesOut: number;
  maxScore: number;
  cases: Array<{ name: string; correct: number[]; submitted: number[]; placesOut: number; score: number }>;
};

describe("the shared Flickology contract", () => {
  it("has cases", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
  });

  it.each(fixture.cases)("$name", (c) => {
    const got = placesOut(c.submitted, c.correct);
    expect(got, "places out").toBe(c.placesOut);
    expect(orderScore(got, c.correct.length), "score").toBe(c.score);
  });

  it("uses the scale the contract names", () => {
    expect(maxPlacesOut(5)).toBe(fixture.maxPlacesOut);
    expect(orderScore(0, 5)).toBe(fixture.maxScore);
    expect(orderScore(fixture.maxPlacesOut, 5)).toBe(0);
  });
});

/**
 * Flickology's scoring: how many places each card sits from where it belongs, summed.
 *
 * The measure has to have one property above all: a small mistake must cost a small
 * amount, and improving the board must never cost anything. That rules out counting
 * misplaced CARDS -- moving one card in a run of five shifts every card after it, so
 * "cards in the wrong place" reports four for a near-perfect answer and four for a much
 * worse one, and a player who fixes a mistake can watch their score fall.
 *
 * Summing distances has neither problem, which was checked exhaustively rather than
 * argued: across all 120 orderings of five cards and all 240 improving swaps, there is no
 * case where making the board better lowers the score. The monotonicity test below is the
 * cheap standing guard on that.
 */

const CORRECT = [10, 20, 30, 40, 50];

describe("places out measures distance, not misplacement", () => {
  it("is zero for the right order", () => {
    expect(placesOut(CORRECT, CORRECT)).toBe(0);
  });

  it("is two for a single adjacent swap -- one place each, for two cards", () => {
    expect(placesOut([20, 10, 30, 40, 50], CORRECT)).toBe(2);
  });

  it("is maximal for the exact reverse", () => {
    // 4 + 2 + 0 + 2 + 4. The middle card of an odd board cannot move.
    expect(placesOut([50, 40, 30, 20, 10], CORRECT)).toBe(12);
    expect(placesOut([50, 40, 30, 20, 10], CORRECT)).toBe(maxPlacesOut(5));
  });

  it("charges a card moved a long way more than one moved a little", () => {
    const nudged = placesOut([10, 30, 20, 40, 50], CORRECT);
    const hurled = placesOut([50, 10, 20, 30, 40], CORRECT);
    expect(nudged).toBe(2);
    // The card travels four places and drags four others one place each.
    expect(hurled).toBe(8);
    expect(hurled).toBeGreaterThan(nudged);
  });

  it("counts the same whichever end the mistake is at", () => {
    expect(placesOut([20, 10, 30, 40, 50], CORRECT))
      .toBe(placesOut([10, 20, 30, 50, 40], CORRECT));
  });

  it("is always even, which is what gives the board seven possible scores", () => {
    // A permutation moves cards past each other, so the distances must cancel out. This
    // is why the scale is 100/83/67/50/33/17/0 and not thirteen rungs.
    const perms: number[][] = [];
    const walk = (rest: number[], acc: number[]) => {
      if (rest.length === 0) return void perms.push(acc);
      rest.forEach((x, i) => walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
    };
    walk(CORRECT, []);
    expect(perms).toHaveLength(120);
    for (const p of perms) expect(placesOut(p, CORRECT) % 2).toBe(0);
    expect(new Set(perms.map((p) => orderScore(placesOut(p, CORRECT), 5))).size).toBe(7);
  });
});

describe("the score falls off gently, and there is no losing", () => {
  it("pays full marks for a perfect order", () => {
    expect(orderScore(0, 5)).toBe(6);
  });

  it("still pays well for the cheapest mistake", () => {
    expect(orderScore(2, 5)).toBe(5);
  });

  /*
   * ⚠️ The seven rungs, one at a time.
   *
   * The scale is six stars precisely BECAUSE there are seven reachable boards, so this is
   * the assertion that the fit is exact rather than approximately right: every even
   * places-out value takes its own star, and no two share one. A curve that rounded two
   * rungs onto the same star would still satisfy every other test in this file.
   */
  it("gives each of the seven reachable boards its own star", () => {
    expect([0, 2, 4, 6, 8, 10, 12].map((places) => orderScore(places, 5)))
      .toEqual([6, 5, 4, 3, 2, 1, 0]);
  });

  it("never goes below nothing", () => {
    expect(orderScore(12, 5)).toBe(0);
    expect(orderScore(50, 5)).toBe(0);
  });

  it("is monotonic, so getting closer is always worth more", () => {
    for (let i = 1; i <= 12; i++) {
      expect(orderScore(i, 5)).toBeLessThanOrEqual(orderScore(i - 1, 5));
    }
  });

  /**
   * ⚠️ The axiom that ruled out every other candidate scoring rule.
   *
   * Checked against the OTHER measure on purpose. Testing that the score rises as places
   * out falls would be tautological -- the score is a function of places out. What has to
   * hold is that the two ways of judging a board never contradict each other: whenever a
   * swap puts one more pair the right way round, the places-out score must not go DOWN.
   *
   * Every rejected candidate failed exactly here. Per-card points ladders (20 for an exact
   * placement, 12 for one place out, and so on) break it on roughly half of these 240
   * swaps, which is why the score is a flat sum of distances and not a table of rewards --
   * a player who fixes a mistake must never watch their score fall.
   */
  it("never pays less for a board that got one more pair the right way round", () => {
    const perms: number[][] = [];
    const walk = (rest: number[], acc: number[]) => {
      if (rest.length === 0) return void perms.push(acc);
      rest.forEach((x, i) => walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
    };
    walk(CORRECT, []);

    let checked = 0;
    for (const p of perms) {
      for (let i = 0; i < p.length - 1; i++) {
        // Swapping neighbours changes the pair count by exactly one, either way. This is
        // the direction where the board got BETTER by that measure.
        if (p[i] < p[i + 1]) continue;
        const q = [...p];
        [q[i], q[i + 1]] = [q[i + 1], q[i]];
        checked++;
        expect(
          orderScore(placesOut(q, CORRECT), 5),
          `${p.join(",")} -> ${q.join(",")}`,
        ).toBeGreaterThanOrEqual(orderScore(placesOut(p, CORRECT), 5));
      }
    }
    // 120 orderings x 4 adjacent positions = 480 swaps, exactly half of which improve.
    expect(checked).toBe(240);
  });

  it("scores the board that prompted this change at three of six", () => {
    // Shrinking, Luca, John Wick 2, Gone Girl, The Last Kingdom -- where The Last Kingdom
    // belongs second. One card three places from home, dragging three others one place.
    // Six of the twelve places available, so the middle rung: three stars.
    expect(placesOut([10, 30, 40, 50, 20], CORRECT)).toBe(6);
    expect(orderScore(6, 5)).toBe(3);
  });
});
