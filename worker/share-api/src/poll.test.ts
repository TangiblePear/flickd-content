// Episode community poll — the counter arithmetic.
//
// Everything pinned here fails SILENTLY rather than visibly: a wrong denominator
// still renders a plausible percentage, and a missed decrement still renders a
// plausible bar. Nothing throws, so only assertions catch it.

import { describe, it, expect } from "vitest";
import { handleGetPoll, handlePutVote, parseVote } from "./poll";

const A = "AAAAH73X7P55T48R4CFHDED9CW";
const B = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const TOKENS: Record<string, string> = { "tok-a": A, "tok-b": B };

const EP = { tmdbId: 1396, mediaType: "show" as const, season: 2, episode: 5 };

/**
 * Hand-rolled D1 stand-in, the shape the other suites established: every SQL prefix
 * the handler issues gets an explicit branch and anything unrecognised throws. A
 * fake that quietly answers "no rows" turns a broken query into a passing test.
 */
class FakeD1 {
  sessions = new Map<string, string>();
  episode_votes: any[] = [];
  episode_vote_counts: any[] = [];
  episode_option_counts: any[] = [];

  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
  async batch(stmts: FakeStmt[]) {
    for (const s of stmts) await s.run();
    return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

const sameSubject = (r: any, a: any[]) =>
  r.tmdb_id === a[0] && r.media_type === a[1] && r.season === a[2] && r.episode === a[3];

class FakeStmt {
  args: any[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...a: any[]) {
    this.args = a;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const s = this.sql;
    const a = this.args;
    if (s.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      const u = this.db.sessions.get(a[0]);
      return u ? ({ user_id: u, expires_at: Date.now() + 8.64e7, revoked_at: null } as T) : null;
    }
    if (s.trimStart().startsWith("SELECT n_voters")) {
      return (this.db.episode_vote_counts.find((r) => sameSubject(r, a)) ?? null) as T;
    }
    if (s.trimStart().startsWith("SELECT rating, emotions, favourite_option_id")) {
      const row = this.db.episode_votes.find((r) => r.user_id === a[0] && sameSubject(r, a.slice(1)));
      return (row ?? null) as T;
    }
    throw new Error(`FakeD1: unhandled first() ${s}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const s = this.sql;
    const a = this.args;
    if (s.trimStart().startsWith("SELECT kind, option_id, n")) {
      return { results: this.db.episode_option_counts.filter((r) => sameSubject(r, a) && r.n > 0) as T[] };
    }
    throw new Error(`FakeD1: unhandled all() ${s}`);
  }

  async run() {
    const s = this.sql;
    const a = this.args;
    if (s.trimStart().startsWith("INSERT INTO episode_vote_counts")) {
      const [tmdb_id, media_type, season, episode, iv, ir, isum, dv, dr, dsum] = a;
      const row = this.db.episode_vote_counts.find((r) => sameSubject(r, a));
      if (row) {
        row.n_voters = Math.max(0, row.n_voters + dv);
        row.n_ratings = Math.max(0, row.n_ratings + dr);
        row.rating_sum = Math.max(0, row.rating_sum + dsum);
      } else {
        this.db.episode_vote_counts.push({
          tmdb_id,
          media_type,
          season,
          episode,
          n_voters: iv,
          n_ratings: ir,
          rating_sum: isum,
        });
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (s.trimStart().startsWith("INSERT INTO episode_option_counts")) {
      const [tmdb_id, media_type, season, episode, kind, option_id, insertN, delta] = a;
      const row = this.db.episode_option_counts.find(
        (r) => sameSubject(r, a) && r.kind === kind && r.option_id === option_id,
      );
      if (row) row.n = Math.max(0, row.n + delta);
      else this.db.episode_option_counts.push({ tmdb_id, media_type, season, episode, kind, option_id, n: insertN });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.trimStart().startsWith("INSERT INTO episode_votes")) {
      const [user_id, tmdb_id, media_type, season, episode, rating, emotions, favourite_option_id, updated_at] = a;
      const row = this.db.episode_votes.find((r) => r.user_id === user_id && sameSubject(r, a.slice(1)));
      if (row) Object.assign(row, { rating, emotions, favourite_option_id, updated_at });
      else
        this.db.episode_votes.push({
          user_id,
          tmdb_id,
          media_type,
          season,
          episode,
          rating,
          emotions,
          favourite_option_id,
          updated_at,
        });
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() ${s}`);
  }
}

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function env0() {
  const db = new FakeD1();
  for (const [tok, uid] of Object.entries(TOKENS)) db.sessions.set(await hash(tok), uid);
  return { DB: db } as any;
}

const vote = (token: string, body: unknown) =>
  new Request("https://flickto.app/api/titles/show/1396/vote?season=2&episode=5", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const read = () => new Request("https://flickto.app/api/titles/show/1396/poll?season=2&episode=5");

const counts = (e: any) => e.DB.episode_vote_counts[0];
const option = (e: any, kind: string, id: string) =>
  e.DB.episode_option_counts.find((r: any) => r.kind === kind && r.option_id === id);

describe("episode poll", () => {
  it("an episode nobody voted on reads as zeroes, not an error", async () => {
    const e = await env0();
    const res = await handleGetPoll(read(), e, EP);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nVoters: 0, nRatings: 0, ratingSum: 0, options: [] });
  });

  it("a first vote creates the totals and one row per option", async () => {
    const e = await env0();
    await handlePutVote(vote("tok-a", { rating: 8, emotions: ["SHOCKED", "SAD"], favouriteOptionId: "TMDB:p17419" }), e, EP);

    expect(counts(e)).toMatchObject({ n_voters: 1, n_ratings: 1, rating_sum: 8 });
    expect(option(e, "emotion", "SHOCKED").n).toBe(1);
    expect(option(e, "emotion", "SAD").n).toBe(1);
    expect(option(e, "person", "TMDB:p17419").n).toBe(1);
  });

  /**
   * The whole reason `n_ratings` exists. Someone can react without rating, and
   * dividing `rating_sum` by `n_voters` would silently deflate every average — a
   * plausible-looking number that is simply wrong.
   */
  it("an emotion-only vote counts as a voter but not as a rating", async () => {
    const e = await env0();
    await handlePutVote(vote("tok-a", { rating: 10, emotions: [] }), e, EP);
    await handlePutVote(vote("tok-b", { emotions: ["SAD"] }), e, EP);

    const c = counts(e);
    expect(c.n_voters).toBe(2);
    expect(c.n_ratings).toBe(1);
    expect(c.rating_sum).toBe(10);
    // The average is 10, not 5.
    expect(c.rating_sum / c.n_ratings).toBe(10);
  });

  /** Editing is not a new voter. Otherwise every change of mind inflates the denominator. */
  it("changing your own vote never increments the voter count", async () => {
    const e = await env0();
    await handlePutVote(vote("tok-a", { rating: 4, emotions: ["SAD"] }), e, EP);
    await handlePutVote(vote("tok-a", { rating: 9, emotions: ["SAD"] }), e, EP);

    expect(counts(e)).toMatchObject({ n_voters: 1, n_ratings: 1, rating_sum: 9 });
    expect(e.DB.episode_votes).toHaveLength(1);
  });

  it("swapping an emotion decrements the old one and increments the new", async () => {
    const e = await env0();
    await handlePutVote(vote("tok-a", { emotions: ["SHOCKED"] }), e, EP);
    await handlePutVote(vote("tok-a", { emotions: ["AMUSED"] }), e, EP);

    expect(option(e, "emotion", "SHOCKED").n).toBe(0);
    expect(option(e, "emotion", "AMUSED").n).toBe(1);
  });

  /** A pick that did not change must not be double-counted by the diff. */
  it("re-submitting the same picks leaves the counts alone", async () => {
    const e = await env0();
    await handlePutVote(vote("tok-a", { rating: 7, emotions: ["SAD"], favouriteOptionId: "TMDB:p5" }), e, EP);
    await handlePutVote(vote("tok-a", { rating: 7, emotions: ["SAD"], favouriteOptionId: "TMDB:p5" }), e, EP);

    expect(counts(e)).toMatchObject({ n_voters: 1, n_ratings: 1, rating_sum: 7 });
    expect(option(e, "emotion", "SAD").n).toBe(1);
    expect(option(e, "person", "TMDB:p5").n).toBe(1);
  });

  it("clearing a rating removes it from both the count and the sum", async () => {
    const e = await env0();
    await handlePutVote(vote("tok-a", { rating: 6, emotions: ["SAD"] }), e, EP);
    await handlePutVote(vote("tok-a", { emotions: ["SAD"] }), e, EP);

    expect(counts(e)).toMatchObject({ n_voters: 1, n_ratings: 0, rating_sum: 0 });
  });

  it("two voters accumulate", async () => {
    const e = await env0();
    await handlePutVote(vote("tok-a", { rating: 8, emotions: ["SAD"] }), e, EP);
    await handlePutVote(vote("tok-b", { rating: 6, emotions: ["SAD"] }), e, EP);

    expect(counts(e)).toMatchObject({ n_voters: 2, n_ratings: 2, rating_sum: 14 });
    expect(option(e, "emotion", "SAD").n).toBe(2);
  });

  it("refuses an unauthenticated vote", async () => {
    const e = await env0();
    const res = await handlePutVote(
      new Request("https://flickto.app/api/titles/show/1396/vote", { method: "PUT", body: "{}" }),
      e,
      EP,
    );
    expect(res.status).toBe(401);
  });

  /** A title-level vote would fork a counter row nothing ever reads. */
  it("refuses a title-level subject", async () => {
    const e = await env0();
    const res = await handlePutVote(vote("tok-a", { rating: 5 }), e, {
      ...EP,
      season: -1,
      episode: -1,
    });
    expect(res.status).toBe(400);
    expect(e.DB.episode_votes).toHaveLength(0);
  });
});

describe("parseVote", () => {
  it("accepts a vote with only some dimensions filled", () => {
    expect(parseVote({ emotions: ["SAD"] })).toEqual({
      rating: null,
      emotions: ["SAD"],
      favouriteOptionId: null,
    });
  });

  it("rejects a rating outside 1..10", () => {
    expect(parseVote({ rating: 0 })).toBeNull();
    expect(parseVote({ rating: 11 })).toBeNull();
    expect(parseVote({ rating: 7.5 })).toBeNull();
  });

  /** Emotion ids become PRIMARY KEY values, so they are validated rather than trusted. */
  it("rejects an emotion id outside the catalogue's alphabet", () => {
    expect(parseVote({ emotions: ["sad"] })).toBeNull();
    expect(parseVote({ emotions: ["SAD; DROP"] })).toBeNull();
    expect(parseVote({ emotions: [42] })).toBeNull();
  });

  it("de-duplicates repeated emotions so one voter cannot inflate a count", () => {
    expect(parseVote({ emotions: ["SAD", "SAD", "SAD"] })?.emotions).toEqual(["SAD"]);
  });

  /**
   * The favourite is a source-qualified CHARACTER key, not a bare person id -- one
   * performer voices several characters, and the cast comes from two different id
   * namespaces (Trakt relaying TMDB ids, or TVMaze). It becomes a PRIMARY KEY value,
   * so the shape is validated rather than trusted.
   */
  it("accepts a source-qualified character or person key", () => {
    expect(parseVote({ favouriteOptionId: "TVMAZE:c14839" })?.favouriteOptionId).toBe("TVMAZE:c14839");
    expect(parseVote({ favouriteOptionId: "TMDB:p9999" })?.favouriteOptionId).toBe("TMDB:p9999");
  });

  it("rejects a favourite option id outside that shape", () => {
    expect(parseVote({ favouriteOptionId: 17419 })).toBeNull();
    expect(parseVote({ favouriteOptionId: "17419" })).toBeNull();
    expect(parseVote({ favouriteOptionId: "tvmaze:c1" })).toBeNull();
    expect(parseVote({ favouriteOptionId: "TMDB:x9999" })).toBeNull();
    expect(parseVote({ favouriteOptionId: "TMDB:p" })).toBeNull();
    expect(parseVote({ favouriteOptionId: "TMDB:p1; DROP" })).toBeNull();
    // Unbounded ids would be unbounded index entries.
    expect(parseVote({ favouriteOptionId: "TMDB:p" + "9".repeat(40) })).toBeNull();
  });

  /**
   * The regression 0005 exists for: two characters voiced by ONE performer must land
   * in two buckets, not one.
   */
  it("keeps two characters of the same performer apart", async () => {
    const e = await env0();
    await handlePutVote(vote("tok-a", { favouriteOptionId: "TVMAZE:c101" }), e, EP);
    await handlePutVote(vote("tok-b", { favouriteOptionId: "TVMAZE:c102" }), e, EP);

    expect(option(e, "person", "TVMAZE:c101").n).toBe(1);
    expect(option(e, "person", "TVMAZE:c102").n).toBe(1);
  });
});
