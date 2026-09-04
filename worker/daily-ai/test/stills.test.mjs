// The reel must not show the same shot twice.
//
// TMDB galleries arrive in batches from a single scene — several frames of one close-up,
// seconds apart. Every one carries zero votes, so sorting by vote puts them TOGETHER, and
// the old code took its six frames from exactly that end of the list. A round then spent
// three guesses showing what was effectively one picture.
//
// Dedupe cannot catch it: the file paths genuinely differ. What can is that a batch is
// ADJACENT in TMDB's own ordering — so the six are sampled across that order first, and
// only ranked by vote afterwards.
//
// Run: npm test  (from worker/daily-ai)
import { spread, pickStills } from "../src/game/stills.ts";

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("pass", name);
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const range = (n) => Array.from({ length: n }, (_, i) => i);

// ── the sampler ──
eq("takes both ends and spaces the middle", spread(range(40), 6), [0, 8, 16, 23, 31, 39]);
eq("a gallery of exactly twice the reel still spaces", spread(range(12), 6), [0, 2, 4, 7, 9, 11]);
for (const n of [12, 13, 17, 20, 31, 40, 77, 120]) {
  const got = spread(range(n), 6);
  ok(`n=${n}: six, distinct, both ends`,
    got.length === 6 && new Set(got).size === 6 && got[0] === 0 && got[5] === n - 1,
    JSON.stringify(got));
}

// ── the real thing: a batch of identical frames, all unvoted ──
// Eight frames of one scene uploaded together, then eight distinct frames that people
// actually voted on. This is the shape the Morbius reel had.
const img = (scene, vote) => ({ file_path: `/${scene}.jpg`, vote_average: vote, vote_count: vote ? 9 : 0 });
const gallery = [
  ...Array.from({ length: 8 }, () => img("same-scene", 0)),
  ...["b", "c", "d", "e", "f", "g", "h", "i"].map((n, i) => img(n, 5 + i)),
];
const picked = pickStills(gallery, 6);
const scenes = picked.map((p) => p.file_path);

ok("six frames", picked.length === 6, String(picked.length));

/*
 * ⚠️ This asserts a REDUCTION, not a guarantee, and the difference is the honest part.
 *
 * Sampling across the gallery steps over a batch; it cannot step over one that occupies
 * half the gallery, because any even spread of six across sixteen lands three times in
 * the first eight. Half of a title's usable stills being one scene is the pathological
 * case, and the only thing that would truly settle it is comparing the images —
 * perceptual hashing at generation time, which is a real option if this recurs and is not
 * worth a cron fetching and decoding a hundred JPEGs a day on a maybe.
 *
 * What IS guaranteed: strictly better than sorting first, which took all six from the
 * batch, and correct on the realistic shape tested below.
 */
ok("far fewer from the batch than the old order took",
  scenes.filter((p) => p === "/same-scene.jpg").length <= 3, JSON.stringify(scenes));
ok("the ramp survives: ascending by vote, iconic last",
  picked.every((p, i) => i === 0 || (p.vote_average ?? 0) >= (picked[i - 1].vote_average ?? 0)),
  JSON.stringify(picked.map((p) => p.vote_average)));

// ⚠️ Sorting FIRST is the bug, and this is what it looked like. Kept as a demonstration
// that the ordering of the two steps is the whole fix, not an incidental detail.
const sortedFirst = gallery.slice()
  .sort((a, b) => (a.vote_average ?? 0) - (b.vote_average ?? 0))
  .slice(0, 6)
  .map((p) => p.file_path);
ok("the old order really did produce a reel of one shot",
  sortedFirst.filter((p) => p === "/same-scene.jpg").length === 6, JSON.stringify(sortedFirst));

// ── the realistic shape ──
// A batch of three or four from one scene inside a gallery of twenty is what this
// actually meets, and there it does settle it.
{
  const real = [
    ...["a", "b", "c"].map((n, i) => img(n, 6 + i)),
    ...Array.from({ length: 4 }, () => img("batch", 0)),
    ...["d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p"].map((n, i) => img(n, 1 + i)),
  ];
  const got = pickStills(real, 6).map((p) => p.file_path);
  ok("a four-frame batch inside twenty contributes at most one",
    got.filter((p) => p === "/batch.jpg").length <= 1, JSON.stringify(got));
  ok("...and every frame shown is a different file",
    new Set(got).size === 6, JSON.stringify(got));
}

// A title with barely enough is passed through rather than mangled; MIN_USABLE is what
// stops one being chosen at all.
eq("a gallery no bigger than the reel is returned whole", spread(range(6), 6), [0, 1, 2, 3, 4, 5]);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exitCode = fails ? 1 : 0;
