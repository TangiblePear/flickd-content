/**
 * Generates the day's Reel puzzle and publishes it.
 *
 * Six frames from one film or series; one more is revealed for every wrong guess. The
 * shape is Framed's, and it is the cheapest of the new games to build because everything
 * except the picture is already here: the same pool, the same weekday difficulty bands,
 * the same obfuscated envelope, the same guess index, the same verified submission.
 *
 * ## What gets written where
 *
 *   content/game/flickreel/latest.json        public, TODAY only, answer obfuscated
 *   content/game/flickreel/{yesterday}.json   public archive, written as today's replaces it
 *   game-state/answers/flickreel/{date}.json  PRIVATE, plaintext, read by share-api to verify
 *   game-state/flickreel-recent.json          PRIVATE, the last year of answers, to avoid repeats
 *
 * The namespaced answer path is what dailyGame.ts's readAnswer expects for every game
 * except Flickdl, which keeps the flat key it has forty days of archives under.
 *
 * ⚠️ Runs on the SAME cron as everything else in this worker -- see index.ts. It does not
 * get a trigger of its own; all the games roll over at the same instant by design.
 */
import { POOL, type PoolEntry } from "./pool";
import { obfuscateTitle, obfuscatePayload, KEY_VERSION } from "./obfuscate";
import { STILLS_PER_PUZZLE, allLoad, stillsFor } from "./stills";

export interface ReelEnv {
  CONTENT_BUCKET: R2Bucket;
  TMDB_API_KEY: string;
}

const LATEST_KEY = "content/game/flickreel/latest.json";
const RECENT_KEY = "game-state/flickreel-recent.json";
const ANSWER_PREFIX = "game-state/answers/flickreel/";
const TITLE_INDEX = "titles.v2.json";

/**
 * Reel puzzle #1.
 *
 * Its OWN epoch, deliberately: sharing Flickdl's would make Reel open at #23 on its first
 * day, which reads as a page that lost twenty-two puzzles. Same rule as Flickdl's -- once
 * anyone has shared a numbered grid this cannot move, because every share would then point
 * at a different puzzle and the archive would disagree with them forever.
 */
const EPOCH_DATE = "2026-09-03";

const RECENT_LIMIT = 365;
const ANSWER_RETENTION_DAYS = 40;

/**
 * Fewer candidates than Flickdl tries, because each one costs a TMDB call plus six HEAD
 * requests. The pool bands hold hundreds of titles apiece, so a lower ceiling still finds
 * one; what it protects is the shared cron's budget.
 */
const MAX_CANDIDATES = 12;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86_400_000,
  );
}

/**
 * Monday easiest, Sunday hardest — but only as far as band 4. Same rotation as Flickdl's.
 *
 * The pool still has seven bands and `band <= 3` still means what it means to Flickology
 * and Flicklink, which is why this compresses the WEEKDAY MAPPING rather than the banding.
 * Changing BANDS in build-game-data.mjs would silently redefine that filter in two other
 * generators.
 *
 * Bands 5 and 6 are the bottom two sevenths of the pool, and a Sunday answer nobody has
 * heard of is not a hard puzzle, it is a guessing game. Round rather than truncate so the
 * gradient stays monotonic: Mon 0, Tue 1, Wed 1, Thu 2, Fri 3, Sat 3, Sun 4.
 *
 * Two weekdays share a band, so those bands are drawn twice a week and last about half as
 * long before a title can recur. That is comfortably inside the budget: a band holds ~228
 * titles and RECENT_LIMIT is 365 answers ACROSS all bands, so even a doubled band keeps
 * well over a hundred candidates.
 */
const TOP_BAND = 4;

function bandForDate(d: Date): number {
  const weekday = (d.getUTCDay() + 6) % 7;
  return Math.round((weekday * TOP_BAND) / 6);
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

function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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

type PublishedAnswer = {
  tmdbId: number;
  type: number;
  /** Obfuscated. NOT encrypted -- see obfuscate.ts. */
  t: string;
  year: number;
  genreMask: number;
  ratingTenths: number;
  posterUrl: string;
};

type ReelPuzzle = {
  schemaVersion: 1;
  keyVersion: number;
  puzzleNumber: number;
  date: string;
  titleIndex: string;
  answer: PublishedAnswer;
  /** Six frames, hardest first. See stills.ts for why that order is free. */
  stills: string[];
};

function envelope(puzzle: ReelPuzzle) {
  const { schemaVersion, keyVersion, ...secret } = puzzle;
  return { schemaVersion, keyVersion, date: puzzle.date, p: obfuscatePayload(secret) };
}

/** Moves the outgoing puzzle to a dated key before it is overwritten. */
async function archiveCurrent(bucket: R2Bucket, todayIso: string): Promise<void> {
  const current = await readJson<{ date?: string }>(bucket, LATEST_KEY);
  if (!current?.date || current.date === todayIso) return;
  await putJson(bucket, `content/game/flickreel/${current.date}.json`, current);
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

export async function generateFlickReelForDate(date: Date, env: ReelEnv): Promise<void> {
  const iso = isoDate(date);
  const bucket = env.CONTENT_BUCKET;

  const existing = await readJson<{ date?: string }>(bucket, LATEST_KEY);
  if (existing?.date === iso) {
    console.log(`flickreel: ${iso} already published, leaving it alone`);
    return;
  }

  if (!env.TMDB_API_KEY) {
    console.error("flickreel: no TMDB_API_KEY, cannot source stills");
    return;
  }

  const band = bandForDate(date);
  const recent = new Set((await readJson<{ tmdbIds?: number[] }>(bucket, RECENT_KEY))?.tmdbIds ?? []);
  // Seeded differently from Flickdl's, or the two games would walk the same shuffled band
  // in the same order and land on the same title on the same day.
  const rand = mulberry32(fnv1a(`reel|${iso}`));

  const candidates = shuffled(
    POOL.filter((p) => p.band === band && !recent.has(p.tmdbId)),
    rand,
  );
  if (candidates.length === 0) {
    console.error(`flickreel: band ${band} is empty for ${iso} (pool exhausted?)`);
    return;
  }

  let chosen: PoolEntry | null = null;
  let stills: string[] | null = null;
  let rejected = 0;

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const found = await stillsFor(env.TMDB_API_KEY, candidate.tmdbId, candidate.type);
    if (!found) { rejected++; continue; }
    if (!(await allLoad(found))) { rejected++; continue; }
    chosen = candidate;
    stills = found;
    break;
  }

  if (!chosen || !stills) {
    console.error(`flickreel: no candidate in band ${band} had ${STILLS_PER_PUZZLE} usable stills for ${iso} (${rejected} rejected)`);
    return;
  }

  const puzzle: ReelPuzzle = {
    schemaVersion: 1,
    keyVersion: KEY_VERSION,
    puzzleNumber: daysBetween(EPOCH_DATE, iso) + 1,
    date: iso,
    titleIndex: TITLE_INDEX,
    answer: {
      tmdbId: chosen.tmdbId,
      type: chosen.type,
      t: obfuscateTitle(chosen.title),
      year: chosen.year,
      genreMask: chosen.genreMask,
      ratingTenths: chosen.ratingTenths,
      posterUrl: chosen.posterUrl,
    },
    stills,
  };

  // The private plaintext copy, written BEFORE latest.json for the same reason Flickdl's
  // is: a client that fetched the puzzle and submitted against an answer file that did not
  // exist yet would be rejected for guessing correctly.
  await putJson(bucket, `${ANSWER_PREFIX}${iso}.json`, {
    date: iso,
    puzzleNumber: puzzle.puzzleNumber,
    tmdbId: chosen.tmdbId,
    title: chosen.title,
  });

  await archiveCurrent(bucket, iso);
  await putJson(bucket, LATEST_KEY, envelope(puzzle));

  const nextRecent = [chosen.tmdbId, ...recent].slice(0, RECENT_LIMIT);
  await putJson(bucket, RECENT_KEY, { tmdbIds: nextRecent, updatedAt: Date.now() });

  const pruned = await pruneAnswers(bucket, iso);

  console.log(
    `flickreel: ${iso} #${puzzle.puzzleNumber} band ${band} -> ${chosen.title} (${chosen.year}) ` +
      `[${rejected} rejected, ${stills.length} stills, ${nextRecent.length} recent, ${pruned} answers pruned]`,
  );
}
