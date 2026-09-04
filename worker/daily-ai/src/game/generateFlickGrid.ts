/**
 * Generates the day's Grid puzzle and publishes it.
 *
 * Nine squares, eighteen posters, and exactly one right home for each of nine of them.
 *
 * ## The board is a matching puzzle, not a search
 *
 * It used to be: name any title that satisfies both constraints, scored by how few other
 * players named the same one. It is now: here is a tray of posters, put them where they
 * belong. That is a different game with a different failure mode, and the whole of the
 * selection below exists to close it.
 *
 * ## Exactly one poster fits each cell, by construction
 *
 * A cell is `rows[r] AND cols[c]`, so a title lands in ONE cell only when it satisfies
 * exactly one row and exactly one column. Most titles do not — genre is membership, so
 * Alien is Horror AND Science fiction, and minRating is a floor, so anything clearing
 * 8.5+ clears 8.0+ and 7.5+ as well. Titles like that fit several cells and cannot be
 * answers here: their poster would have no single right home.
 *
 * So the nine answers each fit exactly one cell, and the nine decoys fit none. Together
 * those two rules make "one poster, one slot" a property of the published pool rather
 * than something that is merely usually true — which matters, because the alternative is
 * marking a player wrong for a placement that is perfectly valid.
 *
 * Measured over 4,000 random constraint draws against the real pool: 30.3% give all nine
 * cells a uniquely-fitting title, and a median 1,113 of 1,600 titles fit no cell at all.
 * At 600 attempts, finding a workable board is a certainty.
 *
 *   content/game/flickgrid/latest.json        public, TODAY only
 *   game-state/answers/flickgrid/{date}.json  PRIVATE, carries the constraints for verifyGrid
 */
import { POOL, type PoolEntry } from "./pool";
import { obfuscatePayload, KEY_VERSION } from "./obfuscate";

export interface GridEnv {
  CONTENT_BUCKET: R2Bucket;
}

const LATEST_KEY = "content/game/flickgrid/latest.json";
const ANSWER_PREFIX = "game-state/answers/flickgrid/";
const TITLE_INDEX = "titles.v2.json";
const EPOCH_DATE = "2026-09-03";
const ANSWER_RETENTION_DAYS = 40;

/**
 * How many posters in the tray fit no cell at all.
 *
 * Nine answers plus nine decoys is eighteen: enough that the tray is not simply the
 * answer key in a row, few enough to lay out as posters without scrolling past them.
 */
const DECOYS = 9;
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
/**
 * Which of the nine cells a title fits.
 *
 * A cell is `rows[r] AND cols[c]`, so a title lands in one cell only when it satisfies
 * exactly one row and exactly one column. Most titles do not: genre is membership, so
 * Alien is Horror AND Science fiction, and minRating is a floor, so anything clearing
 * 8.5+ also clears 8.0+ and 7.5+. Those titles fit several cells and are unusable as
 * answers here — there would be no single right home for their poster.
 */
export function cellsFor(entry: PoolEntry, rows: Constraint[], cols: Constraint[]): number[] {
  const hit: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (satisfies(entry, rows[r]) && satisfies(entry, cols[c])) hit.push(r * 3 + c);
    }
  }
  return hit;
}

/**
 * The day's nine answers and the decoys they hide among.
 *
 * ⚠️ The published pool must contain exactly ONE title that fits each cell, or the board
 * has more than one right answer and a player placing a perfectly valid poster is marked
 * wrong. That is why answers must fit exactly one cell AND decoys must fit none: together
 * they make "one poster, one slot" true of the pool rather than merely likely.
 *
 * Measured against the real pool over 4,000 random draws: 30.3% of constraint sets give
 * all nine cells at least one uniquely-fitting title, and a median of 1,113 of the 1,600
 * titles fit no cell at all. At 600 attempts finding a workable set is a certainty.
 */
export function buildBoard(
  rows: Constraint[],
  cols: Constraint[],
  pool: PoolEntry[],
  decoys: number,
  rand: () => number,
): { answers: PoolEntry[]; decoys: PoolEntry[] } | null {
  const byCell: PoolEntry[][] = Array.from({ length: 9 }, () => []);
  const unfitting: PoolEntry[] = [];
  for (const entry of pool) {
    const hit = cellsFor(entry, rows, cols);
    if (hit.length === 1) byCell[hit[0]].push(entry);
    else if (hit.length === 0) unfitting.push(entry);
  }
  if (byCell.some((c) => c.length === 0)) return null;
  if (unfitting.length < decoys) return null;

  const answers = byCell.map((c) => c[Math.floor(rand() * c.length)]);
  // A title can only be a uniquely-fitting answer for ONE cell by construction, so the
  // nine cannot collide -- but a pool that ever changed shape could, and a duplicate
  // poster in the tray is unplayable rather than merely wrong.
  if (new Set(answers.map((a) => a.tmdbId)).size !== 9) return null;

  const shuffled = unfitting.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { answers, decoys: shuffled.slice(0, decoys) };
}

/** A poster in the tray. Everything the board needs to draw it and nothing more. */
type GridCard = {
  tmdbId: number;
  type: number;
  title: string;
  year: number;
  posterUrl: string;
};

type GridPuzzle = {
  schemaVersion: 2;
  keyVersion: number;
  puzzleNumber: number;
  date: string;
  titleIndex: string;
  rows: Constraint[];
  cols: Constraint[];
  /** The nine answers and their decoys, shuffled. The player drags these into the grid. */
  pool: GridCard[];
  /**
   * The right poster for each cell, in reading order.
   *
   * Public for the same reason Flickology's `order` is: the board scores the moment you
   * lock in, which means grading offline, which means the answer is client-side either
   * way. The server re-verifies against its own copy.
   */
  solution: number[];
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

export async function generateFlickGridForDate(date: Date, env: GridEnv): Promise<void> {
  const iso = isoDate(date);
  const bucket = env.CONTENT_BUCKET;

  const existing = await readJson<{ date?: string }>(bucket, LATEST_KEY);
  if (existing?.date === iso) {
    console.log(`flickgrid: ${iso} already published, leaving it alone`);
    return;
  }

  const rand = mulberry32(fnv1a(`grid|${iso}`));
  let rows: Constraint[] | null = null;
  let cols: Constraint[] | null = null;
  let board: { answers: PoolEntry[]; decoys: PoolEntry[] } | null = null;
  let attempts = 0;

  for (; attempts < MAX_ATTEMPTS && !board; attempts++) {
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
    const found = buildBoard(candidateRows, candidateCols, POOL, DECOYS, rand);
    if (found) { rows = candidateRows; cols = candidateCols; board = found; }
  }

  if (!rows || !cols || !board) {
    console.error(`flickgrid: no solvable board found for ${iso} after ${MAX_ATTEMPTS} attempts`);
    return;
  }

  const solution = board.answers.map((a) => a.tmdbId);
  // The tray, shuffled so the nine answers are not the first nine posters in it.
  const tray = [...board.answers, ...board.decoys];
  for (let i = tray.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [tray[i], tray[j]] = [tray[j], tray[i]];
  }

  const puzzle: GridPuzzle = {
    schemaVersion: 2,
    keyVersion: KEY_VERSION,
    puzzleNumber: daysBetween(EPOCH_DATE, iso) + 1,
    date: iso,
    titleIndex: TITLE_INDEX,
    rows,
    cols,
    pool: tray.map((e) => ({
      tmdbId: e.tmdbId, type: e.type, title: e.title, year: e.year, posterUrl: e.posterUrl,
    })),
    solution,
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
    // `solution` is what verifyGrid scores against now: the board has exactly one right
    // poster per cell, so a placement is right or it is not. `rows`/`cols` stay because
    // the archive is also what a share card and any later audit read.
    grid: { rows, cols, solution },
  });

  const current = await readJson<{ date?: string }>(bucket, LATEST_KEY);
  if (current?.date && current.date !== iso) {
    await putJson(bucket, `content/game/flickgrid/${current.date}.json`, current);
  }
  await putJson(bucket, LATEST_KEY, envelope(puzzle));

  const pruned = await pruneAnswers(bucket, iso);
  console.log(
    `flickgrid: ${iso} #${puzzle.puzzleNumber} after ${attempts} attempts -> ` +
      `rows [${rows.map(keyOf).join(", ")}] cols [${cols.map(keyOf).join(", ")}] ` +
      `pool ${tray.length} (${board.answers.length} answers + ${board.decoys.length} decoys) ` +
      `[${pruned} answers pruned]`,
  );
}
