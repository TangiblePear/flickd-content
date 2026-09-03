/**
 * A small person-to-titles graph, built from the detail payloads.
 *
 * ## Why this has to exist at all
 *
 * Flicklink needs to publish a start and an end that are genuinely N links apart. Proving
 * that needs a graph, and nothing here is one: the pool has no credits, and
 * data.flickto.app answers "who worked on this title" but never "what else did they work
 * on". So the map is inverted here, over a SAMPLE, and the sample is the whole cost.
 *
 * ## The sample is seeded by WEEK, not by day
 *
 * Every title costs a fetch. Re-sampling daily would mean ~120 cold fetches every morning;
 * holding the sample for seven days means the same URLs are requested repeatedly and sit
 * in the edge cache, so six days in seven are nearly free. It also makes a week of puzzles
 * feel related without repeating one.
 *
 * ## What a "link" is
 *
 * Two titles link if they share ANY credited person -- cast or crew. A shared director is
 * as good a connection as a shared lead, and refusing crew would throw away most of what
 * makes these puzzles satisfying to solve.
 */

const DETAIL_BASE = "https://data.flickto.app";

type TraktPerson = { ids?: { trakt?: number } };
type CastMember = { person?: TraktPerson };
type CrewMember = { person?: TraktPerson };
type DetailPayload = {
  trakt_people?: { cast?: CastMember[]; crew?: Record<string, CrewMember[]> };
};

export type GraphNode = { tmdbId: number; type: number; title: string };

/** How many titles the graph is built over. Every one is a fetch on a cold week. */
export const SAMPLE_SIZE = 120;

/**
 * Credits are capped per title.
 *
 * A long-running show can credit hundreds of people, and a single such title would
 * otherwise link to almost everything through some third assistant editor -- which makes
 * for a graph where every distance is two and no puzzle is interesting. Principal cast and
 * main crew is what people actually reason about.
 */
const MAX_PEOPLE = 40;

async function peopleFor(tmdbId: number, type: number): Promise<number[] | null> {
  const url = `${DETAIL_BASE}/${type === 1 ? "shows" : "movies"}/${tmdbId}.json`;
  try {
    const res = await fetch(url, { cf: { cacheTtl: 86_400, cacheEverything: true } });
    if (!res.ok) return null;
    const payload = (await res.json()) as DetailPayload;
    const members: Array<{ person?: TraktPerson }> = [
      ...(payload.trakt_people?.cast ?? []),
      ...Object.values(payload.trakt_people?.crew ?? {}).flat(),
    ];
    const ids = new Set<number>();
    for (const m of members) {
      const id = m.person?.ids?.trakt;
      if (typeof id === "number" && id > 0) ids.add(id);
      if (ids.size >= MAX_PEOPLE) break;
    }
    return ids.size > 0 ? [...ids] : null;
  } catch {
    return null;
  }
}

export type Graph = {
  /** Index into `nodes` -> the person ids credited on it. */
  people: number[][];
  nodes: GraphNode[];
  /** Index into `nodes` -> indices of nodes sharing at least one person. */
  edges: number[][];
};

/**
 * Fetches the sample and inverts it.
 *
 * Sequential rather than parallel: this shares a cron with three other generators and a
 * hundred simultaneous subrequests is how one game takes the others down with it. On a
 * warm week these all hit the edge cache and the wall time is negligible anyway.
 */
export async function buildGraph(sample: GraphNode[]): Promise<Graph> {
  const nodes: GraphNode[] = [];
  const people: number[][] = [];

  for (const node of sample) {
    const ids = await peopleFor(node.tmdbId, node.type);
    if (!ids) continue;
    nodes.push(node);
    people.push(ids);
  }

  // Invert once, then read edges off it. Comparing every pair directly would be O(n^2)
  // set intersections; this is one pass to build the map and one to read it.
  const byPerson = new Map<number, number[]>();
  people.forEach((ids, i) => {
    for (const id of ids) {
      const bucket = byPerson.get(id);
      if (bucket) bucket.push(i);
      else byPerson.set(id, [i]);
    }
  });

  const edges: number[][] = nodes.map(() => []);
  for (const bucket of byPerson.values()) {
    // A person credited on one title in the sample creates no edge.
    if (bucket.length < 2) continue;
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        edges[bucket[a]].push(bucket[b]);
        edges[bucket[b]].push(bucket[a]);
      }
    }
  }

  return { people, nodes, edges: edges.map((list) => [...new Set(list)]) };
}

/**
 * Shortest-path distances from one node, by breadth-first search.
 *
 * Distance is in LINKS, so a neighbour is 1 and the node itself is 0. Unreachable nodes
 * are absent from the map rather than present with Infinity -- the caller wants "which
 * titles are exactly three away", and an absent key is the honest answer for a title in
 * another component of the graph entirely.
 */
export function distancesFrom(graph: Graph, start: number): Map<number, number> {
  const seen = new Map<number, number>([[start, 0]]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const node of frontier) {
      const depth = seen.get(node)!;
      for (const neighbour of graph.edges[node]) {
        if (seen.has(neighbour)) continue;
        seen.set(neighbour, depth + 1);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return seen;
}
