import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inversions, orderScore } from "./dailyGame";

/**
 * The shared contract, read by BOTH implementations.
 *
 * flickto-web/lib/games/flickology.ts has its own copy of this arithmetic so the board can
 * show a score without a round trip, and flickto-web/test/gamesOrder.test.mjs pins it to
 * this same file. Drift between them is silent and the symptom is a score that changes on
 * reload, which is the cross-language failure mode the grading fixture already exists for.
 */
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "..", "..", "..", "docs", "game", "flickology-fixtures.json"), "utf8"),
) as {
  penaltyPerInversion: number;
  maxScore: number;
  cases: Array<{ name: string; correct: number[]; submitted: number[]; inversions: number; score: number }>;
};

describe("the shared Flickology contract", () => {
  it("has cases", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
  });

  it.each(fixture.cases)("$name", (c) => {
    const got = inversions(c.submitted, c.correct);
    expect(got, "inversions").toBe(c.inversions);
    expect(orderScore(got), "score").toBe(c.score);
  });

  it("uses the penalty the contract names", () => {
    expect(orderScore(0) - orderScore(1)).toBe(fixture.penaltyPerInversion);
    expect(orderScore(0)).toBe(fixture.maxScore);
  });
});

/**
 * Flickology's scoring.
 *
 * The measure has to have one property above all: a small mistake must cost a small
 * amount. That is why it counts INVERSIONS (pairs in the wrong order) rather than
 * misplaced cards -- moving one card in a run of five displaces every card after it, so
 * "cards in the wrong place" reports four for a near-perfect answer and four for a much
 * worse one, and the game stops rewarding getting closer.
 */

const CORRECT = [10, 20, 30, 40, 50];

describe("inversions measure distance, not misplacement", () => {
  it("is zero for the right order", () => {
    expect(inversions(CORRECT, CORRECT)).toBe(0);
  });

  it("is one for a single adjacent swap", () => {
    expect(inversions([20, 10, 30, 40, 50], CORRECT)).toBe(1);
  });

  it("is maximal for the exact reverse", () => {
    // Five items have ten pairs, and reversing puts every one of them the wrong way.
    expect(inversions([50, 40, 30, 20, 10], CORRECT)).toBe(10);
  });

  it("charges a card moved a long way more than one moved a little", () => {
    const nudged = inversions([10, 30, 20, 40, 50], CORRECT);
    const hurled = inversions([50, 10, 20, 30, 40], CORRECT);
    expect(nudged).toBe(1);
    expect(hurled).toBe(4);
    expect(hurled).toBeGreaterThan(nudged);
  });

  it("counts the same whichever end the mistake is at", () => {
    expect(inversions([20, 10, 30, 40, 50], CORRECT))
      .toBe(inversions([10, 20, 30, 50, 40], CORRECT));
  });
});

describe("the score falls off gently, and there is no losing", () => {
  it("pays full marks for a perfect order", () => {
    expect(orderScore(0)).toBe(100);
  });

  it("still pays well for one wrong pair", () => {
    expect(orderScore(1)).toBe(88);
  });

  it("never goes below nothing", () => {
    expect(orderScore(10)).toBe(0);
    expect(orderScore(50)).toBe(0);
  });

  it("is monotonic, so getting closer is always worth more", () => {
    for (let i = 1; i <= 10; i++) {
      expect(orderScore(i)).toBeLessThanOrEqual(orderScore(i - 1));
    }
  });
});
