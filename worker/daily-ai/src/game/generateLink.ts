/**
 * Generates the day's Flicklink puzzle and publishes it.
 *
 * "Get from Interstellar to Get Out in four links", each link a person credited on both
 * titles. The most distinctive game in the suite and the only one whose PUZZLE is entirely
 * public: the start and the end are the question, so there is nothing to obfuscate.
 *
 * ## What the generator guarantees, and what it does not
 *
 * It guarantees a path EXISTS at the published par, because it found one. It does not
 * claim that par is optimal over the whole of cinema -- the graph is built from a sample
 * of ~120 titles, so a player with a better memory than the sample may well do it in
 * fewer, and that is a good outcome rather than a bug. `par` is a target, not a bound.
 *
 *   content/game/link/latest.json        public, TODAY only
 *   game-state/answers/link/{date}.json  PRIVATE, the endpoints for verification
 */
import { POOL, type PoolEntry } from "./pool";
import { obfuscatePayload, KEY_VERSION } from "./obfuscate";
import { SAMPLE_SIZE, buildGraph, distancesFrom, type GraphNode } from "./creditsGraph";

export interface LinkEnv {
  CONTENT_BUCKET: R2Bucket;
}

const LATEST_KEY = "content/game/link/latest.json";
const ANSWER_PREFIX = "game-state/answers/link/";
const TITLE_INDEX = "titles.v2.json";
const EPOCH_DATE = "2026-09-03";
const ANSWER_RETENTION_DAYS = 40;

/**
 * How many links apart the endpoints should be.
 *
 * Three is the sweet spot this genre settled on: two is usually one obvious shared actor,
 * and five is a research project. The generator takes three where it can and falls back
 * rather than publishing nothing.
 */
const TARGET_PAR = 3;
const FALLBACK_PARS = [4, 2];

/** How many moves the player gets. Par plus slack, so a longer route still finishes. */
const MOVE_LIMIT = 8;

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
 * The week's sample, seeded by ISO week rather than by date.
 *
 * The same ~120 titles for seven days means their payloads stay in the edge cache, so only
 * one morning a week pays for them. Drawn from the best-known bands: a chain through
 * titles nobody has heard of is not solvable, however short it is.
 */
export function sampleForWeek(iso: string, size = SAMPLE_SIZE): GraphNode[] {
  const week = Math.floor(daysBetween(EPOCH_DATE, iso) / 7);
  const rand = mulberry32(fnv1a(`link-sample|${week}`));
  const known = POOL.filter((p: PoolEntry) => p.band <= 3);
  const picked: GraphNode[] = [];
  const taken = new Set<number>();
  let guard = 0;
  while (picked.length < size && guard++ < size * 40) {
    const c = known[Math.floor(rand() * known.length)];
    if (!c || taken.has(c.tmdbId)) continue;
    taken.add(c.tmdbId);
    picked.push({ tmdbId: c.tmdbId, type: c.type, title: c.title });
  }
  return picked;
}

type LinkEndpoint = { tmdbId: number; type: number; title: string; posterUrl: string };

type LinkPuzzle = {
  schemaVersion: 1;
  keyVersion: number;
  puzzleNumber: number;
  date: string;
  titleIndex: string;
  start: LinkEndpoint;
  end: LinkEndpoint;
  /** Links the generator found a route in. A target, not a bound -- see the header. */
  par: number;
  moveLimit: number;
};

function envelope(puzzle: LinkPuzzle) {
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

const posterFor = (tmdbId: number, type: number): string =>
  POOL.find((p) => p.tmdbId === tmdbId && p.type === type)?.posterUrl ?? "";

export async function generateLinkForDate(date: Date, env: LinkEnv): Promise<void> {
  const iso = isoDate(date);
  const bucket = env.CONTENT_BUCKET;

  const existing = await readJson<{ date?: string }>(bucket, LATEST_KEY);
  if (existing?.date === iso) {
    console.log(`link: ${iso} already published, leaving it alone`);
    return;
  }

  const graph = await buildGraph(sampleForWeek(iso));
  if (graph.nodes.length < 20) {
    console.error(`link: graph too small for ${iso} (${graph.nodes.length} nodes with credits)`);
    return;
  }

  const rand = mulberry32(fnv1a(`link|${iso}`));

  /*
   * Try starts until one has a partner at par.
   *
   * A random node can sit in a small component with nothing three links away, so the
   * search walks starts rather than giving up on the first. Pars are tried in order --
   * three first, then four, then two -- so a thin graph degrades to an easier puzzle
   * rather than to no puzzle.
   */
  let chosen: { start: number; end: number; par: number } | null = null;
  const order = [TARGET_PAR, ...FALLBACK_PARS];
  for (let attempt = 0; attempt < 40 && !chosen; attempt++) {
    const start = Math.floor(rand() * graph.nodes.length);
    const distances = distancesFrom(graph, start);
    for (const par of order) {
      const candidates = [...distances.entries()]
        .filter(([, d]) => d === par)
        .map(([node]) => node);
      if (candidates.length === 0) continue;
      chosen = { start, end: candidates[Math.floor(rand() * candidates.length)], par };
      break;
    }
  }

  if (!chosen) {
    console.error(`link: no endpoint pair found for ${iso} in a graph of ${graph.nodes.length}`);
    return;
  }

  const startNode = graph.nodes[chosen.start];
  const endNode = graph.nodes[chosen.end];

  const puzzle: LinkPuzzle = {
    schemaVersion: 1,
    keyVersion: KEY_VERSION,
    puzzleNumber: daysBetween(EPOCH_DATE, iso) + 1,
    date: iso,
    titleIndex: TITLE_INDEX,
    start: { ...startNode, posterUrl: posterFor(startNode.tmdbId, startNode.type) },
    end: { ...endNode, posterUrl: posterFor(endNode.tmdbId, endNode.type) },
    par: chosen.par,
    moveLimit: MOVE_LIMIT,
  };

  // Written BEFORE latest.json, as every generator here does.
  await putJson(bucket, `${ANSWER_PREFIX}${iso}.json`, {
    date: iso,
    puzzleNumber: puzzle.puzzleNumber,
    // The END is the answer as far as the verifier is concerned: a chain counts when it
    // arrives there, having started where it was told to.
    tmdbId: endNode.tmdbId,
    title: endNode.title,
    link: {
      start: { tmdbId: startNode.tmdbId, type: startNode.type },
      end: { tmdbId: endNode.tmdbId, type: endNode.type },
      par: chosen.par,
      moveLimit: MOVE_LIMIT,
    },
  });

  const current = await readJson<{ date?: string }>(bucket, LATEST_KEY);
  if (current?.date && current.date !== iso) {
    await putJson(bucket, `content/game/link/${current.date}.json`, current);
  }
  await putJson(bucket, LATEST_KEY, envelope(puzzle));

  const pruned = await pruneAnswers(bucket, iso);
  console.log(
    `link: ${iso} #${puzzle.puzzleNumber} ${startNode.title} -> ${endNode.title} ` +
      `par ${chosen.par} [graph ${graph.nodes.length} nodes, ${pruned} answers pruned]`,
  );
}
