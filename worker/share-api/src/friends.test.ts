import { describe, it, expect } from "vitest";
import {
  handleBlock,
  handleClaimFriendId,
  handleDeleteAccount,
  handleFriendAccept,
  handleFriendRemove,
  handleFriendRequest,
  handleGetBlocks,
  handleGetFriends,
  handleLinkLegacyFriends,
  handleReport,
  handleUnblock,
} from "./friends";
import { canView } from "./authz";

// Three accounts. A and B are the usual pair; C is the outsider.
const A = "AAAAH73X7P55T48R4CFHDED9CW";
const B = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const C = "CCCCK95Z9R77W60T6EHKFGFBY1";
const TOKENS: Record<string, string> = { "tok-a": A, "tok-b": B, "tok-c": C };

class FakeD1 {
  users: any[] = [];
  friendships: any[] = [];
  blocks: any[] = [];
  reports: any[] = [];
  profiles: any[] = [];
  profile_stats: any[] = [];
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
  private args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const s = this.sql;
    const a = this.args as any[];
    if (s.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      const u = this.db.sessions.get(a[0]);
      return u ? ({ user_id: u, expires_at: Date.now() + 8.64e7, revoked_at: null } as T) : null;
    }
    if (s.startsWith("SELECT 1 AS hit FROM blocks")) {
      const hit = this.db.blocks.some(
        (b) => (b.blocker_id === a[0] && b.blocked_id === a[1]) || (b.blocker_id === a[2] && b.blocked_id === a[3]),
      );
      return hit ? ({ hit: 1 } as T) : null;
    }
    if (s.startsWith("SELECT state FROM friendships")) {
      const r = this.db.friendships.find((f) => f.user_a === a[0] && f.user_b === a[1] && f.state === "accepted");
      return r ? ({ state: r.state } as T) : null;
    }
    if (s.startsWith("SELECT state, requested_by FROM friendships")) {
      const r = this.db.friendships.find((f) => f.user_a === a[0] && f.user_b === a[1]);
      return r ? ({ state: r.state, requested_by: r.requested_by } as T) : null;
    }
    if (s.startsWith("SELECT id FROM users WHERE id = ?")) {
      const r = this.db.users.find((u) => u.id === a[0] && u.status === "active");
      return r ? ({ id: r.id } as T) : null;
    }
    if (s.startsWith("SELECT id FROM users WHERE friend_id = ?")) {
      const r = this.db.users.find((u) => u.friend_id === a[0]);
      return r ? ({ id: r.id } as T) : null;
    }
    if (s.startsWith("SELECT COUNT(*) AS n FROM friendships WHERE requested_by")) {
      return { n: this.db.friendships.filter((f) => f.requested_by === a[0] && f.created_at > a[1]).length } as T;
    }
    if (s.startsWith("SELECT id FROM reports")) {
      const r = this.db.reports.find((x) => x.reporter_id === a[0] && x.target_id === a[1] && x.state === "open");
      return r ? ({ id: r.id } as T) : null;
    }
    if (s.includes("FROM profiles WHERE user_id = ?")) return null;
    throw new Error(`FakeD1: unhandled first() ${s}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const s = this.sql;
    const a = this.args as any[];
    if (s.startsWith("SELECT user_a, user_b, state, requested_by, updated_at FROM friendships")) {
      return { results: this.db.friendships.filter((f) => f.user_a === a[0] || f.user_b === a[1]) as T[] };
    }
    if (s.startsWith("SELECT blocked_id, created_at FROM blocks")) {
      return { results: this.db.blocks.filter((b) => b.blocker_id === a[0]) as T[] };
    }
    if (s.startsWith("SELECT id, friend_id FROM users WHERE friend_id IN")) {
      return { results: this.db.users.filter((u) => a.includes(u.friend_id) && u.status === "active") as T[] };
    }
    throw new Error(`FakeD1: unhandled all() ${s}`);
  }

  async run() {
    const s = this.sql;
    const a = this.args as any[];
    if (s.startsWith("INSERT INTO friendships")) {
      const row = { user_a: a[0], user_b: a[1], state: a[2] ?? "pending", requested_by: a[2], created_at: a[3], updated_at: a[4] };
      // The link-legacy variant binds (a,b,requestedBy,created,updated) with state inline.
      const existing = this.db.friendships.find((f) => f.user_a === a[0] && f.user_b === a[1]);
      const state = s.includes("'accepted'") ? "accepted" : "pending";
      if (existing) existing.state = state;
      else this.db.friendships.push({ ...row, state, requested_by: a[2] });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE friendships SET state = 'accepted', updated_at = ? WHERE user_a = ? AND user_b = ? AND state = 'pending' AND requested_by = ?")) {
      const r = this.db.friendships.find(
        (f) => f.user_a === a[1] && f.user_b === a[2] && f.state === "pending" && f.requested_by === a[3],
      );
      if (r) r.state = "accepted";
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE friendships SET state = 'accepted'")) {
      const r = this.db.friendships.find((f) => f.user_a === a[1] && f.user_b === a[2]);
      if (r) r.state = "accepted";
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("DELETE FROM friendships WHERE user_a = ? AND user_b = ?")) {
      this.db.friendships = this.db.friendships.filter((f) => !(f.user_a === a[0] && f.user_b === a[1]));
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM friendships WHERE user_a = ? OR user_b = ?")) {
      this.db.friendships = this.db.friendships.filter((f) => f.user_a !== a[0] && f.user_b !== a[1]);
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT OR IGNORE INTO blocks")) {
      if (!this.db.blocks.some((b) => b.blocker_id === a[0] && b.blocked_id === a[1])) {
        this.db.blocks.push({ blocker_id: a[0], blocked_id: a[1], created_at: a[2] });
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?")) {
      this.db.blocks = this.db.blocks.filter((b) => !(b.blocker_id === a[0] && b.blocked_id === a[1]));
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?")) {
      this.db.blocks = this.db.blocks.filter((b) => b.blocker_id !== a[0] && b.blocked_id !== a[1]);
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO reports")) {
      this.db.reports.push({ id: a[0], reporter_id: a[1], target_id: a[2], kind: a[3], context: a[4], state: "open", created_at: a[5] });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE users SET friend_id")) {
      const u = this.db.users.find((x) => x.id === a[1]);
      if (u) u.friend_id = a[0];
      return { success: true, meta: { changes: 1 } };
    }
    for (const [prefix, table, col] of [
      ["DELETE FROM sessions", "sessions", null],
      ["DELETE FROM reports", "reports", "reporter_id"],
      ["DELETE FROM profile_stats", "profile_stats", "user_id"],
      ["DELETE FROM profiles", "profiles", "user_id"],
      ["DELETE FROM identities", "identities", "user_id"],
      ["DELETE FROM users", "users", "id"],
    ] as [string, string, string | null][]) {
      if (s.startsWith(prefix)) {
        if (col && (this.db as any)[table]) {
          (this.db as any)[table] = (this.db as any)[table].filter((r: any) => r[col] !== a[0]);
        }
        return { success: true, meta: { changes: 1 } };
      }
    }
    throw new Error(`FakeD1: unhandled run() ${s}`);
  }
}

const env0 = async () => {
  const env = { DB: new FakeD1(), FIREBASE_PROJECT_ID: "flickto-cf7b6" } as any;
  const enc = new TextEncoder();
  for (const [token, user] of Object.entries(TOKENS)) {
    const d = await crypto.subtle.digest("SHA-256", enc.encode(token));
    env.DB.sessions.set([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""), user);
    env.DB.users.push({ id: user, status: "active", friend_id: null });
  }
  return env;
};

const post = (token: string, path: string, body?: unknown) =>
  new Request(`https://flickto.app${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (token: string, path: string) =>
  new Request(`https://flickto.app${path}`, { headers: { Authorization: `Bearer ${token}` } });

describe("friend requests", () => {
  it("creates a pending request, then the other side accepts", async () => {
    const env = await env0();
    expect((await (await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env)).json())).toEqual({ state: "pending" });

    const bView = (await (await handleGetFriends(get("tok-b", "/api/friends"), env)).json()) as any;
    expect(bView.incoming).toEqual([A]);
    expect(bView.accepted).toEqual([]);

    expect((await (await handleFriendAccept(post("tok-b", "/api/friends/accept", { userId: A }), env)).json())).toEqual({ state: "accepted" });
    const after = (await (await handleGetFriends(get("tok-a", "/api/friends"), env)).json()) as any;
    expect(after.accepted).toEqual([B]);
    expect(after.outgoing).toEqual([]);
  });

  it("treats requesting someone who already asked you as an accept", async () => {
    const env = await env0();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    const back = (await (await handleFriendRequest(post("tok-b", "/api/friends/request", { userId: A }), env)).json()) as any;
    expect(back.state).toBe("accepted");
  });

  it("refuses to friend yourself", async () => {
    const env = await env0();
    expect((await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: A }), env)).status).toBe(400);
  });

  it("404s a request to an account that does not exist", async () => {
    const env = await env0();
    const ghost = "ZZZZZ73X7P55T48R4CFHDED9CW";
    expect((await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: ghost }), env)).status).toBe(404);
  });

  it("404s accepting a request that was never sent", async () => {
    const env = await env0();
    expect((await handleFriendAccept(post("tok-b", "/api/friends/accept", { userId: A }), env)).status).toBe(404);
  });

  it("cannot accept your OWN outgoing request", async () => {
    const env = await env0();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    expect((await handleFriendAccept(post("tok-a", "/api/friends/accept", { userId: B }), env)).status).toBe(404);
  });

  it("rate-limits a sender", async () => {
    const env = await env0();
    env.FRIEND_REQUESTS_PER_HOUR = "1";
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    expect((await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: C }), env)).status).toBe(429);
  });

  it("removes a friendship idempotently", async () => {
    const env = await env0();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    await handleFriendAccept(post("tok-b", "/api/friends/accept", { userId: A }), env);
    expect((await handleFriendRemove(B, get("tok-a", `/api/friends/${B}`), env)).status).toBe(204);
    expect((await handleFriendRemove(B, get("tok-a", `/api/friends/${B}`), env)).status).toBe(204);
    const after = (await (await handleGetFriends(get("tok-a", "/api/friends"), env)).json()) as any;
    expect(after.accepted).toEqual([]);
  });

  it("401s every endpoint without a session", async () => {
    const env = await env0();
    const anon = new Request("https://flickto.app/api/friends", { method: "POST", body: "{}" });
    expect((await handleGetFriends(new Request("https://flickto.app/api/friends"), env)).status).toBe(401);
    expect((await handleFriendRequest(anon, env)).status).toBe(401);
  });
});

describe("blocking", () => {
  it("drops an existing friendship when blocking", async () => {
    const env = await env0();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    await handleFriendAccept(post("tok-b", "/api/friends/accept", { userId: A }), env);

    expect((await handleBlock(B, post("tok-a", `/api/blocks/${B}`), env)).status).toBe(204);
    const after = (await (await handleGetFriends(get("tok-a", "/api/friends"), env)).json()) as any;
    expect(after.accepted).toEqual([]);
    expect(await canView(env, B, A, "public")).toBe(false);
  });

  // The whole point of moving blocks server-side: enforcement is immediate, not
  // whenever the blocker's device next happens to rotate its keys.
  it("denies the blocked user immediately, in both directions", async () => {
    const env = await env0();
    await handleBlock(B, post("tok-a", `/api/blocks/${B}`), env);
    expect(await canView(env, B, A, "public")).toBe(false);
    expect(await canView(env, A, B, "public")).toBe(false);
  });

  // Otherwise this endpoint is a block detector.
  it("reports success for a request to someone who blocked you, and creates nothing", async () => {
    const env = await env0();
    await handleBlock(A, post("tok-b", `/api/blocks/${A}`), env);
    const res = await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "pending" }); // indistinguishable from success
    expect(env.DB.friendships.length).toBe(0); // ...but nothing was created
  });

  it("unblocking does not resurrect the friendship", async () => {
    const env = await env0();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    await handleFriendAccept(post("tok-b", "/api/friends/accept", { userId: A }), env);
    await handleBlock(B, post("tok-a", `/api/blocks/${B}`), env);
    await handleUnblock(B, post("tok-a", `/api/blocks/${B}`), env);
    const after = (await (await handleGetFriends(get("tok-a", "/api/friends"), env)).json()) as any;
    expect(after.accepted).toEqual([]);
  });

  it("lists only who I blocked, never who blocked me", async () => {
    const env = await env0();
    await handleBlock(B, post("tok-a", `/api/blocks/${B}`), env);
    await handleBlock(A, post("tok-c", `/api/blocks/${A}`), env); // C blocked A
    const mine = (await (await handleGetBlocks(get("tok-a", "/api/blocks"), env)).json()) as any;
    expect(mine.blocked.map((b: any) => b.userId)).toEqual([B]);
  });

  it("refuses to block yourself", async () => {
    const env = await env0();
    expect((await handleBlock(A, post("tok-a", `/api/blocks/${A}`), env)).status).toBe(400);
  });
});

describe("reports", () => {
  it("files one, and folds a repeat into it rather than stacking", async () => {
    const env = await env0();
    expect((await handleReport(post("tok-a", "/api/report", { userId: B, kind: "user", context: "spam" }), env)).status).toBe(204);
    await handleReport(post("tok-a", "/api/report", { userId: B, kind: "user" }), env);
    expect(env.DB.reports.length).toBe(1);
  });

  it("rejects an unknown kind and self-reporting", async () => {
    const env = await env0();
    expect((await handleReport(post("tok-a", "/api/report", { userId: B, kind: "nonsense" }), env)).status).toBe(400);
    expect((await handleReport(post("tok-a", "/api/report", { userId: A, kind: "user" }), env)).status).toBe(400);
  });
});

describe("bridging legacy device pairings", () => {
  it("claims a friendId, and refuses one already owned by someone else", async () => {
    const env = await env0();
    expect((await handleClaimFriendId(post("tok-a", "/api/me/friend-id", { friendId: "4S5SJK151CNQ6XHC0J" }), env)).status).toBe(200);
    expect((await handleClaimFriendId(post("tok-b", "/api/me/friend-id", { friendId: "4S5SJK151CNQ6XHC0J" }), env)).status).toBe(409);
    // Re-claiming your own is idempotent, not a conflict.
    expect((await handleClaimFriendId(post("tok-a", "/api/me/friend-id", { friendId: "4S5SJK151CNQ6XHC0J" }), env)).status).toBe(200);
  });

  it("links known friendIds as ACCEPTED and skips ids with no account", async () => {
    const env = await env0();
    await handleClaimFriendId(post("tok-b", "/api/me/friend-id", { friendId: "BBBBBB151CNQ6XHC0J" }), env);
    const res = (await (
      await handleLinkLegacyFriends(post("tok-a", "/api/friends/link-legacy", {
        friendIds: ["BBBBBB151CNQ6XHC0J", "NOACCOUNT151CNQ6XH"],
      }), env)
    ).json()) as any;

    expect(res).toEqual({ linked: 1, pendingSignup: 1 });
    // Already mutually agreed on the old system — re-confirming would be a regression.
    const after = (await (await handleGetFriends(get("tok-a", "/api/friends"), env)).json()) as any;
    expect(after.accepted).toEqual([B]);
  });

  it("never links a blocked pair", async () => {
    const env = await env0();
    await handleClaimFriendId(post("tok-b", "/api/me/friend-id", { friendId: "BBBBBB151CNQ6XHC0J" }), env);
    await handleBlock(B, post("tok-a", `/api/blocks/${B}`), env);
    const res = (await (
      await handleLinkLegacyFriends(post("tok-a", "/api/friends/link-legacy", { friendIds: ["BBBBBB151CNQ6XHC0J"] }), env)
    ).json()) as any;
    expect(res.linked).toBe(0);
  });
});

describe("account deletion", () => {
  it("erases the account and every edge touching it", async () => {
    const env = await env0();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    await handleFriendAccept(post("tok-b", "/api/friends/accept", { userId: A }), env);
    await handleBlock(C, post("tok-a", `/api/blocks/${C}`), env);
    await handleReport(post("tok-a", "/api/report", { userId: B, kind: "user" }), env);

    expect((await handleDeleteAccount(new Request("https://flickto.app/api/me/account", {
      method: "DELETE",
      headers: { Authorization: "Bearer tok-a" },
    }), env)).status).toBe(204);

    // A stale users row with a live friendship edge is a failed erasure, not a partial one.
    expect(env.DB.users.find((u: any) => u.id === A)).toBeUndefined();
    expect(env.DB.friendships.length).toBe(0);
    expect(env.DB.blocks.length).toBe(0);
    expect(env.DB.reports.length).toBe(0);
  });
});
