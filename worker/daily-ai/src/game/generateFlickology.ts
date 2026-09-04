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
 * candidates must be SPREAD along the axis -- see isSpread in flickologyAxis.ts, which
 * is why this rejects far more sets than it publishes.
 *
 * Two of the five axes measure something the pool does not carry (episode counts, box
 * office). Those pick their candidates FIRST and ask TMDB about that shortlist, rather
 * than the worker knowing a figure for all 1,600 titles to use five of them.
 *
 *   content/game/flickology/latest.json        public, TODAY only, values obfuscated
 *   game-state/answers/flickology/{date}.json  PRIVATE, carries the correct ORDER
 */
import { POOL, type PoolEntry } from "./pool";
import { obfuscatePayload, KEY_VERSION } from "./obfuscate";
import { fetchTitleFigure } from "../tmdb";
import { AXES, FORMAT, ON_DEMAND, SHORTLIST, isSpread, type Axis } from "./flickologyAxis";

export interface OrderEnv {
  CONTENT_BUCKET: R2Bucket;
  /** Only the on-demand axes touch this. See ON_DEMAND. */
  TMDB_API_KEY: string;
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

const poolValue = (entry: PoolEntry, axis: Axis): number =>
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

/** `count` distinct entries, drawn with the day's seeded generator. */
function sample(entries: PoolEntry[], count: number, rand: () => number): PoolEntry[] {
  const taken = new Set<number>();
  const out: PoolEntry[] = [];
  // Bounded rather than `while (out.length < count)`: a pool smaller than the shortlist
  // would otherwise spin forever drawing the same ids.
  for (let i = 0; i < count * 20 && out.length < Math.min(count, entries.length); i++) {
    const e = entries[Math.floor(rand() * entries.length)];
    if (taken.has(e.tmdbId)) continue;
    taken.add(e.tmdbId);
    out.push(e);
  }
  return out;
}

/**
 * The shortlist's figures, from TMDB.
 *
 * ⚠️ In BATCHES, not all at once. A Worker has a concurrent-subrequest ceiling and TMDB
 * rate-limits; forty parallel fetches is the shape that trips both. Titles TMDB has no
 * real number for are simply absent from the map — see fetchTitleFigure on why a zero is
 * an absent figure rather than a small one.
 */
async function enrich(
  shortlist: PoolEntry[],
  field: "episodes" | "revenue",
  apiKey: string,
): Promise<Map<number, number>> {
  const values = new Map<number, number>();
  const BATCH = 6;
  for (let i = 0; i < shortlist.length; i += BATCH) {
    const batch = shortlist.slice(i, i + BATCH);
    const figures = await Promise.all(
      batch.map((e) => fetchTitleFigure(apiKey, e.tmdbId, field)),
    );
    batch.forEach((e, j) => {
      const v = figures[j];
      if (v !== null) values.set(e.tmdbId, v);
    });
  }
  return values;
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
  const format = FORMAT[axis];
  const onDemand = ON_DEMAND[axis];
  const known = POOL.filter((p) =>
    p.band <= 3 &&
    !recent.has(p.tmdbId) &&
    (format === undefined || p.type === format) &&
    // For a fetched axis there is nothing in the pool to check yet; enrich() drops the
    // candidates TMDB has no real figure for.
    (onDemand !== undefined || poolValue(p, axis) > 0));
  if (known.length < CARDS * 4) {
    console.error(`flickology: not enough usable titles for ${iso} on axis ${axis} (${known.length})`);
    return;
  }

  /*
   * The day's values, by TMDB id.
   *
   * For three axes this is just the pool. For the other two it is a few dozen TMDB calls
   * against a shortlist that was drawn BEFORE anything was fetched — which is the whole
   * point: the puzzle picks its titles, then asks about those, rather than the worker
   * knowing every episode count in the catalogue in order to use five of them.
   */
  let candidates = known;
  let values: Map<number, number>;
  if (onDemand) {
    const shortlist = sample(known, SHORTLIST, rand);
    values = await enrich(shortlist, onDemand, env.TMDB_API_KEY);
    candidates = shortlist.filter((e) => values.has(e.tmdbId));
    if (candidates.length < CARDS * 2) {
      console.error(
        `flickology: ${iso} axis ${axis} — only ${candidates.length} of ${shortlist.length} ` +
          `shortlisted titles had a usable figure`,
      );
      return;
    }
  } else {
    values = new Map(known.map((e) => [e.tmdbId, poolValue(e, axis)]));
  }
  const valueOf = (e: PoolEntry): number => values.get(e.tmdbId) ?? 0;

  let chosen: PoolEntry[] | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !chosen; attempt++) {
    const pick: PoolEntry[] = [];
    const taken = new Set<number>();
    while (pick.length < CARDS) {
      const candidate = candidates[Math.floor(rand() * candidates.length)];
      if (taken.has(candidate.tmdbId)) continue;
      taken.add(candidate.tmdbId);
      pick.push(candidate);
    }
    if (isSpread(pick.map(valueOf), axis)) chosen = pick;
  }

  if (!chosen) {
    console.error(`flickology: no spread set found for ${iso} on axis ${axis} after ${MAX_ATTEMPTS} attempts`);
    return;
  }

  const order = chosen
    .slice()
    .sort((a, b) => valueOf(a) - valueOf(b))
    .map((e) => e.tmdbId);

  // Shuffled for publication. See the note on `cards`.
  const cards = chosen
    .slice()
    .sort(() => rand() - 0.5)
    .map((e) => ({
      tmdbId: e.tmdbId, type: e.type, title: e.title, year: e.year, posterUrl: e.posterUrl,
      /*
       * The measured value on the day's axis, so the board can SHOW the answer once the
       * round is over rather than only colouring which cards happened to land right.
       *
       * This leaks nothing: `order` is already in the payload because the client grades
       * offline, so the answer has always been client-side. A rating or a runtime is not
       * derivable from the other fields, which is why the board could not show them.
       */
      value: valueOf(e),
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
