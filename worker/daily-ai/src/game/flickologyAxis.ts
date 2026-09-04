// Flickology's axis rules: which measures exist, which formats each one can compare, and
// how far apart five values have to be before a human can order them.
//
// Split out of the generator because it is the pure half and the half a change is most
// likely to get quietly wrong -- a gap that is too wide stops the axis publishing at all
// (runtime did, on 288 days in 300, and it looked like nothing), and one that is too
// narrow ships a coin toss. Nothing here touches R2, TMDB or the pool, so test/
// flickology.test.mjs can import it directly.

/**
 * The axis, rotating daily.
 *
 * Five different questions rather than one, which is what stops the game becoming "guess
 * the year" every morning. They reward genuinely different knowledge — a player who is
 * hopeless at ratings still has days they are good at — and two of them are single-format
 * on purpose, so a week of Flickology is not always the same mixed shelf of titles.
 *
 * ⚠️ The rotation is `puzzleNumber % AXES.length`, so ADDING an axis re-phases every
 * future day. That is only safe because a published day is never regenerated (see the
 * early return on `existing?.date`) — days already in R2 keep the axis they were built
 * with, and their answer files are what grading reads.
 */
export const AXES = ["year", "rating", "runtime", "episodes", "revenue"] as const;
export type Axis = (typeof AXES)[number];

/** PoolEntry.type. 0 = film, 1 = show. */
export const TYPE_MOVIE = 0;
export const TYPE_SHOW = 1;

/**
 * Which axes are single-format, and why.
 *
 * ⚠️ Not a preference. Each of these is a measure the other format does not have in
 * comparable units:
 *
 *   runtime  — MOVIES. A show's runtime in the pool is its EPISODE length, so a 22-minute
 *              sitcom against a 169-minute film is a format question wearing the same
 *              units. "Shortest first" has no honest answer across the two.
 *   episodes — SHOWS. A film has one.
 *   revenue  — MOVIES. TMDB records box office for films; for shows the field is absent,
 *              and a series' "revenue" is not a public number anyway.
 *
 * Year and rating are directly comparable between the two, so they keep both formats.
 */
export const FORMAT: Partial<Record<Axis, number>> = {
  runtime: TYPE_MOVIE,
  episodes: TYPE_SHOW,
  revenue: TYPE_MOVIE,
};

/**
 * The axes whose value is NOT in the pool and has to be fetched per title.
 *
 * The pool carries year, rating and runtime for all 1,600 titles because the build script
 * gets them free from the catalogue. Episode counts and box office are neither in it nor
 * worth putting in it: 1,600 extra calls every rebuild to feed two axes that come round
 * once every five days and use five titles each. So these are fetched for a SHORTLIST,
 * after the candidates are already chosen. See enrich().
 */
export const ON_DEMAND: Partial<Record<Axis, "episodes" | "revenue">> = {
  episodes: "episodes",
  revenue: "revenue",
};

/** How many candidates to look up before trying to find a spread set among them. */
export const SHORTLIST = 42;

/**
 * How far apart consecutive values must be for the set to be answerable.
 *
 * Tuned per axis because the units are not comparable: eight years is a era apart, eight
 * tenths of a rating point is the difference between "well liked" and "loved", and eight
 * minutes of runtime is nothing at all.
 *
 * ⚠️ Runtime came down from 22 when the axis became films-only, and the reason is worth
 * keeping: 22 was only ever satisfiable BECAUSE shows were in the mix. A show's runtime is
 * its episode length, so a 22-minute sitcom beside a 169-minute film cleared the gap
 * trivially — the axis was propped up by exactly the comparison that made it unfair.
 *
 * Films alone cluster hard around 100-130 minutes. Measured over 300 simulated days
 * against the real pool: at 22 the generator fails to find a set on 288 of them and at 18
 * on 218, which is an axis that mostly does not publish. At 12 it fails on none, with a
 * median of 45 attempts out of 400. Stratifying the sample across runtime quantiles was
 * tried and is WORSE at every gap — it forces picks onto bucket boundaries, which are
 * adjacent by construction.
 */
export const MIN_GAP: Record<Axis, number> = { year: 7, rating: 6, runtime: 12, episodes: 0, revenue: 0 };

/**
 * The axes where the gap is a RATIO, not a difference.
 *
 * ⚠️ A fixed step is meaningless on a scale that spans four orders of magnitude. Episode
 * counts run from 6 to well past 700 and box office from a few hundred thousand to nearly
 * three billion, so "at least 40 episodes apart" is an era apart at the bottom of the
 * range and indistinguishable at the top — 512 against 552 is not something anyone knows.
 * A multiple is the same question everywhere on the scale: each title must have at least
 * half again as many episodes, or half again the takings, as the one below it.
 */
export const MIN_RATIO: Partial<Record<Axis, number>> = { episodes: 1.5, revenue: 1.5 };

/**
 * Whether a set is orderable by a human.
 *
 * Sorted first, then every ADJACENT pair must clear the gap. Checking only the outer two
 * would pass a set of four titles from 2014 and one from 1975, which is one easy card and
 * four coin tosses.
 */
export function isSpread(values: number[], axis: Axis): boolean {
  const sorted = values.slice().sort((a, b) => a - b);
  const ratio = MIN_RATIO[axis];
  for (let i = 1; i < sorted.length; i++) {
    if (ratio !== undefined) {
      // A zero would make every ratio infinite and pass a set nobody can order. The
      // candidate filter drops them, and this is the second line of that.
      if (sorted[i - 1] <= 0) return false;
      if (sorted[i] / sorted[i - 1] < ratio) return false;
    } else if (sorted[i] - sorted[i - 1] < MIN_GAP[axis]) {
      return false;
    }
  }
  return true;
}
