// Watch-history endpoints: R2 document + D1 pointer row.
//
// Everything pinned here fails SILENTLY in production. A sync that drops events still
// answers 200; a lost concurrent write looks like "that device is behind"; a stats total
// that counts sync batches instead of watches still renders a plausible number. None of
// it throws, so assertions are the only thing that can catch it.
//
// The merge RULES live in historyDoc.test.ts, against the pure module. This file tests
// the plumbing: authentication, the zero-write idle path, concurrency, and the
// write-conflict refusal that stops a client clearing an outbox that never landed.

import { describe, it, expect } from "vitest";
import {
  MAX_EVENTS_PER_SYNC,
  handleDeleteHistory,
  handleGetGlobalStats,
  handleGetHistory,
  handleGetHistoryStats,
  handleHistorySync,
  historyObjectKeys,
  parseEvent,
  parseEventId,
  parseRating,
} from "./history";
import { parseDoc } from "./historyDoc";

const A = "AAAAH73X7P55T48R4CFHDED9CW";
const B = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const TOKENS: Record<string, string> = { "tok-a": A, "tok-b": B };
const SEC = 1_700_000_000;

/** D1 stand-in. Unrecognised SQL throws — a fake that answers "no rows" hides a bug. */
class FakeD1 {
  sessions = new Map<string, string>();
  history_meta: any[] = [];

  prepare(sql: string) {
    return new FakeStmt(this, sql.replace(/\s+/g, " ").trim());
  }
  async batch(stmts: FakeStmt[]) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

class FakeStmt {
  args: any[] = [];
  constructor(private db: FakeD1, private sql: string) {}
  bind(...a: any[]) { this.args = a; return this; }

  async first<T>(): Promise<T | null> {
    const s = this.sql, a = this.args;
    if (s.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      const u = this.db.sessions.get(a[0]);
      return u ? ({ user_id: u, expires_at: Date.now() + 8.64e7, revoked_at: null } as T) : null;
    }
    if (s.startsWith("SELECT version, event_count, title_count, last_watched_at FROM history_meta")) {
      return (this.db.history_meta.find((r) => r.user_id === a[0]) as T) ?? null;
    }
    if (s.startsWith("SELECT COALESCE(SUM(event_count),0)")) {
      return {
        e: this.db.history_meta.reduce((n, r) => n + r.event_count, 0),
        t: this.db.history_meta.reduce((n, r) => n + r.title_count, 0),
        u: this.db.history_meta.length,
      } as T;
    }
    throw new Error(`FakeD1: unhandled first() ${this.sql}`);
  }

  async run() {
    const s = this.sql, a = this.args;
    if (s.startsWith("INSERT INTO history_meta")) {
      const [user_id, version, event_count, title_count, last_watched_at, updated_at] = a;
      const row = this.db.history_meta.find((r) => r.user_id === user_id);
      const next = { user_id, version, event_count, title_count, last_watched_at, updated_at };
      if (row) Object.assign(row, next);
      else this.db.history_meta.push(next);
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM history_meta")) {
      this.db.history_meta = this.db.history_meta.filter((r) => r.user_id !== a[0]);
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() ${this.sql}`);
  }
}

/**
 * R2 stand-in with REAL etag semantics.
 *
 * The conditional PUT is the only thing standing between two concurrent devices and
 * silent data loss, so a fake that ignored `onlyIf` would make the most dangerous
 * property in this feature untestable. `failNextPut` simulates losing that race.
 */
class FakeR2 {
  objects = new Map<string, { body: ArrayBuffer; etag: string }>();
  puts = 0;
  gets = 0;
  private seq = 0;
  /** Upcoming conditional PUTs to reject, as a concurrent writer would. */
  failNextPut = 0;

  async get(key: string) {
    this.gets++;
    const o = this.objects.get(key);
    if (!o) return null;
    return { etag: o.etag, arrayBuffer: async () => o.body };
  }

  async put(key: string, body: ArrayBuffer | string, opts?: any) {
    const existing = this.objects.get(key);
    const cond = opts?.onlyIf;

    if (this.failNextPut > 0) { this.failNextPut--; return null; }
    if (cond?.etagMatches != null && existing?.etag !== cond.etagMatches) return null;
    if (cond?.etagDoesNotMatch === "*" && existing) return null;

    const buf = typeof body === "string" ? new TextEncoder().encode(body).buffer : body;
    this.objects.set(key, { body: buf as ArrayBuffer, etag: `e${++this.seq}` });
    this.puts++;
    return { key };
  }

  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) this.objects.delete(k);
  }
}

class FakeKV {
  store = new Map<string, string>();
  async get(k: string) { const v = this.store.get(k); return v == null ? null : JSON.parse(v); }
  async put(k: string, v: string) { this.store.set(k, v); }
  async delete(k: string) { this.store.delete(k); }
}

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function env0() {
  const db = new FakeD1();
  for (const [tok, uid] of Object.entries(TOKENS)) db.sessions.set(await hash(tok), uid);
  const analytics: any[] = [];
  return {
    DB: db,
    BUCKET: new FakeR2(),
    HISTORY_STATS_KV: new FakeKV(),
    HISTORY_ANALYTICS: { writeDataPoint: (p: any) => analytics.push(p) },
    __analytics: analytics,
  } as any;
}

const syncReq = (token: string, body: unknown) =>
  new Request("https://flickto.app/api/history/sync", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const listReq = (token: string, qs = "") =>
  new Request(`https://flickto.app/api/history${qs}`, { headers: { Authorization: `Bearer ${token}` } });
const statsReq = (token: string) =>
  new Request("https://flickto.app/api/history/stats", { headers: { Authorization: `Bearer ${token}` } });
const delReq = (token: string) =>
  new Request("https://flickto.app/api/history/x", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });

const movie = (tmdbId: number, second: number, over: Record<string, unknown> = {}) => ({
  id: `watch-MOVIE-${tmdbId}-${second}`,
  mediaType: "MOVIE", tmdbId, watchedAt: second * 1000, ...over,
});
const ep = (tmdbId: number, s: number, e: number, second: number, over: Record<string, unknown> = {}) => ({
  id: `watch-EPISODE-${tmdbId}-s${s}e${e}-${second}`,
  mediaType: "SHOW", tmdbId, seasonNumber: s, episodeNumber: e, watchedAt: second * 1000, ...over,
});

const base = { events: [], ratings: [], version: 0 };
const docOf = async (env: any, userId = A) =>
  parseDoc(env.BUCKET.objects.get(`history/${userId}.json`)!.body);

describe("history: authentication", () => {
  it("refuses every endpoint without a session", async () => {
    const env = await env0();
    expect((await handleHistorySync(syncReq("nope", base), env)).status).toBe(401);
    expect((await handleGetHistory(listReq("nope"), env)).status).toBe(401);
    expect((await handleGetHistoryStats(statsReq("nope"), env)).status).toBe(401);
    expect((await handleDeleteHistory("x", delReq("nope"), env)).status).toBe(401);
  });
});

describe("history: the zero-write idle path", () => {
  it("writes nothing and never touches R2 when there is nothing to do", async () => {
    // The single most important cost property. The previous design wrote a cursor row on
    // EVERY pass — ~192 rows/device/day of pure heartbeat, which alone capped the free
    // tier at ~500 users. An installed app spends almost all its life on this path.
    const env = await env0();
    const res = await handleHistorySync(syncReq("tok-a", base), env);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.upToDate).toBe(true);
    expect(env.BUCKET.puts).toBe(0);
    expect(env.BUCKET.gets).toBe(0);
    expect(env.DB.history_meta).toHaveLength(0);
  });

  it("stays on the zero-write path once synced and current", async () => {
    const env = await env0();
    const first = await (await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env)).json();
    const putsAfterWrite = env.BUCKET.puts;

    const idle = await (await handleHistorySync(syncReq("tok-a", { ...base, version: first.version }), env)).json();
    expect(idle.upToDate).toBe(true);
    expect(idle.doc).toBeUndefined();
    expect(env.BUCKET.puts).toBe(putsAfterWrite);
  });
});

describe("history: sync", () => {
  it("stores an entire import as ONE history write", async () => {
    // The headline property: cost is no longer proportional to history size.
    const env = await env0();
    const events = Array.from({ length: 400 }, (_, i) => ep(1396, 1 + (i % 8), i, SEC + i));
    const res = await handleHistorySync(syncReq("tok-a", { ...base, events }), env);

    expect(res.status).toBe(200);
    expect(env.BUCKET.puts).toBe(2); // the history document + the public recent slice
    expect(env.DB.history_meta[0]).toMatchObject({ event_count: 400, title_count: 1, version: 1 });
  });

  it("keeps one account's history out of another's", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    const bs = await (await handleHistorySync(syncReq("tok-b", base), env)).json();
    expect(bs.stats.events).toBe(0);
    expect(env.BUCKET.objects.has(`history/${B}.json`)).toBe(false);
  });

  it("hands the whole document to a device that is behind", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    // A second device that has never synced sends version 0.
    const behind = await (await handleHistorySync(syncReq("tok-a", { ...base, version: 0 }), env)).json();
    expect(behind.upToDate).toBe(false);
    expect(behind.doc.titles["MOVIE|550"]).toBeDefined();
  });

  it("drops a malformed event and still stores the rest", async () => {
    // The client's outbox clears only on success, so failing a batch over one bad row
    // would wedge that queue permanently.
    const env = await env0();
    const res = await handleHistorySync(
      syncReq("tok-a", { ...base, events: [{ id: "", mediaType: "MOVIE" }, movie(550, SEC)] }),
      env,
    );
    expect(res.status).toBe(200);
    expect(env.DB.history_meta[0].event_count).toBe(1);
  });

  it("refuses an oversized batch rather than truncating it", async () => {
    // Truncating would tell the client everything synced while discarding the tail, and
    // those events would never be sent again.
    const env = await env0();
    const events = Array.from({ length: MAX_EVENTS_PER_SYNC + 1 }, (_, i) => movie(500 + i, SEC + i));
    const res = await handleHistorySync(syncReq("tok-a", { ...base, events }), env);
    expect(res.status).toBe(413);
    expect(env.BUCKET.puts).toBe(0);
  });

  it("bumps the version once per write", async () => {
    const env = await env0();
    const a = await (await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env)).json();
    const b = await (
      await handleHistorySync(syncReq("tok-a", { ...base, version: a.version, events: [movie(680, SEC)] }), env)
    ).json();
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
  });
});

describe("history: concurrency", () => {
  it("retries the merge when another device wins the race", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);

    env.BUCKET.failNextPut = 2; // lose twice, then succeed
    const res = await handleHistorySync(syncReq("tok-a", { ...base, version: 1, events: [movie(680, SEC)] }), env);
    expect(res.status).toBe(200);

    const doc = await docOf(env);
    expect(doc.titles["MOVIE|550"]).toBeDefined();
    expect(doc.titles["MOVIE|680"]).toBeDefined();
  });

  it("answers 409 rather than 200 when every attempt loses", async () => {
    // ⚠️ The critical one. A 200 here would have the client clear an outbox whose
    // contents were never stored — silent, permanent loss of those watches.
    const env = await env0();
    env.BUCKET.failNextPut = 99;
    const res = await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    expect(res.status).toBe(409);
    expect(env.DB.history_meta).toHaveLength(0);
  });

  it("lets only one of two brand-new writers create the object", async () => {
    // Both devices see "no object" and take the create path; without the
    // etagDoesNotMatch guard the loser's entire first upload would vanish.
    const env = await env0();
    env.BUCKET.failNextPut = 1;
    const res = await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    expect(res.status).toBe(200);
    expect((await docOf(env)).titles["MOVIE|550"]).toBeDefined();
  });
});

describe("history: delete", () => {
  it("tombstones the event so the deletion reaches other devices", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);

    const res = await handleDeleteHistory(`watch-MOVIE-550-${SEC}`, delReq("tok-a"), env);
    expect(res.status).toBe(200);

    const doc = await docOf(env);
    expect(doc.titles["MOVIE|550"]).toBeUndefined();
    expect(doc.deleted[`watch-MOVIE-550-${SEC}`]).toBeGreaterThan(0);
    expect(env.DB.history_meta[0].event_count).toBe(0);
  });

  it("cannot reach another account's history", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    await handleDeleteHistory(`watch-MOVIE-550-${SEC}`, delReq("tok-b"), env);
    // B's delete writes B's own (empty) document; A's is untouched.
    expect((await docOf(env, A)).titles["MOVIE|550"]).toBeDefined();
  });

  it("rejects an unparseable id instead of guessing", async () => {
    const env = await env0();
    expect((await handleDeleteHistory("nonsense", delReq("tok-a"), env)).status).toBe(400);
  });
});

describe("history: event id parsing", () => {
  it("recovers title and second from the canonical ids", () => {
    // Parsing rather than storing these strings is a large part of the 59x size win —
    // at 2 billion events the ids alone were ~70 GB.
    expect(parseEventId("watch-EPISODE-1396-s2e5-1753027200")).toMatchObject({
      mediaType: "SHOW", tmdbId: 1396, seasonNumber: 2, episodeNumber: 5, watchedAt: 1753027200000,
    });
    expect(parseEventId("watch-MOVIE-550-1753027200")).toMatchObject({
      mediaType: "MOVIE", tmdbId: 550, watchedAt: 1753027200000,
    });
    expect(parseEventId("watch-MOVIE-550-bad")).toBeNull();
    expect(parseEventId("")).toBeNull();
  });
});

describe("history: stats", () => {
  it("serves per-user totals from the pointer row without reading R2", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC), ep(1396, 1, 1, SEC)] }), env);
    const getsBefore = env.BUCKET.gets;

    const stats = await (await handleGetHistoryStats(statsReq("tok-a"), env)).json();
    expect(stats).toMatchObject({ events: 2, titles: 2, version: 1 });
    expect(env.BUCKET.gets).toBe(getsBefore);
  });

  it("drops the cached stats when a sync changes them", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    expect((await (await handleGetHistoryStats(statsReq("tok-a"), env)).json()).events).toBe(1);
    expect(env.HISTORY_STATS_KV.store.has(`history:stats:${A}`)).toBe(true);

    await handleHistorySync(syncReq("tok-a", { ...base, version: 1, events: [movie(680, SEC)] }), env);
    expect(env.HISTORY_STATS_KV.store.has(`history:stats:${A}`)).toBe(false);
    expect((await (await handleGetHistoryStats(statsReq("tok-a"), env)).json()).events).toBe(2);
  });

  it("sums exact fleet totals from the pointer rows, never from anyone's history", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC), movie(680, SEC)] }), env);
    await handleHistorySync(syncReq("tok-b", { ...base, events: [ep(1396, 1, 1, SEC)] }), env);

    const g = await (await handleGetGlobalStats(new Request("https://flickto.app/api/stats/global"), env)).json();
    expect(g).toMatchObject({ totalWatches: 3, users: 2 });
  });

  it("still reports totals with no Analytics credential", async () => {
    // The headline number is what users see; it must not depend on the optional half.
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    const g = await (await handleGetGlobalStats(new Request("https://flickto.app/api/stats/global"), env)).json();
    expect(g.totalWatches).toBe(1);
    expect(g.topTitles).toEqual([]);
  });
});

describe("history: analytics batching", () => {
  it("emits one data point per TITLE carrying a count, not one per event", async () => {
    // Per event at 2 billion events would be ~$497/month. The count lives IN the point,
    // so queries must SUM it — COUNT would report the number of sync batches.
    const env = await env0();
    await handleHistorySync(
      syncReq("tok-a", { ...base, events: [ep(1396, 1, 1, SEC), ep(1396, 1, 2, SEC + 1), movie(550, SEC)] }),
      env,
    );
    expect(env.__analytics).toHaveLength(2);
    expect(env.__analytics.find((p: any) => p.blobs[2] === "1396").doubles[0]).toBe(2);
    expect(env.__analytics.find((p: any) => p.blobs[2] === "550").doubles[0]).toBe(1);
  });

  it("does not double-count a re-sent batch", async () => {
    // The outbox re-sends whenever a response is lost after the write landed. Counting
    // the whole document each time would inflate fleet totals on every dropped connection.
    const env = await env0();
    const batch = { ...base, events: [movie(550, SEC)] };
    await handleHistorySync(syncReq("tok-a", batch), env);
    await handleHistorySync(syncReq("tok-a", batch), env);
    const total = env.__analytics.reduce((n: number, p: any) => n + p.doubles[0], 0);
    expect(total).toBe(1);
  });
});

describe("history: paginated read", () => {
  it("returns newest first and pages without losing rows on a timestamp tie", async () => {
    // A whole season imported from Trakt shares one timestamp. The old keyset cursor
    // stepped over the rest of the tie at a page boundary; this list is materialised from
    // one snapshot, so it cannot.
    const env = await env0();
    const events = [1, 2, 3, 4].map((e) => ep(1396, 1, e, SEC));
    await handleHistorySync(syncReq("tok-a", { ...base, events }), env);

    const p1 = await (await handleGetHistory(listReq("tok-a", "?limit=2"), env)).json();
    const p2 = await (await handleGetHistory(listReq("tok-a", `?limit=2&offset=${p1.nextOffset}`), env)).json();
    expect(p1.total).toBe(4);
    expect([...p1.events, ...p2.events]).toHaveLength(4);
    expect(p2.nextOffset).toBeNull();
  });

  it("filters by media type", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC), ep(1396, 1, 1, SEC)] }), env);
    const movies = await (await handleGetHistory(listReq("tok-a", "?type=MOVIE"), env)).json();
    expect(movies.events).toHaveLength(1);
    expect(movies.events[0].mediaType).toBe("MOVIE");
  });
});

describe("history: the public slice", () => {
  it("publishes a separate small object, never the private document", async () => {
    // Serving the private document publicly would expose the user's entire viewing
    // history to anyone holding the URL.
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);

    const [priv, pub] = historyObjectKeys(A);
    expect(env.BUCKET.objects.has(priv)).toBe(true);
    const recent = JSON.parse(new TextDecoder().decode(env.BUCKET.objects.get(pub)!.body));
    expect(recent.totals.events).toBe(1);
    expect(recent.recent[0]).toMatchObject({ tmdbId: 550 });
    expect(recent.titles).toBeUndefined(); // no raw history in the public copy
  });
});

describe("history: validation", () => {
  it("rejects the fields that become keys or totals", () => {
    expect(parseEvent({ ...movie(550, SEC), id: "" })).toBeNull();
    expect(parseEvent({ ...movie(550, SEC), mediaType: "PODCAST" })).toBeNull();
    expect(parseEvent({ ...movie(550, SEC), tmdbId: 0 })).toBeNull();
    expect(parseEvent({ ...movie(550, SEC), watchedAt: Number.NaN })).toBeNull();
    expect(parseEvent({ ...movie(550, SEC), seasonNumber: "1" })).toBeNull();
    expect(parseRating({ mediaType: "MOVIE", tmdbId: 550, rating: 11, updatedAt: 1 })).toBeNull();
    expect(parseRating({ mediaType: "MOVIE", tmdbId: 550, rating: 0, updatedAt: 1 })).toBeNull();
  });

  it("clamps a nonsense progress rather than discarding the watch", () => {
    expect(parseEvent({ ...movie(550, SEC), progressPct: 3000 })!.progressPct).toBe(100);
    expect(parseEvent({ ...movie(550, SEC), progressPct: -7 })!.progressPct).toBe(0);
  });
});
