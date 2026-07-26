import { describe, it, expect } from "vitest";
import { handleClearFeed, handleGetFeed, handlePublishFeed, loadFeed } from "./feed";

const ME = "AAAAH73X7P55T48R4CFHDED9CW";
const FRIEND = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const STRANGER = "CCCCK95Z9R77W60T6EHKFGFBY1";
const TOKENS: Record<string, string> = { "tok-me": ME, "tok-friend": FRIEND };

class FakeD1 {
  feed: any[] = [];
  friendships: any[] = [];
  sessions = new Map<string, string>();
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
    if (this.sql.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      const u = this.db.sessions.get(this.args[0]);
      return u ? ({ user_id: u, expires_at: Date.now() + 8.64e7, revoked_at: null } as T) : null;
    }
    throw new Error(`unhandled first(): ${this.sql}`);
  }
  async all<T>(): Promise<{ results: T[] }> {
    const s = this.sql;
    if (s.startsWith("SELECT user_a, user_b, state, requested_by, updated_at FROM friendships")) {
      return { results: this.db.friendships.filter((f) => f.user_a === this.args[0] || f.user_b === this.args[1]) as T[] };
    }
    if (s.startsWith("SELECT id, author_id, kind, tmdb_id, media_type, payload, created_at FROM feed_events")) {
      const limit = this.args[this.args.length - 1];
      const cutoff = this.args[this.args.length - 2];
      const authors = this.args.slice(0, this.args.length - 2);
      return {
        results: this.db.feed
          .filter((e) => authors.includes(e.author_id) && e.created_at < cutoff)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, limit) as T[],
      };
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
    if (s.startsWith("DELETE FROM feed_events WHERE author_id = ? AND id NOT IN")) {
      const [author, , limit] = a;
      const keep = this.db.feed
        .filter((e) => e.author_id === author)
        .sort((x, y) => y.created_at - x.created_at)
        .slice(0, limit)
        .map((e) => e.id);
      this.db.feed = this.db.feed.filter((e) => e.author_id !== author || keep.includes(e.id));
      return { success: true };
    }
    if (s.startsWith("DELETE FROM feed_events WHERE author_id = ?")) {
      this.db.feed = this.db.feed.filter((e) => e.author_id !== a[0]);
      return { success: true };
    }
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

const publish = (token: string, events: unknown[]) =>
  new Request("https://flickto.app/api/me/feed", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  });
const ev = (id: string, at: number, over: Record<string, unknown> = {}) => ({
  id, kind: "watch", tmdbId: 603, mediaType: "movie", createdAt: at, ...over,
});

describe("publishing", () => {
  it("writes events and is idempotent on a retry", async () => {
    const env = await env0();
    expect(((await (await handlePublishFeed(publish("tok-me", [ev("e1", 100)]), env)).json()) as any).written).toBe(1);
    // Publishing is best-effort and retried on the next sync, so the same id must
    // not stack up a second row.
    await handlePublishFeed(publish("tok-me", [ev("e1", 100)]), env);
    expect(env.DB.feed.length).toBe(1);
  });

  it("rejects unknown kinds and unusable ids", async () => {
    const env = await env0();
    await handlePublishFeed(publish("tok-me", [
      ev("ok", 1),
      ev("bad-kind", 2, { kind: "nonsense" }),
      ev("", 3),
    ]), env);
    expect(env.DB.feed.map((e: any) => e.id)).toEqual(["ok"]);
  });

  /** A future timestamp would pin an event to the top of every friend's feed forever. */
  it("clamps a future client timestamp to now", async () => {
    const env = await env0();
    const future = Date.now() + 86_400_000;
    await handlePublishFeed(publish("tok-me", [ev("e1", future)]), env);
    expect(env.DB.feed[0].created_at).toBeLessThanOrEqual(Date.now());
  });

  it("prunes the author back to the retention cap on write", async () => {
    const env = await env0();
    const many = Array.from({ length: 130 }, (_, i) => ev(`e${i}`, 1000 + i));
    await handlePublishFeed(publish("tok-me", many), env);
    expect(env.DB.feed.length).toBe(100);
    // The NEWEST are what survive.
    expect(env.DB.feed.some((e: any) => e.id === "e129")).toBe(true);
    expect(env.DB.feed.some((e: any) => e.id === "e0")).toBe(false);
  });

  it("401s without a session", async () => {
    const env = await env0();
    const anon = new Request("https://flickto.app/api/me/feed", { method: "POST", body: '{"events":[]}' });
    expect((await handlePublishFeed(anon, env)).status).toBe(401);
  });
});

describe("reading", () => {
  it("returns friends' events, newest first", async () => {
    const env = await env0();
    befriend(env, ME, FRIEND);
    await handlePublishFeed(publish("tok-friend", [ev("theirs", 200)]), env);
    await handlePublishFeed(publish("tok-friend", [ev("older", 100)]), env);

    const feed = await loadFeed(env, ME, 50);
    expect(feed.map((e) => e.id)).toEqual(["theirs", "older"]);
  });

  /** The client cannot attribute your own events to a friend row, so they would
   *  be dropped on arrival — and a heavy user's would fill the page first. */
  it("excludes the caller's OWN events", async () => {
    const env = await env0();
    befriend(env, ME, FRIEND);
    await handlePublishFeed(publish("tok-me", [ev("mine", 300)]), env);
    await handlePublishFeed(publish("tok-friend", [ev("theirs", 200)]), env);

    expect((await loadFeed(env, ME, 50)).map((e) => e.id)).toEqual(["theirs"]);
  });

  it("is empty with no friends rather than showing yourself", async () => {
    const env = await env0();
    await handlePublishFeed(publish("tok-me", [ev("mine", 100)]), env);
    expect(await loadFeed(env, ME, 50)).toEqual([]);
  });

  it("never shows a stranger's events", async () => {
    const env = await env0();
    env.DB.feed.push({ id: "x", author_id: STRANGER, kind: "watch", tmdb_id: 1, media_type: "movie", payload: null, created_at: 500 });

    expect(await loadFeed(env, ME, 50)).toEqual([]);
  });

  // Blocking deletes the friendship row, so it needs no separate check here.
  it("drops a blocked author because the friendship is gone", async () => {
    const env = await env0();
    befriend(env, ME, FRIEND);
    await handlePublishFeed(publish("tok-friend", [ev("theirs", 200)]), env);
    expect((await loadFeed(env, ME, 50)).length).toBe(1);

    env.DB.friendships = []; // what handleBlock does
    expect(await loadFeed(env, ME, 50)).toEqual([]);
  });

  it("pages with `before`", async () => {
    const env = await env0();
    befriend(env, ME, FRIEND);
    await handlePublishFeed(publish("tok-friend", [ev("a", 100), ev("b", 200), ev("c", 300)]), env);
    const page = await loadFeed(env, ME, 50, 300);
    expect(page.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("clears everything this user published", async () => {
    const env = await env0();
    befriend(env, ME, FRIEND);
    await handlePublishFeed(publish("tok-me", [ev("mine", 100)]), env);
    await handlePublishFeed(publish("tok-friend", [ev("theirs", 200)]), env);

    const res = await handleClearFeed(
      new Request("https://flickto.app/api/me/feed", { method: "DELETE", headers: { Authorization: "Bearer tok-me" } }),
      env,
    );
    expect(res.status).toBe(204);
    expect(env.DB.feed.map((e: any) => e.id)).toEqual(["theirs"]); // only mine went
  });

  it("401s without a session", async () => {
    const env = await env0();
    expect((await handleGetFeed(new Request("https://flickto.app/api/feed"), env)).status).toBe(401);
  });
});
