// Server-side watch history.
//
// Everything pinned here fails SILENTLY. A sync that drops an event still answers 200;
// a delta that withholds a row still looks like "nothing changed"; a stats query that
// counts a rewatch twice still renders a plausible number; a tombstone that never
// reaches the other device just looks like that device being slow. None of it throws,
// so only assertions catch it — and several of these are bugs the plan's own SQL had.

import { describe, it, expect } from "vitest";
import {
  MAX_EVENTS_PER_SYNC,
  deriveStats,
  handleDeleteHistory,
  handleGetGlobalStats,
  handleGetHistory,
  handleGetHistoryStats,
  handleHistorySync,
  parseEvent,
  parseRating,
} from "./history";

const A = "AAAAH73X7P55T48R4CFHDED9CW";
const B = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const TOKENS: Record<string, string> = { "tok-a": A, "tok-b": B };

const DEV1 = "device-one";
const DEV2 = "device-two";

/**
 * Hand-rolled D1 stand-in, the shape the other suites established: every SQL prefix a
 * handler issues gets an explicit branch and anything unrecognised throws. A fake that
 * quietly answers "no rows" turns a broken query into a passing test, which is the one
 * outcome worth nothing here.
 *
 * The upsert branches implement the REAL conflict semantics — the `updated_at` guard
 * and the `MAX(progress_pct)` — because those are the behaviours under test, not
 * incidental detail.
 */
class FakeD1 {
  sessions = new Map<string, string>();
  watch_history: any[] = [];
  user_ratings: any[] = [];
  sync_cursors: any[] = [];

  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
  async batch(stmts: FakeStmt[]) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

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
    const s = this.sql.trimStart();
    const a = this.args;
    if (s.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      const u = this.db.sessions.get(a[0]);
      return u ? ({ user_id: u, expires_at: Date.now() + 8.64e7, revoked_at: null } as T) : null;
    }
    if (s.startsWith("SELECT COUNT(DISTINCT tmdb_id) AS n FROM watch_history")) {
      const [userId, threshold] = a;
      const ids = new Set(
        this.db.watch_history
          .filter(
            (r) =>
              r.user_id === userId && r.media_type === "MOVIE" && r.progress_pct >= threshold && r.deleted_at == null,
          )
          .map((r) => r.tmdb_id),
      );
      return { n: ids.size } as T;
    }
    if (s.startsWith("SELECT COUNT(*) AS n FROM watch_history")) {
      const [userId, threshold] = a;
      const n = this.db.watch_history.filter(
        (r) => r.user_id === userId && r.media_type === "SHOW" && r.progress_pct >= threshold && r.deleted_at == null,
      ).length;
      return { n } as T;
    }
    throw new Error(`FakeD1: unhandled first() ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const s = this.sql.trimStart();
    const a = this.args;

    // The sync delta over watch_history.
    if (s.startsWith("SELECT id, media_type") && s.includes("updated_at > ?")) {
      const [userId, since, deviceId, limit] = a;
      const rows = this.db.watch_history
        .filter((r) => r.user_id === userId && r.updated_at > since && (r.device_id ?? "") !== deviceId)
        .sort((x, y) => x.updated_at - y.updated_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }
    // The paginated history read: keyset on (watched_at, id), tombstones excluded.
    if (s.startsWith("SELECT id, media_type")) {
      const [userId, cursor, cursorEq, cursorId, typeNull, type, limit] = a;
      const rows = this.db.watch_history
        .filter((r) => r.user_id === userId && r.deleted_at == null)
        .filter((r) => r.watched_at < cursor || (r.watched_at === cursorEq && r.id < cursorId))
        .filter((r) => typeNull === null || r.media_type === type)
        .sort((x, y) => y.watched_at - x.watched_at || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0))
        .slice(0, limit);
      return { results: rows as T[] };
    }
    if (s.startsWith("SELECT media_type, tmdb_id, watch_status")) {
      const [userId, since, limit] = a;
      const rows = this.db.user_ratings
        .filter((r) => r.user_id === userId && r.updated_at > since)
        .sort((x, y) => x.updated_at - y.updated_at)
        .slice(0, limit);
      return { results: rows as T[] };
    }
    if (s.startsWith("SELECT show_tmdb_id,")) {
      const [userId, threshold] = a;
      const by = new Map<number, { eps: Set<string>; last: number }>();
      for (const r of this.db.watch_history) {
        if (r.user_id !== userId || r.show_tmdb_id == null) continue;
        if (r.progress_pct < threshold || r.deleted_at != null) continue;
        const e = by.get(r.show_tmdb_id) ?? { eps: new Set<string>(), last: 0 };
        e.eps.add(`${r.season_number}:${r.episode_number}`);
        e.last = Math.max(e.last, r.watched_at);
        by.set(r.show_tmdb_id, e);
      }
      return {
        results: [...by.entries()].map(([show_tmdb_id, v]) => ({
          show_tmdb_id,
          episodes_watched: v.eps.size,
          last_watched_at: v.last,
        })) as T[],
      };
    }
    throw new Error(`FakeD1: unhandled all() ${this.sql}`);
  }

  async run() {
    const s = this.sql.trimStart();
    const a = this.args;

    if (s.startsWith("INSERT INTO watch_history")) {
      const [
        user_id,
        id,
        media_type,
        tmdb_id,
        tvdb_id,
        show_tmdb_id,
        season_number,
        episode_number,
        watched_at,
        source,
        progress_pct,
        device_id,
        deleted_at,
        created_at,
        updated_at,
      ] = a;
      const existing = this.db.watch_history.find((r) => r.user_id === user_id && r.id === id);
      if (!existing) {
        this.db.watch_history.push({
          user_id,
          id,
          media_type,
          tmdb_id,
          tvdb_id,
          show_tmdb_id,
          season_number,
          episode_number,
          watched_at,
          source,
          progress_pct,
          device_id,
          deleted_at,
          created_at,
          updated_at,
        });
        return { success: true, meta: { changes: 1 } };
      }
      // DO UPDATE … WHERE excluded.updated_at > watch_history.updated_at
      if (!(updated_at > existing.updated_at)) return { success: true, meta: { changes: 0 } };
      existing.progress_pct = Math.max(existing.progress_pct, progress_pct);
      existing.tvdb_id = tvdb_id ?? existing.tvdb_id;
      existing.source = source;
      existing.deleted_at = deleted_at;
      existing.updated_at = updated_at;
      return { success: true, meta: { changes: 1 } };
    }

    if (s.startsWith("INSERT INTO user_ratings")) {
      const [user_id, media_type, tmdb_id, watch_status, rating, feedback, updated_at] = a;
      const existing = this.db.user_ratings.find(
        (r) => r.user_id === user_id && r.media_type === media_type && r.tmdb_id === tmdb_id,
      );
      if (!existing) {
        this.db.user_ratings.push({ user_id, media_type, tmdb_id, watch_status, rating, feedback, updated_at });
        return { success: true, meta: { changes: 1 } };
      }
      if (!(updated_at > existing.updated_at)) return { success: true, meta: { changes: 0 } };
      Object.assign(existing, { watch_status, rating, feedback, updated_at });
      return { success: true, meta: { changes: 1 } };
    }

    if (s.startsWith("INSERT INTO sync_cursors")) {
      const [user_id, device_id, cursor_val, updated_at] = a;
      const existing = this.db.sync_cursors.find(
        (r) => r.user_id === user_id && r.source === "DEVICE" && r.device_id === device_id,
      );
      if (existing) Object.assign(existing, { cursor_val, updated_at });
      else this.db.sync_cursors.push({ user_id, source: "DEVICE", device_id, cursor_val, updated_at });
      return { success: true, meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE watch_history SET deleted_at")) {
      const [deleted_at, updated_at, user_id, id] = a;
      const row = this.db.watch_history.find((r) => r.user_id === user_id && r.id === id && r.deleted_at == null);
      if (!row) return { success: true, meta: { changes: 0 } };
      Object.assign(row, { deleted_at, updated_at });
      return { success: true, meta: { changes: 1 } };
    }

    throw new Error(`FakeD1: unhandled run() ${this.sql}`);
  }
}

/** In-memory KV. `expirationTtl` is ignored — no test here turns on expiry timing. */
class FakeKV {
  store = new Map<string, string>();
  reads = 0;
  async get(key: string, _type?: string) {
    this.reads++;
    const v = this.store.get(key);
    return v == null ? null : JSON.parse(v);
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function env0() {
  const db = new FakeD1();
  for (const [tok, uid] of Object.entries(TOKENS)) db.sessions.set(await hash(tok), uid);
  return { DB: db, HISTORY_STATS_KV: new FakeKV() } as any;
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
  new Request("https://flickto.app/api/history/x", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

/** A movie watch. `watchedAt` doubles as the id suffix so ids stay distinct. */
const movie = (tmdbId: number, watchedAt: number, over: Record<string, unknown> = {}) => ({
  id: `watch-MOVIE-${tmdbId}-${Math.floor(watchedAt / 1000)}`,
  mediaType: "MOVIE",
  tmdbId,
  watchedAt,
  updatedAt: watchedAt,
  ...over,
});

const episode = (tmdbId: number, s: number, e: number, watchedAt: number, over: Record<string, unknown> = {}) => ({
  id: `watch-EPISODE-${tmdbId}-s${s}e${e}-${Math.floor(watchedAt / 1000)}`,
  mediaType: "SHOW",
  tmdbId,
  seasonNumber: s,
  episodeNumber: e,
  watchedAt,
  updatedAt: watchedAt,
  ...over,
});

const body = { events: [], ratings: [], lastSyncTimestamp: 0, deviceId: DEV1 };

describe("history: authentication", () => {
  it("refuses every endpoint without a session", async () => {
    const env = await env0();
    const anon = (r: Request) => r;
    expect((await handleHistorySync(anon(syncReq("nope", body)), env)).status).toBe(401);
    expect((await handleGetHistory(listReq("nope"), env)).status).toBe(401);
    expect((await handleGetHistoryStats(statsReq("nope"), env)).status).toBe(401);
    expect((await handleDeleteHistory("x", delReq("nope"), env)).status).toBe(401);
  });
});

describe("history: sync", () => {
  it("stores events and hands them to the account's OTHER device, but not back to the sender", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...body, events: [movie(550, 1_000_000)], deviceId: DEV1 }), env);
    expect(env.DB.watch_history).toHaveLength(1);

    // The sender must not receive its own write back — it already has the row, and
    // echoing it makes every sync re-insert what it just sent.
    const own = await (await handleHistorySync(syncReq("tok-a", { ...body, deviceId: DEV1 }), env)).json();
    expect(own.serverEvents).toHaveLength(0);

    const other = await (await handleHistorySync(syncReq("tok-a", { ...body, deviceId: DEV2 }), env)).json();
    expect(other.serverEvents).toHaveLength(1);
    expect(other.serverEvents[0].tmdbId).toBe(550);
  });

  it("hands a row with NO device id to every device", async () => {
    // `device_id != ?` is NULL — and therefore falsy — for a NULL device_id, so a bare
    // `!=` withholds these rows from EVERYONE. A row nobody claims belongs to everyone.
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...body, events: [movie(550, 1_000_000)], deviceId: "" }), env);
    expect(env.DB.watch_history[0].device_id).toBeNull();

    const seen = await (await handleHistorySync(syncReq("tok-a", { ...body, deviceId: DEV1 }), env)).json();
    expect(seen.serverEvents).toHaveLength(1);
  });

  it("keeps one account's events out of another's", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...body, events: [movie(550, 1_000_000)] }), env);
    const bs = await (await handleHistorySync(syncReq("tok-b", { ...body, deviceId: DEV2 }), env)).json();
    expect(bs.serverEvents).toHaveLength(0);
  });

  it("takes the newer write and ignores a stale one", async () => {
    const env = await env0();
    await handleHistorySync(
      syncReq("tok-a", { ...body, events: [movie(550, 1_000_000, { source: "TRAKT", updatedAt: 5_000 })] }),
      env,
    );
    await handleHistorySync(
      syncReq("tok-a", { ...body, events: [movie(550, 1_000_000, { source: "STALE", updatedAt: 4_000 })] }),
      env,
    );
    expect(env.DB.watch_history).toHaveLength(1);
    expect(env.DB.watch_history[0].source).toBe("TRAKT");
  });

  it("never lets a later sync move progress backwards", async () => {
    // A device that recorded 40% and only got online after another device recorded
    // 100% would otherwise mark a finished film unfinished. Progress is monotonic in
    // the user's experience of it, so the merge takes the max, not the newer value.
    const env = await env0();
    await handleHistorySync(
      syncReq("tok-a", { ...body, events: [movie(550, 1_000_000, { progressPct: 100, updatedAt: 5_000 })] }),
      env,
    );
    await handleHistorySync(
      syncReq("tok-a", { ...body, events: [movie(550, 1_000_000, { progressPct: 40, updatedAt: 9_000 })] }),
      env,
    );
    expect(env.DB.watch_history[0].progress_pct).toBe(100);
  });

  it("drops a malformed event and still writes the rest of the batch", async () => {
    // The client's queue clears only on success, so failing the whole call over one bad
    // row would wedge the queue forever — a permanently retried, permanently failing
    // sync. Bad rows are discarded; good ones land.
    const env = await env0();
    const res = await handleHistorySync(
      syncReq("tok-a", { ...body, events: [{ id: "", mediaType: "MOVIE" }, movie(550, 1_000_000)] }),
      env,
    );
    expect(res.status).toBe(200);
    expect(env.DB.watch_history).toHaveLength(1);
  });

  it("refuses an oversized batch rather than truncating it", async () => {
    // Truncating would silently discard the tail while telling the client everything
    // synced, so those events would never be sent again.
    const env = await env0();
    // Derived from the constant, never a hardcoded number: a literal here silently
    // stops testing the boundary the moment the cap moves, which is exactly what
    // happened when it went 100 -> 500.
    const events = Array.from({ length: MAX_EVENTS_PER_SYNC + 1 }, (_, i) => movie(500 + i, 1_000_000 + i));
    const res = await handleHistorySync(syncReq("tok-a", { ...body, events }), env);
    expect(res.status).toBe(413);
    expect(env.DB.watch_history).toHaveLength(0);

    // ...and one AT the cap is accepted, or "refuses oversized" would pass on a
    // handler that refused everything.
    const atCap = Array.from({ length: MAX_EVENTS_PER_SYNC }, (_, i) => movie(500 + i, 1_000_000 + i));
    const ok = await handleHistorySync(syncReq("tok-a", { ...body, events: atCap }), env);
    expect(ok.status).toBe(200);
    expect(env.DB.watch_history).toHaveLength(MAX_EVENTS_PER_SYNC);
  });

  it("records the sync cursor per device", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...body, deviceId: DEV1 }), env);
    await handleHistorySync(syncReq("tok-a", { ...body, deviceId: DEV2 }), env);
    expect(env.DB.sync_cursors).toHaveLength(2);
  });

  it("syncs ratings with the same last-write-wins rule", async () => {
    const env = await env0();
    const rating = (r: number, updatedAt: number) => ({ mediaType: "MOVIE", tmdbId: 550, rating: r, updatedAt });
    await handleHistorySync(syncReq("tok-a", { ...body, ratings: [rating(9, 5_000)] }), env);
    await handleHistorySync(syncReq("tok-a", { ...body, ratings: [rating(3, 4_000)] }), env);
    expect(env.DB.user_ratings[0].rating).toBe(9);

    const seen = await (await handleHistorySync(syncReq("tok-a", { ...body, deviceId: DEV2 }), env)).json();
    expect(seen.serverRatings[0].rating).toBe(9);
  });
});

describe("history: pagination", () => {
  it("does not step over rows that share a watched_at", async () => {
    // Marking a whole season watched in Trakt stamps every episode with ONE timestamp.
    // A `watched_at < cursor` cursor skips the rest of that tie the moment a page
    // boundary lands inside it, and the user simply never sees those episodes again.
    const env = await env0();
    const T = 1_700_000_000_000;
    const events = [1, 2, 3, 4].map((e) => episode(1396, 1, e, T));
    await handleHistorySync(syncReq("tok-a", { ...body, events }), env);

    const page1 = await (await handleGetHistory(listReq("tok-a", "?limit=2"), env)).json();
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).toBe(T);

    const page2 = await (
      await handleGetHistory(listReq("tok-a", `?limit=2&cursor=${page1.nextCursor}&cursorId=${page1.nextCursorId}`), env)
    ).json();
    const ids = [...page1.events, ...page2.events].map((e: any) => e.id);
    expect(new Set(ids).size).toBe(4);
  });

  it("returns no cursor on a short page", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...body, events: [movie(550, 1_000_000)] }), env);
    const page = await (await handleGetHistory(listReq("tok-a", "?limit=50"), env)).json();
    expect(page.nextCursor).toBeNull();
  });

  it("filters by media type and hides tombstoned rows", async () => {
    const env = await env0();
    await handleHistorySync(
      syncReq("tok-a", { ...body, events: [movie(550, 2_000_000), episode(1396, 1, 1, 1_000_000)] }),
      env,
    );
    const movies = await (await handleGetHistory(listReq("tok-a", "?type=MOVIE"), env)).json();
    expect(movies.events).toHaveLength(1);
    expect(movies.events[0].mediaType).toBe("MOVIE");

    await handleDeleteHistory("watch-MOVIE-550-2000", delReq("tok-a"), env);
    const after = await (await handleGetHistory(listReq("tok-a", "?type=MOVIE"), env)).json();
    expect(after.events).toHaveLength(0);
  });
});

describe("history: stats", () => {
  it("counts a rewatched film once and a rewatched episode once per show", async () => {
    const env = await env0();
    await handleHistorySync(
      syncReq("tok-a", {
        ...body,
        events: [
          movie(550, 1_000_000),
          movie(550, 9_000_000), // a rewatch: still one film watched
          episode(1396, 1, 1, 2_000_000),
          episode(1396, 1, 2, 3_000_000),
          episode(1396, 1, 1, 8_000_000), // a rewatch: still two episodes of progress
        ],
      }),
      env,
    );
    const stats = await deriveStats(env, A);
    expect(stats.totalMovies).toBe(1);
    // Episodes WATCHED counts every viewing — the user watched five episodes' worth.
    expect(stats.totalEpisodes).toBe(3);
    // Progress THROUGH the show must not advance on a rewatch.
    expect(stats.shows).toHaveLength(1);
    expect(stats.shows[0].episodesWatched).toBe(2);
    expect(stats.shows[0].lastWatchedAt).toBe(8_000_000);
  });

  it("ignores abandoned watches and tombstones", async () => {
    const env = await env0();
    await handleHistorySync(
      syncReq("tok-a", {
        ...body,
        events: [movie(550, 1_000_000, { progressPct: 12 }), movie(680, 2_000_000)],
      }),
      env,
    );
    expect((await deriveStats(env, A)).totalMovies).toBe(1);

    await handleDeleteHistory("watch-MOVIE-680-2000", delReq("tok-a"), env);
    expect((await deriveStats(env, A)).totalMovies).toBe(0);
  });

  it("serves the cache on the second read and drops it when a sync writes", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...body, events: [movie(550, 1_000_000)] }), env);

    const first = await (await handleGetHistoryStats(statsReq("tok-a"), env)).json();
    expect(first.totalMovies).toBe(1);
    expect(env.HISTORY_STATS_KV.store.has(`history:stats:${A}`)).toBe(true);

    // A new watch must not be served from a stale blob. Without the invalidation the
    // History tab reports yesterday's totals for five minutes after every watch.
    await handleHistorySync(syncReq("tok-a", { ...body, events: [movie(680, 2_000_000)] }), env);
    expect(env.HISTORY_STATS_KV.store.has(`history:stats:${A}`)).toBe(false);

    const second = await (await handleGetHistoryStats(statsReq("tok-a"), env)).json();
    expect(second.totalMovies).toBe(2);
  });
});

describe("history: delete", () => {
  it("tombstones rather than removing, so the deletion reaches the other device", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...body, events: [movie(550, 1_000_000)], deviceId: DEV1 }), env);
    // Drain DEV2's delta so the tombstone below is the only thing it has left to learn.
    const drain = await (await handleHistorySync(syncReq("tok-a", { ...body, deviceId: DEV2 }), env)).json();

    const res = await handleDeleteHistory("watch-MOVIE-550-1000", delReq("tok-a"), env);
    expect(res.status).toBe(200);
    expect(env.DB.watch_history).toHaveLength(1);

    const delta = await (
      await handleHistorySync(
        syncReq("tok-a", { ...body, deviceId: DEV2, lastSyncTimestamp: drain.syncTimestamp }),
        env,
      )
    ).json();
    expect(delta.serverEvents).toHaveLength(1);
    expect(delta.serverEvents[0].deletedAt).toBeGreaterThan(0);
  });

  it("answers 404 for another account's event id, exactly as for one that does not exist", async () => {
    const env = await env0();
    await handleHistorySync(syncReq("tok-a", { ...body, events: [movie(550, 1_000_000)] }), env);

    const foreign = await handleDeleteHistory("watch-MOVIE-550-1000", delReq("tok-b"), env);
    expect(foreign.status).toBe(404);
    const missing = await handleDeleteHistory("watch-MOVIE-999-1000", delReq("tok-a"), env);
    expect(missing.status).toBe(404);
    // A's row is untouched — the 404 was a refusal, not a partial delete.
    expect(env.DB.watch_history[0].deleted_at).toBeNull();
  });
});

describe("history: global stats", () => {
  it("reports not_configured rather than a plausible zero", async () => {
    // "Nobody has watched anything" and "the credential is missing" must not look the
    // same — a zero would be cached and served confidently for an hour.
    const env = await env0();
    const res = await handleGetGlobalStats(new Request("https://flickto.app/api/stats/global"), env);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("not_configured");
  });
});

describe("history: validation", () => {
  it("fills showTmdbId from tmdbId for a show and leaves it null for a movie", async () => {
    // The Android entity has no separate show column; the show's TMDB id IS the row's
    // tmdbId. The partial per-show index depends on movies keeping NULL here.
    expect(parseEvent(episode(1396, 1, 1, 5))!.showTmdbId).toBe(1396);
    expect(parseEvent(movie(550, 5))!.showTmdbId).toBeNull();
  });

  it("rejects the fields that become keys or totals", async () => {
    expect(parseEvent({ ...movie(550, 5), id: "" })).toBeNull();
    expect(parseEvent({ ...movie(550, 5), mediaType: "PODCAST" })).toBeNull();
    expect(parseEvent({ ...movie(550, 5), tmdbId: 0 })).toBeNull();
    expect(parseEvent({ ...movie(550, 5), watchedAt: Number.NaN })).toBeNull();
    expect(parseEvent({ ...movie(550, 5), seasonNumber: "1" })).toBeNull();
    expect(parseRating({ mediaType: "MOVIE", tmdbId: 550, rating: 11, updatedAt: 1 })).toBeNull();
    expect(parseRating({ mediaType: "MOVIE", tmdbId: 550, rating: 0, updatedAt: 1 })).toBeNull();
  });

  it("clamps a nonsense progress rather than discarding the watch", async () => {
    expect(parseEvent({ ...movie(550, 5), progressPct: 3000 })!.progressPct).toBe(100);
    expect(parseEvent({ ...movie(550, 5), progressPct: -7 })!.progressPct).toBe(0);
  });
});
