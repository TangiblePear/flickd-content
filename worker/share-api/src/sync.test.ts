import { describe, it, expect } from "vitest";
import { MAX_RELAY_FRIENDS, handleSync, type RelayRequest } from "./sync";

const ME = "AAAAH73X7P55T48R4CFHDED9CW";
const FRIEND = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const TOKENS: Record<string, string> = { "tok-me": ME, "tok-friend": FRIEND };

/**
 * The D1 half only. The R2 half is injected (`RelayLoader`), which is the whole
 * reason `sync.ts` imports no relay crypto — the handler has to be testable without
 * a bucket binding.
 */
class FakeD1 {
  feed: any[] = [];
  friendships: any[] = [];
  profiles: any[] = [];
  sessions = new Map<string, string>();
  /** Every `feed_events` SELECT that reached the database, for the row assertions. */
  feedReads: any[][] = [];
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
  private args: any[] = [];
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
    if (s.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      const u = this.db.sessions.get(this.args[0]);
      return u ? ({ user_id: u, expires_at: Date.now() + 8.64e7, revoked_at: null } as T) : null;
    }
    if (s.includes("FROM profiles WHERE user_id = ?")) {
      return (this.db.profiles.find((p) => p.user_id === this.args[0]) ?? null) as T | null;
    }
    throw new Error(`unhandled first(): ${s}`);
  }
  async all<T>(): Promise<{ results: T[] }> {
    const s = this.sql;
    if (s.startsWith("SELECT user_a, user_b, state, requested_by, updated_at FROM friendships")) {
      return {
        results: this.db.friendships.filter(
          (f) => f.user_a === this.args[0] || f.user_b === this.args[1],
        ) as T[],
      };
    }
    if (s.startsWith("SELECT id, author_id, kind, tmdb_id, media_type, payload, created_at FROM feed_events")) {
      const limit = this.args[this.args.length - 1];
      const from = this.args[this.args.length - 2];
      const cutoff = this.args[this.args.length - 3];
      const authors = this.args.slice(0, this.args.length - 3);
      const rows = this.db.feed.filter(
        (e) => authors.includes(e.author_id) && e.created_at < cutoff && e.created_at > from,
      );
      this.db.feedReads.push(rows);
      return { results: rows.sort((a, b) => b.created_at - a.created_at).slice(0, limit) as T[] };
    }
    throw new Error(`unhandled all(): ${s}`);
  }
  async run() {
    const s = this.sql;
    const a = this.args;
    if (s.startsWith("INSERT INTO feed_events")) {
      if (!this.db.feed.some((e) => e.id === a[0])) {
        this.db.feed.push({
          id: a[0], author_id: a[1], kind: a[2], tmdb_id: a[3],
          media_type: a[4], payload: a[5], created_at: a[6],
        });
      }
      return { success: true };
    }
    if (s.startsWith("DELETE FROM feed_events")) return { success: true };
    throw new Error(`unhandled run(): ${s}`);
  }
}

const env0 = async () => {
  const env = { DB: new FakeD1(), FIREBASE_PROJECT_ID: "flickto-cf7b6" } as any;
  const enc = new TextEncoder();
  for (const [tok, user] of Object.entries(TOKENS)) {
    const d = await crypto.subtle.digest("SHA-256", enc.encode(tok));
    env.DB.sessions.set([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""), user);
  }
  return env;
};

const befriend = (env: any, a: string, b: string) => {
  const [x, y] = a < b ? [a, b] : [b, a];
  env.DB.friendships.push({ user_a: x, user_b: y, state: "accepted", requested_by: x });
};

const NOW = Date.now();
const t = (n: number) => NOW - 10_000 + n;

const post = (token: string | null, body: unknown) =>
  new Request("https://flickto.app/api/sync", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });

const sync = async (env: any, token: string | null, body: unknown, relay?: any) =>
  (await handleSync(post(token, body), env, undefined, relay)).json() as any;

const seedFriendEvent = (env: any, id: string, at: number) =>
  env.DB.feed.push({
    id, author_id: FRIEND, kind: "watch", tmdb_id: 603,
    media_type: "movie", payload: null, created_at: at,
  });

describe("POST /api/sync", () => {
  it("401s without a session", async () => {
    const env = await env0();
    expect((await handleSync(post(null, {}), env)).status).toBe(401);
  });

  it("400s on a body that is not JSON", async () => {
    const env = await env0();
    const bad = new Request("https://flickto.app/api/sync", {
      method: "POST",
      headers: { Authorization: "Bearer tok-me" },
      body: "not json",
    });
    expect((await handleSync(bad, env)).status).toBe(400);
  });

  it("returns the friend graph and the feed in ONE request", async () => {
    const env = await env0();
    befriend(env, ME, FRIEND);
    seedFriendEvent(env, "theirs", t(200));

    const out = await sync(env, "tok-me", {});

    expect(out.friends.accepted).toEqual([FRIEND]);
    expect(out.feed.events.map((e: any) => e.id)).toEqual(["theirs"]);
    expect(out.feed.cursor).toBe(t(200));
  });

  /** The cursor semantics that make the whole thing cheap. */
  it("returns only what is newer than the client's cursor", async () => {
    const env = await env0();
    befriend(env, ME, FRIEND);
    seedFriendEvent(env, "old", t(100));
    seedFriendEvent(env, "new", t(300));

    const out = await sync(env, "tok-me", { feedSince: t(200) });

    expect(out.feed.events.map((e: any) => e.id)).toEqual(["new"]);
  });

  /**
   * The row-budget assertion. A refresh with nothing new must read **zero** rows
   * from `feed_events` — that is what stops D1 binding before the request cap does.
   */
  it("reads no feed rows at all when nothing has changed", async () => {
    const env = await env0();
    befriend(env, ME, FRIEND);
    seedFriendEvent(env, "theirs", t(200));

    const out = await sync(env, "tok-me", { feedSince: t(200) });

    expect(out.feed.events).toEqual([]);
    expect(env.DB.feedReads.at(-1)).toHaveLength(0);
    // The cursor must not go backwards on an empty delta, or the next sync re-reads.
    expect(out.feed.cursor).toBe(t(200));
  });

  it("carries a friend with no events without failing", async () => {
    const env = await env0();
    befriend(env, ME, FRIEND);

    const out = await sync(env, "tok-me", {});

    expect(out.friends.accepted).toEqual([FRIEND]);
    expect(out.feed.events).toEqual([]);
  });

  it("publishes the client's own events before reading", async () => {
    const env = await env0();
    befriend(env, ME, FRIEND);

    const out = await sync(env, "tok-me", {
      events: [{ id: "mine", kind: "watch", tmdbId: 603, mediaType: "movie", createdAt: t(100) }],
    });

    expect(out.written).toBe(1);
    expect(env.DB.feed.map((e: any) => e.id)).toEqual(["mine"]);
    // ...but the caller's own events never come back in their own feed.
    expect(out.feed.events).toEqual([]);
  });

  it("is idempotent on a retried publish", async () => {
    const env = await env0();
    const body = { events: [{ id: "mine", kind: "watch", tmdbId: 603, createdAt: t(100) }] };

    await sync(env, "tok-me", body);
    await sync(env, "tok-me", body);

    expect(env.DB.feed).toHaveLength(1);
  });

  // ── Profile ─────────────────────────────────────────────────────────────

  it("returns the profile only when the server holds a newer version", async () => {
    const env = await env0();
    env.DB.profiles.push({ user_id: ME, display_name: "Pear2", version: 8, updated_at: t(0) });

    expect((await sync(env, "tok-me", { profileVersion: 8 })).profile).toBeNull();
    expect((await sync(env, "tok-me", { profileVersion: 7 })).profile.displayName).toBe("Pear2");
  });

  it("returns the profile to a client that has never seen one", async () => {
    const env = await env0();
    env.DB.profiles.push({ user_id: ME, display_name: "Pear2", version: 0, updated_at: t(0) });

    expect((await sync(env, "tok-me", {})).profile.displayName).toBe("Pear2");
  });

  it("returns a null profile when the account has none", async () => {
    const env = await env0();
    expect((await sync(env, "tok-me", {})).profile).toBeNull();
  });

  // ── The relay half ──────────────────────────────────────────────────────

  it("omits the relay entirely when the client did not ask for it", async () => {
    const env = await env0();
    let called = false;

    const out = await sync(env, "tok-me", {}, async () => {
      called = true;
      return { freshness: [], inbox: null, self: null };
    });

    expect(called).toBe(false);
    expect(out.relay).toBeNull();
  });

  /**
   * 50 subrequests per request on the free plan, and a rotating author costs two R2
   * gets. Above the cap the client chunks and pays 2 requests instead of 1.
   */
  it("chunks the friend fan-out at the subrequest cap", async () => {
    const env = await env0();
    let seen: RelayRequest | null = null;
    const friends = Array.from({ length: 40 }, (_, i) => ({ friendId: `f${i}`, readToken: "t" }));

    await sync(env, "tok-me", { relay: { friends } }, async (_e: any, _u: string, r: RelayRequest) => {
      seen = r;
      return { freshness: [], inbox: null, self: null };
    });

    expect(seen!.friends).toHaveLength(MAX_RELAY_FRIENDS);
  });

  it("passes the relay half through untouched when it fits", async () => {
    const env = await env0();

    const out = await sync(
      env,
      "tok-me",
      { relay: { requesterId: "R", feedSecret: "s", inbox: true, friends: [{ friendId: "f", readToken: "t" }] } },
      async () => ({ freshness: [{ friendId: "f" }], inbox: { items: [], acks: [], ownerRecreated: false }, self: { ciphertext: "c", version: 3 } }),
    );

    expect(out.relay.freshness).toEqual([{ friendId: "f" }]);
    expect(out.relay.inbox.ownerRecreated).toBe(false);
    expect(out.relay.self).toEqual({ ciphertext: "c", version: 3 });
  });

  /**
   * The three relay reads a steady-state sync needs. Folding all of them in is what
   * takes a full sync from ~4 requests to 1 — see `SocialSyncWorker.doWork`.
   */
  it("asks for freshness, the inbox and the friends record in one go", async () => {
    const env = await env0();
    let seen: RelayRequest | null = null;

    await sync(
      env,
      "tok-me",
      { relay: { requesterId: "R", feedSecret: "s", inbox: true, selfLookupKey: "k".repeat(32) } },
      async (_e: any, _u: string, r: RelayRequest) => {
        seen = r;
        return { freshness: [], inbox: null, self: null };
      },
    );

    expect(seen!.inbox).toBe(true);
    expect(seen!.selfLookupKey).toBe("k".repeat(32));
    expect(seen!.feedSecret).toBe("s");
  });
});
