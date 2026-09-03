/**
 * The guess universe, server-side.
 *
 * ## Why the worker needs this at all
 *
 * Every game so far could be verified from the answer's id alone: "was the last guess the
 * right title". The Grid cannot -- a pick is valid because of what the title IS (its
 * decade, its genres, its rating), and until now the worker had no way to know that. It
 * held the answer's id and title and nothing else, which is also why an unsolved Flickdl
 * board cannot be scored for partial credit.
 *
 * The index is already in the same R2 bucket this worker binds, published for the clients.
 * Reading it here costs one fetch and makes the server able to check a claim about a title
 * rather than take the client's word for it.
 *
 * ## Cached in the ISOLATE, not per request
 *
 * ~31k rows is about 1.4MB of JSON. Parsing that on every submission would be absurd; a
 * module-level promise means the first request in an isolate pays for it and every request
 * after is a Map lookup. Isolates are reused heavily, so in practice this is amortised to
 * nothing.
 *
 * ⚠️ The cache is a PROMISE, not the parsed value. Two requests arriving together in a
 * cold isolate would otherwise both see "not loaded yet" and both fetch and parse 1.4MB.
 * Storing the in-flight promise makes the second one await the first.
 */

export type IndexedTitle = {
  title: string;
  year: number;
  /** 0 = film, 1 = show. */
  type: number;
  genreMask: number;
  ratingTenths: number;
  tmdbId: number;
};

/** The published index is an array of tuples, not objects -- it is downloaded by everyone. */
type IndexRow = [string, number, number, number, number, number];

const INDEX_KEY = "content/game/titles.v2.json";

/** Keyed "type:tmdbId": a TMDB id is not unique on its own across films and shows. */
type Index = Map<string, IndexedTitle>;

let cached: Promise<Index | null> | null = null;

export const titleKey = (type: number, tmdbId: number) => `${type}:${tmdbId}`;

async function load(bucket: R2Bucket): Promise<Index | null> {
  const obj = await bucket.get(INDEX_KEY);
  if (!obj) return null;
  let rows: IndexRow[];
  try {
    rows = (await obj.json()) as IndexRow[];
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;

  const map: Index = new Map();
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    map.set(titleKey(r[2], r[5]), {
      title: r[0], year: r[1], type: r[2], genreMask: r[3], ratingTenths: r[4], tmdbId: r[5],
    });
  }
  return map;
}

export function titleIndex(bucket: R2Bucket | undefined): Promise<Index | null> {
  if (!bucket) return Promise.resolve(null);
  if (!cached) {
    cached = load(bucket).catch(() => {
      // A failed load must not poison the isolate for its whole life: clearing the cache
      // means the next request retries rather than every request after a blip failing.
      cached = null;
      return null;
    });
  }
  return cached;
}

/** Test seam. Never called in production; the module cache is the point. */
export function __resetTitleIndexForTests(): void {
  cached = null;
}
