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
import { parseDoc, serialiseDoc } from "./historyDoc";

const A = "AAAAH73X7P55T48R4CFHDED9CW";
const B = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const TOKENS: Record<string, string> = { "tok-a": A, "tok-b": B };
const SEC = 1_700_000_000;

/** D1 stand-in. Unrecognised SQL throws — a fake that answers "no rows" hides a bug. */
class FakeD1 {
  sessions = new Map<string, string>();
  history_meta: any[] = [];
  user_integrations: any[] = [];
  pending_integration_push: any[] = [];
  /** Fleet telemetry rows written off the back of a sync — see the telemetry describe. */
  user_telemetry: any[] = [];
  /** Days already rolled up. Pre-seeded so `maybeRollup` returns at its first read. */
  telemetry_daily = new Set<string>();

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
    if (s.startsWith("SELECT target FROM user_integrations")) {
      // `.all()` shape, but resolveSession-style handlers call `.first()` nowhere here.
      throw new Error("user_integrations is queried via all(), not first()");
    }
    if (s.startsWith("SELECT COALESCE(SUM(event_count),0)")) {
      return {
        e: this.db.history_meta.reduce((n, r) => n + r.event_count, 0),
        t: this.db.history_meta.reduce((n, r) => n + r.title_count, 0),
        u: this.db.history_meta.length,
      } as T;
    }
    if (s.startsWith("SELECT day FROM telemetry_daily")) {
      return (this.db.telemetry_daily.has(a[0]) ? { day: a[0] } : null) as T | null;
    }
    throw new Error(`FakeD1: unhandled first() ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const s = this.sql, a = this.args;
    if (s.startsWith("SELECT target FROM user_integrations")) {
      return { results: this.db.user_integrations.filter((r) => r.user_id === a[0] && r.connected === 1) as T[] };
    }
    if (s.startsWith("SELECT id, target, action, event_ids FROM pending_integration_push")) {
      const [userId, staleBefore, limit] = a;
      return {
        results: this.db.pending_integration_push
          .filter((r) => r.user_id === userId && (r.claimed_by == null || r.claimed_at < staleBefore))
          .sort((x, y) => x.created_at - y.created_at)
          .slice(0, limit) as T[],
      };
    }
    throw new Error(`FakeD1: unhandled all() ${this.sql}`);
  }

  async run() {
    const s = this.sql, a = this.args;
    if (s.startsWith("INSERT INTO pending_integration_push")) {
      const [id, user_id, target, ...rest] = a;
      // The ADD form binds action inline; the generic form passes it.
      const generic = s.includes("VALUES (?,?,?,?,?,?)");
      const action = generic ? rest[0] : (s.includes("'REMOVE'") ? "REMOVE" : "ADD");
      const event_ids = generic ? rest[1] : rest[0];
      const created_at = generic ? rest[2] : rest[1];
      this.db.pending_integration_push.push({ id, user_id, target, action, event_ids, created_at, claimed_by: null, claimed_at: null });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE pending_integration_push SET claimed_by = ?, claimed_at = ?")) {
      const [by, at, userId, id] = a;
      const r = this.db.pending_integration_push.find((x) => x.user_id === userId && x.id === id);
      if (r) { r.claimed_by = by; r.claimed_at = at; }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE pending_integration_push SET claimed_by = NULL")) {
      const [userId, id] = a;
      const r = this.db.pending_integration_push.find((x) => x.user_id === userId && x.id === id);
      if (r) { r.claimed_by = null; r.claimed_at = null; }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("DELETE FROM pending_integration_push WHERE user_id = ? AND target = ?")) {
      this.db.pending_integration_push = this.db.pending_integration_push.filter((x) => !(x.user_id === a[0] && x.target === a[1]));
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM pending_integration_push WHERE user_id = ? AND id = ?")) {
      this.db.pending_integration_push = this.db.pending_integration_push.filter((x) => !(x.user_id === a[0] && x.id === a[1]));
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM pending_integration_push")) {
      this.db.pending_integration_push = this.db.pending_integration_push.filter((x) => x.user_id !== a[0]);
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO user_integrations")) {
      const [user_id, target, connected, updated_at] = a;
      const r = this.db.user_integrations.find((x) => x.user_id === user_id && x.target === target);
      if (r) Object.assign(r, { connected, updated_at });
      else this.db.user_integrations.push({ user_id, target, connected, updated_at });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM user_integrations")) {
      this.db.user_integrations = this.db.user_integrations.filter((x) => x.user_id !== a[0]);
      return { success: true, meta: { changes: 1 } };
    }
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
    if (s.startsWith("INSERT INTO user_telemetry")) {
      // Mirrors the real ON CONFLICT(user_id, device_id) key and its once-a-day guard:
      // the second report of the same UTC day writes nothing.
      const [user_id, device_id, platform, version_code, country, last_seen_at, reported_on] = a;
      const row = this.db.user_telemetry.find((r) => r.user_id === user_id && r.device_id === device_id);
      if (!row) {
        this.db.user_telemetry.push({ user_id, device_id, platform, version_code, country, last_seen_at, reported_on });
        return { success: true, meta: { changes: 1 } };
      }
      if (row.reported_on === reported_on) return { success: true, meta: { changes: 0 } };
      Object.assign(row, { platform, version_code, country, last_seen_at, reported_on });
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
  // Yesterday is already rolled up, so `maybeRollup` returns at its first read instead of
  // running an aggregation this fake has no reason to model. Delete the entry in a test
  // that wants the rollup path.
  db.telemetry_daily.add(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
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

describe("history: fleet telemetry rides this endpoint", () => {
  // Telemetry used to be written ONLY by `/api/sync`, reached only by SocialSyncWorker —
  // a 24h job whose one prompt firing is spent before the user has signed in. Measured
  // against production on 2026-08-02: 9 accounts, 6 telemetry rows, and the 3 missing were
  // the 3 newest. This endpoint runs every 15 minutes for every signed-in device, so it is
  // what makes coverage independent of whether anyone opened the Friends tab.
  //
  // Every assertion here fails silently in production: a telemetry row that is never
  // written looks exactly like a device that is not there.

  it("records a row on the ZERO-WRITE idle path", async () => {
    // The important one. The idle path is where an installed app spends almost all its
    // life, so recording only on the write paths would rebuild the hole this closes.
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, deviceId: "dev-1" }), env);

    expect(env.DB.user_telemetry).toHaveLength(1);
    expect(env.DB.user_telemetry[0]).toMatchObject({ user_id: A, device_id: "dev-1", platform: "android" });
  });

  it("keys the row per device, so an account's phone and tablet do not overwrite each other", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, deviceId: "phone" }), env);
    await handleHistorySync(syncReq("tok-a", { ...base, deviceId: "tablet" }), env);

    expect(env.DB.user_telemetry.map((r) => r.device_id).sort()).toEqual(["phone", "tablet"]);
  });

  it("reads the app version off X-App-Version rather than the body", async () => {
    // This is what lets version data work without an app release: the header is already
    // stamped on every call by the client's OkHttp interceptor.
    const env = await env0();
    const req = new Request("https://flickto.app/api/history/sync", {
      method: "POST",
      headers: {
        Authorization: "Bearer tok-a",
        "Content-Type": "application/json",
        "X-App-Version": "33",
      },
      body: JSON.stringify({ ...base, deviceId: "dev-1" }),
    });
    await handleHistorySync(req, env);

    expect(env.DB.user_telemetry[0].version_code).toBe(33);
  });

  it("writes at most once per device per UTC day", async () => {
    const env = await env0();
    for (let i = 0; i < 5; i++) await handleHistorySync(syncReq("tok-a", { ...base, deviceId: "dev-1" }), env);

    expect(env.DB.user_telemetry).toHaveLength(1);
  });

  it("never records without a session", async () => {
    const env = await env0();
    expect((await handleHistorySync(syncReq("nope", base), env)).status).toBe(401);
    expect(env.DB.user_telemetry).toHaveLength(0);
  });

  it("still answers 200 when the telemetry write throws", async () => {
    // Telemetry must never fail, slow, or change the shape of a sync.
    const env = await env0();
    env.DB.prepare = (sql: string) => {
      if (sql.includes("user_telemetry")) throw new Error("D1 exploded");
      return FakeD1.prototype.prepare.call(env.DB, sql);
    };
    const res = await handleHistorySync(syncReq("tok-a", { ...base, deviceId: "dev-1" }), env);
    expect(res.status).toBe(200);
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

describe("history: integration reconciliation", () => {
  it("reports the server's integration state on EVERY response, idle included", async () => {
    // ⚠️ The fix for a silent, permanent bug. Registration used to fire only when the user
    // CONNECTED an integration — which anyone already connected never does again, so the
    // server never learned it existed and queued zero pushes forever. Found live: Trakt
    // connected, 2,916 Trakt-sourced events, `user_integrations` empty.
    //
    // Reporting it every pass lets the client reconcile with no marker that can go stale,
    // and self-heals if the table is ever lost.
    const env = await env0();
    env.DB.user_integrations.push({ user_id: A, target: "TRAKT", connected: 1, updated_at: 1 });

    const idle = await (await handleHistorySync(syncReq("tok-a", base), env)).json();
    expect(idle.upToDate).toBe(true);
    expect(idle.integrations).toEqual(["TRAKT"]);

    const writing = await (await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env)).json();
    expect(writing.integrations).toEqual(["TRAKT"]);
  });

  it("reports an empty list when nothing is connected", async () => {
    // The client must be able to tell "server says none" from "server did not say" —
    // an absent field would be indistinguishable from an old Worker.
    const env = await env0();
    const res = await (await handleHistorySync(syncReq("tok-a", base), env)).json();
    expect(res.integrations).toEqual([]);
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

// ── Delta pull ───────────────────────────────────────────────────────────────
//
// The document is a snapshot with a single version counter, so before the `mv` stamp the
// only honest answer to "you are behind" was the whole thing — measured at 17.5 KB and
// 2,917 client-side upserts to learn about ONE new episode. Every failure below is
// silent: too little sent is data the device never learns it is missing.
describe("history: delta pull", () => {
  it("sends only the titles that changed since the client's version", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    const at1 = await (
      await handleHistorySync(syncReq("tok-a", { ...base, version: 1, events: [movie(680, SEC)] }), env)
    ).json();
    expect(at1.version).toBe(2);

    // A second device sitting at v1 needs 680 and already has 550.
    const delta = await (await handleHistorySync(syncReq("tok-a", { ...base, version: 1 }), env)).json();
    expect(delta.upToDate).toBe(false);
    expect(delta.doc.titles["MOVIE|680"]).toBeDefined();
    expect(delta.doc.titles["MOVIE|550"]).toBeUndefined();
  });

  it("sends the whole document to a client at version 0", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    await handleHistorySync(syncReq("tok-a", { ...base, version: 1, events: [movie(680, SEC)] }), env);

    const fresh = await (await handleHistorySync(syncReq("tok-a", { ...base, version: 0 }), env)).json();
    expect(fresh.doc.titles["MOVIE|550"]).toBeDefined();
    expect(fresh.doc.titles["MOVIE|680"]).toBeDefined();
  });

  it("sends the whole document to a client somehow AHEAD of the server", async () => {
    // Cannot be reasoned about — a restored backup, a rolled-back bucket. Fail open.
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    const ahead = await (await handleHistorySync(syncReq("tok-a", { ...base, version: 99 }), env)).json();
    expect(ahead.upToDate).toBe(false);
    expect(ahead.doc.titles["MOVIE|550"]).toBeDefined();
  });

  it("always includes a title written BEFORE the stamp existed", async () => {
    // ⚠️ The migration case. Every title in R2 today has no `mv`; filtering those out
    // would hand a behind client an empty document it would accept as current.
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    await handleHistorySync(syncReq("tok-a", { ...base, version: 1, events: [movie(680, SEC)] }), env);

    // Strip the stamp, as a pre-delta document has it stripped by never having had it.
    const legacy = await docOf(env);
    delete legacy.titles["MOVIE|550"].mv;
    env.BUCKET.objects.set(`history/${A}.json`, {
      body: await serialiseDoc(legacy),
      etag: "legacy",
    });

    // A device at v1 would normally be sent only 680. The unstamped 550 must ride along
    // rather than be silently withheld forever.
    const delta = await (await handleHistorySync(syncReq("tok-a", { ...base, version: 1 }), env)).json();
    expect(delta.doc.titles["MOVIE|680"]).toBeDefined();
    expect(delta.doc.titles["MOVIE|550"]).toBeDefined();
  });

  it("reports stats for the whole document, not the delta", async () => {
    // ⚠️ `resyncIfServerLostHistory` on the client reads `stats.events == 0` as "the
    // server lost my history" and re-uploads the entire local database. Delta stats would
    // fire that on a routine pull.
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    await handleHistorySync(syncReq("tok-a", { ...base, version: 1, events: [movie(680, SEC)] }), env);

    const delta = await (await handleHistorySync(syncReq("tok-a", { ...base, version: 1 }), env)).json();
    expect(Object.keys(delta.doc.titles)).toEqual(["MOVIE|680"]); // really is a delta
    expect(delta.stats.events).toBe(2);                           // but stats count both
    expect(delta.stats.titles).toBe(2);
  });

  it("sends every tombstone alongside a delta", async () => {
    // Tombstones are never filtered: they are how a device learns about a deletion whose
    // title may not otherwise be in the delta at all.
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC), movie(680, SEC)] }), env);
    // `deletedAt` must be recent: applyToDoc purges tombstones older than TOMBSTONE_TTL_MS
    // in the same pass that records them.
    await handleHistorySync(
      syncReq("tok-a", { ...base, version: 1, events: [{ ...movie(550, SEC), deletedAt: Date.now() }] }),
      env,
    );
    // A third device still at v1 — it holds the watch that has since been deleted.
    const delta = await (await handleHistorySync(syncReq("tok-a", { ...base, version: 1 }), env)).json();
    expect(delta.doc.deleted["watch-MOVIE-550-" + SEC]).toBeDefined();
    // And the tombstone arrives even though no surviving title is in the delta at all.
    expect(delta.doc.titles["MOVIE|550"]).toBeUndefined();
  });
});

describe("history: concurrent writers", () => {
  it("never labels two different document states with the same version", async () => {
    // ⚠️ The race that makes deltas unsafe. Deriving the version from a `readMeta` taken
    // before the merge lets two devices both read 19 and both write "20" — after which a
    // client sitting at 20 never receives one of them, permanently and silently. The
    // version must come from the document the CAS actually stored.
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);

    // A stale `history_meta` read is exactly what a concurrent writer produces: the row
    // is behind the document at the moment this request reads it. Forcing it makes the
    // race deterministic instead of timing-dependent.
    env.DB.history_meta[0].version = 0;

    const second = await (
      await handleHistorySync(syncReq("tok-a", { ...base, version: 1, events: [movie(680, SEC)] }), env)
    ).json();

    // Derived from meta this would be 0 + 1 = 1 — colliding with the state that already
    // shipped as v1, and stamping 680 with a version existing clients have already passed.
    const doc = await docOf(env);
    expect(second.version).toBe(2);
    expect(doc.ver).toBe(2);
    expect(doc.titles["MOVIE|550"].mv).toBe(1);
    expect(doc.titles["MOVIE|680"].mv).toBe(2);

    // The decisive assertion: a client at the FIRST version still receives 680.
    const catchUp = await (await handleHistorySync(syncReq("tok-a", { ...base, version: 1 }), env)).json();
    expect(catchUp.doc.titles["MOVIE|680"]).toBeDefined();
  });
});

// ── Cross-device wake ────────────────────────────────────────────────────────
//
// The push side is debounced to 30s but the pull side had no prompt trigger at all, so a
// second device learned nothing until its next periodic pass — measured at 15m20s for an
// episode marked on a tablet to reach a phone.
describe("history: wake on write", () => {
  const spy = () => {
    const calls: Array<[string, string]> = [];
    return { calls, notify: async (_e: never, u: string, d: string) => void calls.push([u, d]) };
  };

  it("wakes the account's devices after a document write", async () => {
    const env = await env0();
    const { calls, notify } = spy();
    await handleHistorySync(
      syncReq("tok-a", { ...base, deviceId: "dev-tablet", events: [movie(550, SEC)] }),
      env, undefined, notify as never,
    );
    expect(calls).toEqual([[A, "dev-tablet"]]);
  });

  it("wakes nothing on the idle path", async () => {
    // The overwhelmingly common pass. A push here would cost an OAuth round trip and an
    // FCM publish per device per 15 minutes, for nothing.
    const env = await env0();
    const first = await (await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env)).json();
    const { calls, notify } = spy();
    await handleHistorySync(
      syncReq("tok-a", { ...base, version: first.version }), env, undefined, notify as never,
    );
    expect(calls).toEqual([]);
  });

  it("wakes nothing when the write was rejected as a conflict", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    env.BUCKET.failNextPut = 99; // never lands
    const { calls, notify } = spy();
    const res = await handleHistorySync(
      syncReq("tok-a", { ...base, version: 1, events: [movie(680, SEC)] }), env, undefined, notify as never,
    );
    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("wakes the account's devices after a single-event delete", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    const { calls, notify } = spy();
    await handleDeleteHistory(`watch-MOVIE-550-${SEC}`, delReq("tok-a"), env, undefined, notify as never);
    expect(calls).toEqual([[A, ""]]);
  });

  it("takes the delete path's version from the document too", async () => {
    // Same stale-read race as the sync path: `readMeta` before the merge cannot label the
    // state the CAS actually stored.
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...base, events: [movie(550, SEC)] }), env);
    env.DB.history_meta[0].version = 0;

    const res = await (await handleDeleteHistory(`watch-MOVIE-550-${SEC}`, delReq("tok-a"), env)).json();
    const doc = await docOf(env);
    expect(res.version).toBe(doc.ver);
    expect(env.DB.history_meta[0].version).toBe(doc.ver);
  });
});
