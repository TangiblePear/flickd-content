import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TestD1, seedSession, seedUser, testEnv, uid } from "./testD1";
import { handlePostResult } from "./dailyGame";
import { linkScore } from "./dailyGame";

/**
 * Flicklink: the endpoints and the length.
 *
 * What this verifier deliberately does NOT check -- that each consecutive pair really
 * shares a person -- is documented at verifyLink. These tests pin what it does check, and
 * the shared scoring contract both implementations read.
 */

const DAY = 86_400_000;
const iso = (o = 0) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);

const START = { tmdbId: 157336, type: 0 };
const END = { tmdbId: 419430, type: 0 };
const PAR = 3;
const MOVE_LIMIT = 8;

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "..", "..", "..", "docs", "game", "link-fixtures.json"), "utf8"),
) as { cases: Array<{ name: string; links: number; par: number; score: number }> };

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bucket() {
  return {
    async get(key: string) {
      if (!key.startsWith("game-state/answers/link/")) return null;
      const date = key.slice("game-state/answers/link/".length).replace(/\.json$/, "");
      return {
        async json() {
          return {
            date, puzzleNumber: 3, tmdbId: END.tmdbId, title: "Get Out",
            link: { start: START, end: END, par: PAR, moveLimit: MOVE_LIMIT },
          };
        },
      };
    },
  };
}

const env = (db: TestD1) => testEnv(db, { CONTENT_BUCKET: bucket() });

const post = (body: unknown, token?: string) =>
  new Request("https://flickto.app/api/daily-game/result", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });

async function player(db: TestD1, n: number) {
  const id = uid(n);
  seedUser(db, { id, displayName: `Player ${n}` });
  const token = `token-${n}`;
  seedSession(db, id, await hash(token));
  return { id, token };
}

/** A chain: start, the given middles, then the end. */
const chain = (middle: number[]) => ({
  game: "link",
  results: [{
    date: iso(),
    guesses: [START.tmdbId, ...middle, END.tmdbId],
    types: [START.type, ...middle.map(() => 0), END.type],
  }],
});

describe("the chain must run between the day's endpoints", () => {
  it("accepts a route that starts and finishes where it was told to", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(post(chain([329865, 1124]), me.token), env(db));
    expect(res.status).toBe(200);
    const row = db.one<{ guess_count: number; solved: number; score: number }>(
      "SELECT guess_count, solved, score FROM daily_game_results WHERE game = 'link'",
    );
    // Four titles is three links, which is par.
    expect(row).toEqual({ guess_count: 3, solved: 1, score: 100 });
  });

  it("refuses a chain that starts somewhere else", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(
      post({ game: "link", results: [{ date: iso(), guesses: [999, 329865, END.tmdbId], types: [0, 0, 0] }] }, me.token),
      env(db),
    );
    expect(res.status).toBe(400);
  });

  it("refuses a chain that finishes somewhere else", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(
      post({ game: "link", results: [{ date: iso(), guesses: [START.tmdbId, 329865, 999], types: [0, 0, 0] }] }, me.token),
      env(db),
    );
    expect(res.status).toBe(400);
  });

  it("refuses the endpoints touching with nothing between them", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(post(chain([]), me.token), env(db));
    // Two entries is start-meets-end, which the generator's par of two or more says
    // cannot happen.
    expect(res.status).toBe(400);
  });

  it("refuses a chain that visits the same title twice", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(post(chain([329865, 329865]), me.token), env(db));
    // A loop is never a shorter route -- it is a client that lost track of its state.
    expect(res.status).toBe(400);
  });

  it("refuses a route longer than the move limit", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const middle = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const res = await handlePostResult(post(chain(middle), me.token), env(db));
    expect(res.status).toBe(400);
  });

  it("refuses an id sent without its namespace", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(
      post({ game: "link", results: [{ date: iso(), guesses: [START.tmdbId, 329865, END.tmdbId] }] }, me.token),
      env(db),
    );
    expect(res.status).toBe(400);
  });

  it("scores a shorter route higher than a longer one", async () => {
    const db = new TestD1();
    const quick = await player(db, 1);
    const slow = await player(db, 2);
    await handlePostResult(post(chain([329865]), quick.token), env(db));           // 2 links
    await handlePostResult(post(chain([1, 2, 3, 4]), slow.token), env(db));        // 5 links
    const rows = db.rows<{ user_id: string; score: number }>(
      "SELECT user_id, score FROM daily_game_results WHERE game = 'link' ORDER BY score DESC",
    );
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    expect(rows[0].user_id).toBe(quick.id);
  });
});

describe("the shared Flicklink scoring contract", () => {
  it.each(fixture.cases)("$name", (c) => {
    expect(linkScore(c.links, c.par)).toBe(c.score);
  });
});
