/**
 * Generates the day's Flickology puzzle and publishes it.
 *
 * Five titles, one true order, and no losing state -- an ordering is always some distance
 * from right, and that distance is the score. See inversions()/orderScore() in
 * share-api's dailyGame.ts for how that is graded and why it counts wrong PAIRS rather
 * than misplaced cards.
 *
 * ## The one thing this generator has to get right
 *
 * A set the player has no way to order is not a puzzle, it is a coin toss with five
 * sides. Two films released four months apart are not something anyone knows, so the
 * candidates must be SPREAD along the axis -- see MIN_GAP. That check is most of this
 * file, and it is why it rejects far more sets than it publishes.
 *
 *   content/game/flickology/latest.json        public, TODAY only, values obfuscated
 *   game-state/answers/flickology/{date}.json  PRIVATE, carries the correct ORDER
 */
import { POOL, type PoolEntry } from "./pool";
import { obfuscatePayload, KEY_VERSION } from "./obfuscate";

export interface OrderEnv {
  CONTENT_BUCKET: R2Bucket;
}

const LATEST_KEY = "content/game/flickology/latest.json";
const RECENT_KEY = "game-state/flickology-recent.json";
const ANSWER_PREFIX = "game-state/answers/flickology/";

/** Its own epoch, for the reason every game has one: see generateReel.ts. */
const EPOCH_DATE = "2026-09-03";
const RECENT_LIMIT = 120;
const ANSWER_RETENTION_DAYS = 40;
const CARDS = 5;
const MAX_ATTEMPTS = 400;

/**
 * The axis, rotating daily.
 *
 * Three different questions rather than one, which is what stops the game becoming
 * "guess the year" every morning. Rating and runtime also reward completely different
 * knowledge from release date, so a player who is bad at one still has days they are
 * good at.
 */
const AXES = ["year", "rating", "runtime"] as const;
export type Axis = (typeof AXES)[number];

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
const MIN_GAP: Record<Axis, number> = { year: 7, rating: 6, runtime: 12 };

/** PoolEntry.type. 0 = film, 1 = show. */
const TYPE_MOVIE = 0;

const valueOf = (entry: PoolEntry, axis: Axis): number =>
  axis === "year" ? entry.year : axis === "rating" ? entry.ratingTenths : entry.runtime;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

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
  try {
    return (await obj.json()) as T;
  } catch {
    return null;
  }
}

async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Whether a set is orderable by a human.
 *
 * Sorted first, then every ADJACENT pair must clear the gap. Checking only the outer two
 * would pass a set of four titles from 2014 and one from 1975, which is one easy card and
 * four coin tosses.
 */
export function isSpread(entries: PoolEntry[], axis: Axis): boolean {
  const values = entries.map((e) => valueOf(e, axis)).sort((a, b) => a - b);
  for (let i = 1; i < values.length; i++) {
    if (values[i] - values[i - 1] < MIN_GAP[axis]) return false;
  }
  return true;
}

type OrderCard = {
  tmdbId: number;
  type: number;
  title: string;
  year: number;
  posterUrl: string;
};

type OrderPuzzle = {
  schemaVersion: 1;
  keyVersion: number;
  puzzleNumber: number;
  date: string;
  axis: Axis;
  /**
   * The cards, SHUFFLED.
   *
   * ⚠️ Never in answer order. The payload is obfuscated rather than encrypted -- the
   * client decodes it to grade offline -- so anyone who wants the answer can have it, but
   * publishing the cards already sorted would hand it to a player who merely opened the
   * file, and worse, any bug that skipped the client's own shuffle would show the board
   * pre-solved.
   */
  cards: OrderCard[];
  /** The correct order, as TMDB ids. */
  order: number[];
};

function envelope(puzzle: OrderPuzzle) {
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

export async function generateFlickologyForDate(date: Date, env: OrderEnv): Promise<void> {
  const iso = isoDate(date);
  const bucket = env.CONTENT_BUCKET;

  const existing = await readJson<{ date?: string }>(bucket, LATEST_KEY);
  if (existing?.date === iso) {
    console.log(`flickology: ${iso} already published, leaving it alone`);
    return;
  }

  const puzzleNumber = daysBetween(EPOCH_DATE, iso) + 1;
  const axis = AXES[Math.abs(puzzleNumber) % AXES.length];
  const rand = mulberry32(fnv1a(`order|${iso}`));
  const recent = new Set((await readJson<{ tmdbIds?: number[] }>(bucket, RECENT_KEY))?.tmdbIds ?? []);

  /*
   * Drawn from the WHOLE pool rather than one weekday band.
   *
   * The bands exist to tune how obscure a single answer is, and here there are five of
   * them at once -- five band-6 titles nobody has heard of is not a hard puzzle, it is an
   * unanswerable one. Recognisability is the floor this game needs, so it takes the
   * best-known half of the pool and gets its difficulty from how close the values are.
   */
  /*
   * ⚠️ The runtime axis is MOVIES ONLY.
   *
   * A show's runtime in the pool is its EPISODE length, so a 22-minute sitcom against a
   * 169-minute film is not a long-versus-short question — it is a format question wearing
   * the same units. "Shortest first" has no honest answer across the two, and a player who
   * knows both perfectly still cannot order them.
   *
   * Year and rating are directly comparable between films and shows, so they keep both.
   */
  const known = POOL.filter((p) =>
    p.band <= 3 &&
    !recent.has(p.tmdbId) &&
    valueOf(p, axis) > 0 &&
    (axis !== "runtime" || p.type === TYPE_MOVIE));
  if (known.length < CARDS * 4) {
    console.error(`flickology: not enough usable titles for ${iso} on axis ${axis} (${known.length})`);
    return;
  }

  let chosen: PoolEntry[] | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !chosen; attempt++) {
    const pick: PoolEntry[] = [];
    const taken = new Set<number>();
    while (pick.length < CARDS) {
      const candidate = known[Math.floor(rand() * known.length)];
      if (taken.has(candidate.tmdbId)) continue;
      taken.add(candidate.tmdbId);
      pick.push(candidate);
    }
    if (isSpread(pick, axis)) chosen = pick;
  }

  if (!chosen) {
    console.error(`flickology: no spread set found for ${iso} on axis ${axis} after ${MAX_ATTEMPTS} attempts`);
    return;
  }

  const order = chosen
    .slice()
    .sort((a, b) => valueOf(a, axis) - valueOf(b, axis))
    .map((e) => e.tmdbId);

  // Shuffled for publication. See the note on `cards`.
  const cards = chosen
    .slice()
    .sort(() => rand() - 0.5)
    .map((e) => ({
      tmdbId: e.tmdbId, type: e.type, title: e.title, year: e.year, posterUrl: e.posterUrl,
    }));

  const puzzle: OrderPuzzle = {
    schemaVersion: 1,
    keyVersion: KEY_VERSION,
    puzzleNumber,
    date: iso,
    axis,
    cards,
    order,
  };

  // Written BEFORE latest.json, for the reason every generator here does it: a client
  // that fetched the puzzle and submitted against a missing answer file would be
  // rejected for playing correctly.
  await putJson(bucket, `${ANSWER_PREFIX}${iso}.json`, {
    date: iso,
    puzzleNumber,
    // `tmdbId` is unused by this game's verifier and is carried only because every other
    // answer file has one; the ORDER is what verifyOrder reads.
    tmdbId: order[0],
    title: chosen.find((c) => c.tmdbId === order[0])?.title ?? "",
    order,
  });

  const current = await readJson<{ date?: string }>(bucket, LATEST_KEY);
  if (current?.date && current.date !== iso) {
    await putJson(bucket, `content/game/flickology/${current.date}.json`, current);
  }
  await putJson(bucket, LATEST_KEY, envelope(puzzle));

  const nextRecent = [...order, ...recent].slice(0, RECENT_LIMIT);
  await putJson(bucket, RECENT_KEY, { tmdbIds: nextRecent, updatedAt: Date.now() });

  const pruned = await pruneAnswers(bucket, iso);
  console.log(
    `flickology: ${iso} #${puzzleNumber} axis ${axis} -> ${chosen.map((c) => c.title).join(", ")} ` +
      `[${nextRecent.length} recent, ${pruned} answers pruned]`,
  );
}
