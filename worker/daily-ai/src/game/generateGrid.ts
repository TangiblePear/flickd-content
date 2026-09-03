/**
 * Generates the day's Grid puzzle and publishes it.
 *
 * Nine squares, nine picks, and the rarer your answer the better.
 *
 * ## The only bug that really matters here is a dead cell
 *
 * If a square has no valid answer, the player cannot tell that from their own ignorance.
 * They stare at it, fail, and conclude they are bad at the game. So this does not choose
 * six constraints and hope: it counts, for every one of the nine intersections, how many
 * titles in the pool actually qualify, and throws the whole grid away if any cell is
 * thinner than CELL_FLOOR.
 *
 * That check also does the work a hand-written "don't put two decades on both axes" rule
 * would do, and it does it without anyone having to think of the cases -- a 1990s row
 * crossed with a 2010s column simply counts zero and the grid is rejected.
 *
 * ## Counted against the POOL, answered from the INDEX
 *
 * The floor is measured over the 2,500-title pool, while the player may name any of the
 * ~31,000 in the published index. That is deliberately conservative: a cell with twelve
 * well-known answers has far more real ones, so the check errs towards "too easy to
 * verify" rather than towards a square nobody can fill.
 *
 *   content/game/grid/latest.json        public, TODAY only
 *   game-state/answers/grid/{date}.json  PRIVATE, carries the constraints for verifyGrid
 */
import { POOL, type PoolEntry } from "./pool";
import { obfuscatePayload, KEY_VERSION } from "./obfuscate";

export interface GridEnv {
  CONTENT_BUCKET: R2Bucket;
}

const LATEST_KEY = "content/game/grid/latest.json";
const ANSWER_PREFIX = "game-state/answers/grid/";
const TITLE_INDEX = "titles.v2.json";
const EPOCH_DATE = "2026-09-03";
const ANSWER_RETENTION_DAYS = 40;

/** How many pool titles a square needs before it counts as fillable. */
const CELL_FLOOR = 8;
const MAX_ATTEMPTS = 600;

export type Constraint =
  | { kind: "decade"; decade: number }
  | { kind: "genre"; slug: string }
  | { kind: "minRating"; tenths: number }
  | { kind: "type"; type: number };

/**
 * MUST match GENRE_SLUGS everywhere else -- catalogMeta.ts, GenreBitmask.kt, the web's
 * oneTake.ts and share-api's gridRules.ts. Append-only; the bit index IS the contract.
 */
const GENRE_SLUGS = [
  "action", "adventure", "animation", "comedy", "crime", "documentary", "drama",
  "family", "fantasy", "history", "horror", "music", "mystery", "romance",
  "science-fiction", "tv-movie", "thriller", "war", "western", "children",
  "news", "reality", "soap", "talk-show", "anime",
  "donghua", "game-show", "holiday", "musical", "short", "special-interest", "superhero", "suspense",
];

/** ⚠️ BigInt: the vocabulary reaches bit 32 and JS bitwise operators are 32-bit SIGNED. */
function hasGenre(genreMask: number, slug: string): boolean {
  const bit = GENRE_SLUGS.indexOf(slug);
  if (bit < 0) return false;
  return (BigInt(genreMask) & (1n << BigInt(bit))) !== 0n;
}

export function satisfies(entry: PoolEntry, c: Constraint): boolean {
  switch (c.kind) {
    case "decade": return Math.floor(entry.year / 10) * 10 === c.decade;
    case "genre": return hasGenre(entry.genreMask, c.slug);
    case "minRating": return entry.ratingTenths > 0 && entry.ratingTenths >= c.tenths;
    case "type": return entry.type === c.type;
  }
}

/**
 * The menu.
 *
 * Deliberately narrow. Every constraint here is something a person can hold in their head
 * while thinking of a film -- "a 90s one", "science fiction", "a series". A grid of
 * obscure axes is not harder, it is just slower.
 *
 * ⚠️ No runtime constraints. Runtime is not in the published title index, so neither the
 * client nor the worker can check one against a guess; both sides return false for those
 * kinds, which would make any such cell permanently unfillable.
 */
const DECADES: Constraint[] = [1980, 1990, 2000, 2010, 2020].map((decade) => ({ kind: "decade", decade }));
const GENRES: Constraint[] = [
  "action", "comedy", "crime", "drama", "fantasy", "horror",
  "mystery", "romance", "science-fiction", "thriller", "animation", "adventure",
].map((slug) => ({ kind: "genre", slug }));
const RATINGS: Constraint[] = [75, 80, 85].map((tenths) => ({ kind: "minRating", tenths }));
const TYPES: Constraint[] = [{ kind: "type", type: 0 }, { kind: "type", type: 1 }];

const MENU: Constraint[] = [...DECADES, ...GENRES, ...RATINGS, ...TYPES];

const keyOf = (c: Constraint): string =>
  c.kind === "decade" ? `decade:${c.decade}`
  : c.kind === "genre" ? `genre:${c.slug}`
  : c.kind === "minRating" ? `rating:${c.tenths}`
  : `type:${c.type}`;

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86_400_000,
  );
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try { return (await obj.json()) as T; } catch { return null; }
}

async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * How many pool titles fill every square, or null if any of them is too thin.
 *
 * Returns early on the first dead cell. With a floor of eight and a menu this wide most
 * random grids fail, so bailing on the first bad intersection rather than counting all
 * nine is the difference between hundreds of attempts being cheap and being slow.
 */
export function cellCounts(
  rows: Constraint[],
  cols: Constraint[],
  pool: PoolEntry[],
  floor: number,
): number[] | null {
  const counts: number[] = [];
  for (const row of rows) {
    for (const col of cols) {
      let n = 0;
      for (const entry of pool) {
        if (satisfies(entry, row) && satisfies(entry, col)) n++;
      }
      if (n < floor) return null;
      counts.push(n);
    }
  }
  return counts;
}

type GridPuzzle = {
  schemaVersion: 1;
  keyVersion: number;
  puzzleNumber: number;
  date: string;
  titleIndex: string;
  rows: Constraint[];
  cols: Constraint[];
};

function envelope(puzzle: GridPuzzle) {
  const { schemaVersion, keyVersion, ...secret } = puzzle;
  return { schemaVersion, keyVersion, date: puzzle.date, p: obfuscatePayload(secret) };
}

async function pruneAnswers(bucket: R2Bucket, todayIso: string): Promise<number> {
  const listed = await bucket.list({ prefix: ANSWER_PREFIX, limit: 1000 });
  let removed = 0;
  for (const obj of listed.objects) {
    const date = obj.key.slice(ANSWER_PREFIX.length).replace(/\.json$/, "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (daysBetween(date, todayIso) > ANSWER_RETENTION_DAYS) {
      await bucket.delete(obj.key);
      removed++;
    }
  }
  return removed;
}

export async function generateGridForDate(date: Date, env: GridEnv): Promise<void> {
  const iso = isoDate(date);
  const bucket = env.CONTENT_BUCKET;

  const existing = await readJson<{ date?: string }>(bucket, LATEST_KEY);
  if (existing?.date === iso) {
    console.log(`grid: ${iso} already published, leaving it alone`);
    return;
  }

  const rand = mulberry32(fnv1a(`grid|${iso}`));
  let rows: Constraint[] | null = null;
  let cols: Constraint[] | null = null;
  let counts: number[] | null = null;
  let attempts = 0;

  for (; attempts < MAX_ATTEMPTS && !counts; attempts++) {
    const picked: Constraint[] = [];
    const taken = new Set<string>();
    while (picked.length < 6) {
      const c = MENU[Math.floor(rand() * MENU.length)];
      // No axis may repeat a constraint -- "2010s" against "2010s" is a square whose
      // answer set is just the row, and it looks like a mistake because it is one.
      if (taken.has(keyOf(c))) continue;
      taken.add(keyOf(c));
      picked.push(c);
    }
    const candidateRows = picked.slice(0, 3);
    const candidateCols = picked.slice(3);
    const found = cellCounts(candidateRows, candidateCols, POOL, CELL_FLOOR);
    if (found) { rows = candidateRows; cols = candidateCols; counts = found; }
  }

  if (!rows || !cols || !counts) {
    console.error(`grid: no fillable grid found for ${iso} after ${MAX_ATTEMPTS} attempts`);
    return;
  }

  const puzzle: GridPuzzle = {
    schemaVersion: 1,
    keyVersion: KEY_VERSION,
    puzzleNumber: daysBetween(EPOCH_DATE, iso) + 1,
    date: iso,
    titleIndex: TITLE_INDEX,
    rows,
    cols,
  };

  // Written BEFORE latest.json. verifyGrid reads `grid` out of this and rejects any board
  // it cannot check, so a puzzle published ahead of its answer file would reject every
  // submission made in the gap.
  await putJson(bucket, `${ANSWER_PREFIX}${iso}.json`, {
    date: iso,
    puzzleNumber: puzzle.puzzleNumber,
    // Unused by verifyGrid; carried because every other answer file has one.
    tmdbId: 0,
    title: "",
    grid: { rows, cols },
  });

  const current = await readJson<{ date?: string }>(bucket, LATEST_KEY);
  if (current?.date && current.date !== iso) {
    await putJson(bucket, `content/game/grid/${current.date}.json`, current);
  }
  await putJson(bucket, LATEST_KEY, envelope(puzzle));

  const pruned = await pruneAnswers(bucket, iso);
  console.log(
    `grid: ${iso} #${puzzle.puzzleNumber} after ${attempts} attempts -> ` +
      `rows [${rows.map(keyOf).join(", ")}] cols [${cols.map(keyOf).join(", ")}] ` +
      `cells ${counts.join("/")} [${pruned} answers pruned]`,
  );
}
