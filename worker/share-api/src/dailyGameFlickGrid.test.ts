import { describe, it, expect, beforeEach } from "vitest";
import { TestD1, seedSession, seedUser, testEnv, uid } from "./testD1";
import { handlePostResult } from "./dailyGame";
import { __resetTitleIndexForTests } from "./titleIndex";

/**
 * FlickGrid: nine picks, each checked against its own square, and rarity counted from
 * everyone who played.
 *
 * This is the first verifier that has to know what a title IS rather than only its id, so
 * most of what follows is about the worker refusing to take the client's word for a pick.
 * A grid scored client-side would let one person write whatever they liked into everybody
 * else's "only 4% picked this".
 */

const DAY = 86_400_000;
const iso = (o = 0) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);

const ACTION = 2 ** 0, COMEDY = 2 ** 3, DRAMA = 2 ** 6, SCIFI = 2 ** 14;
// Bit 32, past what a JS bitwise operator can reach. A genre constraint on this is the
// one that silently fails if anybody "simplifies" the BigInt away.
const SUSPENSE = 2 ** 32;

/** [title, year, type, genreMask, ratingTenths, tmdbId] — the published tuple shape. */
const INDEX_ROWS: Array<[string, number, number, number, number, number]> = [
  ["Interstellar",      2014, 0, SCIFI + DRAMA, 87, 157336],
  ["Arrival",           2016, 0, SCIFI + DRAMA, 77, 329865],
  ["Superbad",          2007, 0, COMEDY,        71, 8363],
  ["Mad Max: Fury Road",2015, 0, ACTION + SCIFI,77, 76341],
  ["Sicario",           2015, 0, ACTION + SUSPENSE, 76, 273481],
  ["The Wire",          2002, 1, DRAMA,         89, 1438],
  ["Severance",         2022, 1, SCIFI + DRAMA, 86, 95396],
];

/**
 * The day's grid.
 *   cols: 2010s | Sci-Fi | Rated 8.0+
 *   rows: Film  | TV     | Drama
 */
const SPEC = {
  rows: [
    { kind: "type", type: 0 },
    { kind: "type", type: 1 },
    { kind: "genre", slug: "drama" },
  ],
  cols: [
    { kind: "decade", decade: 2010 },
    { kind: "genre", slug: "science-fiction" },
    { kind: "minRating", tenths: 80 },
  ],
};

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Serves the grid answer AND the title index, both out of the same bucket. */
function bucket(spec: unknown = SPEC, rows = INDEX_ROWS) {
  return {
    async get(key: string) {
      if (key === "content/game/titles.v2.json") {
        return { async json() { return rows; } };
      }
      if (key.startsWith("game-state/answers/flickgrid/")) {
        const date = key.slice("game-state/answers/flickgrid/".length).replace(/\.json$/, "");
        return {
          async json() {
            return { date, puzzleNumber: 7, tmdbId: 0, title: "", grid: spec };
          },
        };
      }
      return null;
    },
  };
}

const env = (db: TestD1, b: unknown = bucket()) => testEnv(db, { CONTENT_BUCKET: b });

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

const board = (guesses: number[], types: number[]) => ({
  game: "flickgrid",
  results: [{ date: iso(), guesses, types }],
});

/** The module caches the parsed index for the life of the isolate; tests need a fresh one. */
beforeEach(() => __resetTitleIndexForTests());

describe("a pick is checked against its own square", () => {
  it("scores a fully correct board", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    /*
     * cell 0 Film+2010s      -> Interstellar
     * cell 1 Film+Sci-Fi     -> Arrival
     * cell 2 Film+8.0+       -> Interstellar
     * cell 3 TV+2010s        -> (none in the index) leave blank
     * cell 4 TV+Sci-Fi       -> Severance
     * cell 5 TV+8.0+         -> The Wire
     * cell 6 Drama+2010s     -> Interstellar
     * cell 7 Drama+Sci-Fi    -> Arrival
     * cell 8 Drama+8.0+      -> The Wire
     */
    const ids   = [157336, 329865, 157336, 0, 95396, 1438, 157336, 329865, 1438];
    const types = [0,      0,      0,      0, 1,     1,    0,      0,      1];

    const res = await handlePostResult(post(board(ids, types), me.token), env(db));
    expect(res.status).toBe(200);

    const row = db.one<{ score: number; guess_count: number; solved: number }>(
      "SELECT score, guess_count, solved FROM daily_game_results WHERE game = 'flickgrid'",
    );
    // Eight of nine, because cell 3 was deliberately left blank.
    expect(row).toEqual({ score: 89, guess_count: 8, solved: 0 });
  });

  it("does not credit a title that misses its square", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    // Superbad is a 2007 comedy: right namespace, wrong everything else.
    const ids   = [8363, 0, 0, 0, 0, 0, 0, 0, 0];
    const types = [0,    0, 0, 0, 0, 0, 0, 0, 0];
    await handlePostResult(post(board(ids, types), me.token), env(db));
    expect(db.one<{ score: number }>("SELECT score FROM daily_game_results")).toEqual({ score: 0 });
  });

  it("credits a genre that lives on bit 32, which a plain & would lose", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    // Sicario carries `suspense` (bit 32) plus action. Cell 0 is Film+2010s, which it
    // meets -- what is being pinned is that a mask ABOVE bit 31 still decodes at all.
    const spec = {
      rows: [{ kind: "genre", slug: "suspense" }, { kind: "type", type: 1 }, { kind: "type", type: 0 }],
      cols: [{ kind: "decade", decade: 2010 }, { kind: "type", type: 0 }, { kind: "type", type: 0 }],
    };
    const ids   = [273481, 0, 0, 0, 0, 0, 0, 0, 0];
    const types = [0,      0, 0, 0, 0, 0, 0, 0, 0];
    await handlePostResult(post(board(ids, types), me.token), env(db, bucket(spec)));
    expect(db.one<{ guess_count: number }>("SELECT guess_count FROM daily_game_results"))
      .toEqual({ guess_count: 1 });
  });

  it("marks a perfect nine as solved", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    // Every square is "Film", so any film fills the board.
    const spec = {
      rows: [{ kind: "type", type: 0 }, { kind: "type", type: 0 }, { kind: "type", type: 0 }],
      cols: [{ kind: "type", type: 0 }, { kind: "type", type: 0 }, { kind: "type", type: 0 }],
    };
    const ids = new Array(9).fill(157336);
    const types = new Array(9).fill(0);
    await handlePostResult(post(board(ids, types), me.token), env(db, bucket(spec)));
    expect(db.one<{ score: number; solved: number }>("SELECT score, solved FROM daily_game_results"))
      .toEqual({ score: 100, solved: 1 });
  });
});

describe("an unverifiable board is dropped, never trusted", () => {
  it("refuses a board that is not nine squares", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(
      post({ game: "flickgrid", results: [{ date: iso(), guesses: [157336], types: [0] }] }, me.token),
      env(db),
    );
    // Short arrays are rejected rather than padded: six ids would otherwise be read as
    // the first six squares, which is not what the player did.
    expect(res.status).toBe(400);
  });

  it("refuses when the title index cannot be read", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const noIndex = {
      async get(key: string) {
        if (key === "content/game/titles.v2.json") return null;
        return bucket().get(key);
      },
    };
    const ids = new Array(9).fill(157336);
    const types = new Array(9).fill(0);
    const res = await handlePostResult(post(board(ids, types), me.token), env(db, noIndex));
    expect(res.status).toBe(400);
    // Nothing stored: an unverifiable grid must not become a row that rarity is counted from.
    expect(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM daily_game_results")).toEqual({ n: 0 });
  });

  it("refuses an id sent without its namespace", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const ids = new Array(9).fill(157336);
    const res = await handlePostResult(
      post({ game: "flickgrid", results: [{ date: iso(), guesses: ids }] }, me.token), env(db),
    );
    // No `types` at all: an id alone is not a title, because films and shows are
    // numbered separately.
    expect(res.status).toBe(400);
  });
});

describe("rarity counts everyone who played", () => {
  const FILM_EVERYWHERE = {
    rows: [{ kind: "type", type: 0 }, { kind: "type", type: 0 }, { kind: "type", type: 0 }],
    cols: [{ kind: "type", type: 0 }, { kind: "type", type: 0 }, { kind: "type", type: 0 }],
  };
  const fill = (id: number) => board(new Array(9).fill(id), new Array(9).fill(0));

  it("includes the player's own answer in its own denominator", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const res = await handlePostResult(post(fill(157336), me.token), env(db, bucket(FILM_EVERYWHERE)));
    const body = await res.json() as { rarity: Array<{ count: number; total: number } | null> };

    // The FIRST person to play a square is 1 of 1, not 0 of 0. Reading the counts before
    // the bump would report 0%, which is both wrong and the most memorable number the
    // game can show.
    expect(body.rarity[0]).toEqual({ cell: 0, count: 1, total: 1 });
  });

  it("counts anonymous players too", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const e = env(db, bucket(FILM_EVERYWHERE));

    await handlePostResult(post(fill(157336), me.token), e);   // signed in
    await handlePostResult(post(fill(157336)), e);             // anonymous
    await handlePostResult(post(fill(76341)), e);              // anonymous, different pick

    const total = db.one<{ t: number }>(
      "SELECT SUM(count) AS t FROM daily_game_flickgrid_picks WHERE cell = 0",
    );
    expect(total).toEqual({ t: 3 });

    const popular = db.one<{ count: number }>(
      "SELECT count FROM daily_game_flickgrid_picks WHERE cell = 0 AND tmdb_id = 157336",
    );
    expect(popular).toEqual({ count: 2 });
  });

  it("keeps the same title in different squares apart", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    await handlePostResult(post(fill(157336), me.token), env(db, bucket(FILM_EVERYWHERE)));
    // Naming an obvious film for a hard square is not the same move as naming it for an
    // easy one, so the counts must not be pooled across cells.
    const rows = db.rows<{ cell: number }>(
      "SELECT cell FROM daily_game_flickgrid_picks WHERE tmdb_id = 157336 ORDER BY cell",
    );
    expect(rows.map((r) => r.cell)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("does not count a blank square", async () => {
    const db = new TestD1();
    const me = await player(db, 1);
    const ids = [157336, 0, 0, 0, 0, 0, 0, 0, 0];
    const types = new Array(9).fill(0);
    await handlePostResult(
      post({ game: "flickgrid", results: [{ date: iso(), guesses: ids, types }] }, me.token),
      env(db, bucket(FILM_EVERYWHERE)),
    );
    // A blank is not a pick. Counting it would make the per-cell total the number of
    // PLAYERS rather than the number of answers, which is not what rarity divides by.
    expect(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM daily_game_flickgrid_picks"))
      .toEqual({ n: 1 });
  });
});
