// The spread rule, which is what decides whether a Flickology board is a puzzle or a
// five-sided coin toss.
//
// Two shapes of gap, and the reason is the scale:
//
//   year / rating / runtime   a DIFFERENCE. Seven years is seven years anywhere on the
//                             axis, and a film is never eight times older than another.
//   episodes / revenue        a RATIO. These span four orders of magnitude, so a fixed
//                             step is an era apart at the bottom and invisible at the
//                             top -- 512 episodes against 552 is not something anyone
//                             knows, while 12 against 52 plainly is.
//
// Run: npm test  (from worker/daily-ai)
import { isSpread } from "../src/game/flickologyAxis.ts";

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("pass", name);
};

// ── The difference axes ──────────────────────────────────────────────────────

ok("year: an era apart passes", isSpread([1975, 1988, 1999, 2010, 2021], "year"));
ok("year: two films four months apart fails", !isSpread([1975, 1988, 1999, 2010, 2010], "year"));
ok(
  "year: the OUTER pair being wide does not excuse a cluster inside it",
  !isSpread([1975, 2014, 2015, 2016, 2021], "year"),
);
ok("year: order of the input does not matter", isSpread([2021, 1975, 2010, 1988, 1999], "year"));
// Ratings are tenths, so six is 0.6 of a point.
ok("rating: 0.6 apart passes", isSpread([61, 67, 73, 79, 85], "rating"));
ok("rating: half a point apart fails", !isSpread([61, 66, 73, 79, 85], "rating"));
ok("runtime: twelve minutes apart passes", isSpread([94, 106, 118, 133, 150], "runtime"));
ok("runtime: the 100-130 cluster fails", !isSpread([98, 104, 112, 121, 133], "runtime"));

// ── The ratio axes ───────────────────────────────────────────────────────────

ok("episodes: each half again as many passes", isSpread([8, 13, 22, 40, 88], "episodes"));
// The whole reason this axis is a ratio: ONE fixed step, two verdicts.
ok(
  "episodes: 40 apart passes near the bottom of the range",
  isSpread([6, 46, 86], "episodes"),
  "40 apart is a format apart at 6",
);
ok(
  "episodes: the SAME 40 apart fails near the top",
  !isSpread([440, 480, 520], "episodes"),
  "40 apart is nothing at 500",
);
ok("episodes: 1.4x is under the bar", !isSpread([10, 14, 22, 40, 88], "episodes"));

const M = 1_000_000;
ok(
  "revenue: an order of magnitude across the set passes",
  isSpread([12 * M, 60 * M, 180 * M, 400 * M, 1200 * M], "revenue"),
);
ok(
  "revenue: two blockbusters within 20% of each other fails",
  !isSpread([12 * M, 60 * M, 180 * M, 1000 * M, 1200 * M], "revenue"),
);

// ⚠️ A zero would make every ratio against it infinite, and would pass a set nobody can
// order. fetchTitleFigure drops these before they reach here; this is the second line.
ok("revenue: a zero fails rather than passing trivially", !isSpread([0, 60 * M, 180 * M, 400 * M, 1200 * M], "revenue"));
ok("episodes: a zero fails", !isSpread([0, 13, 22, 40, 88], "episodes"));

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
