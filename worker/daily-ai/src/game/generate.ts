/**
 * Generates the day's One Take puzzle and publishes it.
 *
 * Runs on the existing daily-ai cron. That is not laziness — the Cloudflare account is at
 * the hard five-cron-per-account limit, and this worker already holds the R2 binding it
 * needs, so folding in here costs no slot. See wrangler.toml.
 *
 * ## What gets written where
 *
 *   content/game/latest.json          public, TODAY only, answer obfuscated
 *   content/game/{yesterday}.json     public archive, written as today's replaces it
 *   game-state/answers/{date}.json    PRIVATE, plaintext, read by share-api to verify
 *   game-state/recent.json            PRIVATE, the last year of answers, to avoid repeats
 *
 * The `game-state/` prefix is not served: the Pages function routes `content/*` and
 * nothing else. That is the whole reason the plaintext answer can live in the same bucket.
 *
 * ## Only today is ever published
 *
 * `content/game/{date}.json` for a FUTURE date would be trivially enumerable, so it never
 * exists ahead of time — latest.json is written at rollover and yesterday's is archived
 * after the fact. Archiving costs nothing and makes a shared result link resolvable later.
 */
import { POOL, type PoolEntry } from "./pool";
import { buildClues, type Clue } from "./clues";
import { obfuscateTitle, obfuscatePayload, KEY_VERSION } from "./obfuscate";

export interface GameEnv {
  CONTENT_BUCKET: R2Bucket;
}

const LATEST_KEY = "content/game/latest.json";
const RECENT_KEY = "game-state/recent.json";
const ANSWER_PREFIX = "game-state/answers/";
const TITLE_INDEX = "titles.v2.json";

/**
 * Puzzle #1.
 *
 * The number is DERIVED from this date, not counted — `daysBetween(EPOCH_DATE, iso) + 1` —
 * so moving it renumbers every past and future puzzle at once.
 *
 * ⚠️ Moved once, on 2026-08-12, to reset the game before anyone was really playing: the
 * first two days were test data and were wiped along with every result, stat and
 * distribution row. Do NOT move it again. Renumbering after people have shared "Flickdl
 * #47" makes every one of those grids point at a different puzzle, and the archive
 * disagrees with the shares forever.
 */
const EPOCH_DATE = "2026-08-12";

/** How many past answers to keep out of the pool. A year means no visible repeats. */
const RECENT_LIMIT = 365;

/**
 * Answer files are kept longer than the 30-day sign-in backfill window needs.
 *
 * A backfill verifies each day against its archived answer, so pruning to exactly 30 would
 * race anyone submitting on the boundary. Ten days of slack costs a few kilobytes.
 */
const ANSWER_RETENTION_DAYS = 40;

/** How many candidates to try before giving up on the band. */
const MAX_CANDIDATES = 40;

type PublishedAnswer = {
  tmdbId: number;
  type: number;
  /** Obfuscated. NOT encrypted — see obfuscate.ts. */
  t: string;
  year: number;
  genreMask: number;
  /** Audience score times ten, so clients compare integers. See the fixture. */
  ratingTenths: number;
  posterUrl: string;
  backdropUrl: string;
};

type Puzzle = {
  schemaVersion: 2;
  keyVersion: number;
  puzzleNumber: number;
  date: string;
  titleIndex: string;
  answer: PublishedAnswer;
  reveal: { focusX: number; focusY: number };
  clues: Clue[];
  /**
   * Hashed Trakt person ids for everyone credited on the answer.
   *
   * Public, and safe to be: a client can test whether a person IT already fetched also
   * appears here, and cannot read any of them. See castHash.ts.
   */
  castHashes: string[];
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

/**
 * Easiest Monday, hardest Sunday — but only as far as band 4.
 * JS getUTCDay() is Sunday 0, so it is rotated rather than used directly.
 *
 * The pool still has seven bands and `band <= 3` still means what it means to Chronology
 * and Flicklink, which is why this compresses the WEEKDAY MAPPING rather than the banding.
 * Changing BANDS in build-game-data.mjs would silently redefine that filter in two other
 * generators.
 *
 * Bands 5 and 6 are the bottom two sevenths of the pool, and a Sunday answer nobody has
 * heard of is not a hard puzzle, it is a guessing game. Round rather than truncate so the
 * gradient stays monotonic: Mon 0, Tue 1, Wed 1, Thu 2, Fri 3, Sat 3, Sun 4.
 *
 * ⚠️ This one is LIVE. Flickdl has been published daily against the old 0..6 mapping, so
 * Sundays get materially easier from the day this ships — deliberately, but it is a
 * visible change to a running game rather than a new one.
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

/** Small seeded PRNG. Determinism means re-running a date reproduces its puzzle. */
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

/**
 * The backdrop has to actually load — it is the whole first four stages of the reveal.
 * A 404 here is the difference between a hard puzzle and a blank screen.
 */
async function backdropLoads(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Picks a focus point for the zoomed reveal.
 *
 * Kept out of the bottom third: backdrops occasionally carry a logo or a title treatment
 * down there, and starting the reveal on burnt-in text would hand over the answer at 12x.
 * The horizontal band avoids the extreme edges, which are often empty sky or blur.
 */
function focusPoint(rand: () => number): { focusX: number; focusY: number } {
  return {
    focusX: Number((0.25 + rand() * 0.5).toFixed(3)),
    focusY: Number((0.2 + rand() * 0.4).toFixed(3)),
  };
}

async function loadRecent(bucket: R2Bucket): Promise<number[]> {
  const recent = await readJson<{ tmdbIds?: number[] }>(bucket, RECENT_KEY);
  return recent?.tmdbIds ?? [];
}

/**
 * Moves the outgoing puzzle to a dated key before it is overwritten.
 *
 * Reads the date out of the file rather than assuming it was yesterday's: a cron that
 * missed a day would otherwise archive under the wrong name and lose a puzzle.
 */
async function archiveCurrent(bucket: R2Bucket, todayIso: string): Promise<void> {
  const current = await readJson<Puzzle>(bucket, LATEST_KEY);
  if (!current?.date || current.date === todayIso) return;
  await putJson(bucket, `content/game/${current.date}.json`, current);
}

/**
 * What actually gets published: three routing fields and one opaque blob.
 *
 * `date` and the two versions stay OUTSIDE so a client can tell what it is holding, and
 * whether it can decode it at all, without decoding first. Everything that describes the
 * answer — the id, the art, the clues, the reveal — goes inside.
 *
 * ⚠️ schemaVersion 2 is a FLAG DAY. A v1 client reads `{date, p}`, finds no `answer`, and
 * fails to parse. That was acceptable exactly once: on the day the game was reset to #1
 * with no players. It will not be acceptable again.
 */
function envelope(puzzle: Puzzle) {
  const { schemaVersion, keyVersion, ...secret } = puzzle;
  // `date` is deliberately in BOTH: outside for routing, inside so the decoded puzzle is
  // self-contained. A client that decodes the blob gets a complete object rather than one
  // it has to stitch back together from two places, and a mismatch between the two is
  // detectable rather than silent.
  return { schemaVersion, keyVersion, date: puzzle.date, p: obfuscatePayload(secret) };
}

/** Answer files outlive their backfill window, then go. */
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

export async function generateGameForDate(date: Date, env: GameEnv): Promise<void> {
  const iso = isoDate(date);
  const bucket = env.CONTENT_BUCKET;

  const existing = await readJson<Puzzle>(bucket, LATEST_KEY);
  if (existing?.date === iso) {
    console.log(`one-take: ${iso} already published, leaving it alone`);
    return;
  }

  const band = bandForDate(date);
  const recent = new Set(await loadRecent(bucket));
  const rand = mulberry32(fnv1a(`one-take|${iso}`));

  const candidates = shuffled(
    POOL.filter((p) => p.band === band && !recent.has(p.tmdbId)),
    rand,
  );

  if (candidates.length === 0) {
    console.error(`one-take: band ${band} is empty for ${iso} (pool exhausted?)`);
    return;
  }

  let chosen: PoolEntry | null = null;
  let clues: Clue[] | null = null;
  let castHashes: string[] = [];
  let rejected = 0;

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const built = await buildClues({
      tmdbId: candidate.tmdbId,
      type: candidate.type,
      title: candidate.title,
      year: candidate.year,
      genres: candidate.genres,
      runtime: candidate.runtime,
    });
    if (!built) { rejected++; continue; }
    if (!(await backdropLoads(candidate.backdropUrl))) { rejected++; continue; }
    chosen = candidate;
    clues = built.clues;
    castHashes = built.castHashes;
    break;
  }

  if (!chosen || !clues) {
    console.error(`one-take: no candidate in band ${band} survived verification for ${iso} (${rejected} rejected)`);
    return;
  }

  const puzzle: Puzzle = {
    schemaVersion: 2,
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
      backdropUrl: chosen.backdropUrl,
    },
    reveal: focusPoint(rand),
    clues,
    castHashes,
  };

  // The private, plaintext copy share-api verifies submissions against. Written BEFORE
  // latest.json: a client that fetched the puzzle and submitted a result against an
  // answer file that did not exist yet would be rejected for guessing correctly.
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
    `one-take: ${iso} #${puzzle.puzzleNumber} band ${band} -> ${chosen.title} (${chosen.year}) ` +
      `[${rejected} rejected, ${castHashes.length} cast hashes, ${nextRecent.length} recent, ${pruned} answers pruned]`,
  );
}
