import { describe, it, expect } from "vitest";
import {
  handleBlock,
  handleClaimFriendId,
  handleDeleteAccount,
  handleFriendAccept,
  handleFriendRemove,
  handleFriendRemoveByFriendId,
  handleFriendRequest,
  handleGetBlocks,
  handleGetFriendCards,
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
      // Dedupe is per reporter/target/KIND — reporting a picture must not swallow a
      // later report about behaviour, so the fake has to key on kind too or the
      // regression it guards against would pass here.
      const r = this.db.reports.find(
        (x) => x.reporter_id === a[0] && x.target_id === a[1] && x.kind === a[2] && x.state === "open",
      );
      return r ? ({ id: r.id } as T) : null;
    }
    if (s.startsWith("SELECT COUNT(DISTINCT reporter_id) AS n FROM reports")) {
      const who = new Set(
        this.db.reports
          .filter((x) => x.target_id === a[0] && x.kind === "picture" && x.state === "open")
          .map((x) => x.reporter_id),
      );
      return { n: who.size } as T;
    }
    if (s.startsWith("SELECT friend_id FROM users WHERE id = ?")) {
      const u = this.db.users.find((x) => x.id === a[0]);
      return u ? ({ friend_id: u.friend_id ?? null } as T) : null;
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
    if (s.startsWith("SELECT id, friend_id FROM users WHERE id IN")) {
      return {
        results: this.db.users.filter(
          (u) => a.includes(u.id) && u.status === "active" && u.friend_id != null,
        ) as T[],
      };
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
      // Part of the erasure batch but not modelled here — `listsMatch.test.ts` owns
      // the assertions for those three tables. They must not throw, though: the batch
      // runs as one unit, so an unhandled statement fails the whole erasure.
      ["DELETE FROM match_payloads", "match_payloads", null],
      ["DELETE FROM match_requests", "match_requests", null],
      ["DELETE FROM shared_lists", "shared_lists", null],
      ["DELETE FROM feed_events", "feed_events", null],
      ["UPDATE comment_reaction_counts", "comment_reaction_counts", null],
      ["DELETE FROM comment_reactions", "comment_reactions", null],
      ["DELETE FROM comment_reaction_counts", "comment_reaction_counts", null],
      ["DELETE FROM comment_translations", "comment_translations", null],
      ["UPDATE comment_counts", "comment_counts", null],
      ["DELETE FROM comments", "comments", null],
      ["DELETE FROM episode_votes", "episode_votes", "user_id"],
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

  /**
   * **Nothing else tells the recipient a request exists.** Until pairing left the E2EE
   * inbox (2026-07-28) the sealed FRIEND_REQUEST woke them as a side effect of the
   * inbox POST; deleting that send took the wake-up with it and the request sat in D1,
   * correct and invisible, until their next scheduled sync — measured on device the
   * same day, with the row present and the tablet showing nothing.
   */
  it("wakes the target when a request is created", async () => {
    const env = await env0();
    const woke: string[] = [];

    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env, undefined, (id) =>
      woke.push(id),
    );

    expect(woke).toEqual([B]);
  });

  /** The requester has been waiting since they asked. */
  it("wakes the requester when their request is accepted", async () => {
    const env = await env0();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    const woke: string[] = [];

    await handleFriendAccept(post("tok-b", "/api/friends/accept", { userId: A }), env, undefined, (id) =>
      woke.push(id),
    );

    expect(woke).toEqual([A]);
  });

  /** A repeat accept changes nothing, so it must not re-wake anyone. */
  it("does not wake on a repeat accept", async () => {
    const env = await env0();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    await handleFriendAccept(post("tok-b", "/api/friends/accept", { userId: A }), env);
    const woke: string[] = [];

    await handleFriendAccept(post("tok-b", "/api/friends/accept", { userId: A }), env, undefined, (id) =>
      woke.push(id),
    );

    expect(woke).toEqual([]);
  });

  /** The request endpoint doubles as an accept; that path owes a wake-up too. */
  it("wakes the original asker when a mutual request lands as an accept", async () => {
    const env = await env0();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    const woke: string[] = [];

    await handleFriendRequest(post("tok-b", "/api/friends/request", { userId: A }), env, undefined, (id) =>
      woke.push(id),
    );

    expect(woke).toEqual([A]);
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

describe("removing by device friendId", () => {
  const del = (token: string, friendId: string) =>
    new Request(`https://flickto.app/api/friends/by-friend/${friendId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

  /**
   * The 2026-07-28 device bug: the client could not name B's account id, gave up
   * silently, and the friendship outlived the unfriend on the server.
   */
  it("deletes the friendship without the caller knowing the account id", async () => {
    const env = await env0();
    env.DB.users.find((u: any) => u.id === B).friend_id = "FRIENDIDBBBB";
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    await handleFriendAccept(post("tok-b", "/api/friends/accept", { userId: A }), env);

    expect((await handleFriendRemoveByFriendId("FRIENDIDBBBB", del("tok-a", "FRIENDIDBBBB"), env)).status).toBe(204);

    const after = (await (await handleGetFriends(get("tok-a", "/api/friends"), env)).json()) as any;
    expect(after.accepted).toEqual([]);
    const theirs = (await (await handleGetFriends(get("tok-b", "/api/friends"), env)).json()) as any;
    // Both sides must lose it, or a re-add resolves straight to accepted.
    expect(theirs.accepted).toEqual([]);
  });

  it("answers 204 for an unknown friendId, revealing nothing", async () => {
    const env = await env0();
    expect((await handleFriendRemoveByFriendId("FRIENDIDZZZZ", del("tok-a", "FRIENDIDZZZZ"), env)).status).toBe(204);
  });

  it("still requires a session", async () => {
    const env = await env0();
    expect((await handleFriendRemoveByFriendId("FRIENDIDBBBB", del("nope", "FRIENDIDBBBB"), env)).status).toBe(401);
  });

  /** A removal must never resolve to the caller's own row. */
  it("ignores my own friendId", async () => {
    const env = await env0();
    env.DB.users.find((u: any) => u.id === A).friend_id = "FRIENDIDAAAA";
    expect((await handleFriendRemoveByFriendId("FRIENDIDAAAA", del("tok-a", "FRIENDIDAAAA"), env)).status).toBe(204);
  });
});

describe("friend cards", () => {
  // Cards live in R2; the handler takes a loader so this module stays D1-only.
  const card = (friendId: string, name: string, n: string) => ({
    friendId,
    displayName: name,
    avatarId: `av${n}`,
    borderId: `bo${n}`,
    pictureUrl: "",
    publicKeyset: `ks-${n}`,
    feedReadToken: `rt-${n}`,
  });
  const cards: Record<string, any> = {
    "FRIENDIDAAAA": card("FRIENDIDAAAA", "Ada", "a"),
    "FRIENDIDBBBB": card("FRIENDIDBBBB", "Bo", "b"),
    "FRIENDIDCCCC": card("FRIENDIDCCCC", "Cy", "c"),
  };
  const loader = async (friendId: string) => cards[friendId] ?? null;

  /** Everyone has claimed a friendId and published a card. */
  const seeded = async () => {
    const env = await env0();
    env.DB.users.find((u: any) => u.id === A).friend_id = "FRIENDIDAAAA";
    env.DB.users.find((u: any) => u.id === B).friend_id = "FRIENDIDBBBB";
    env.DB.users.find((u: any) => u.id === C).friend_id = "FRIENDIDCCCC";
    return env;
  };

  it("serves the card once an edge exists, pending included", async () => {
    const env = await seeded();
    // Pending is the case that matters: an incoming request is unanswerable
    // without the requester's keyset, which is the whole reason this exists.
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);

    const res = (await (await handleGetFriendCards(post("tok-b", "/api/friends/cards", { userIds: [A] }), env, loader)).json()) as any;
    // feedReadToken must ride along: without it the new friend's feed is unreadable.
    expect(res.cards).toEqual([{ userId: A, ...cards["FRIENDIDAAAA"] }]);
  });

  /** The security argument: a users.id is not a capability, a friend code is. */
  it("omits a stranger, so this is not a card-enumeration oracle", async () => {
    const env = await seeded();
    const res = (await (await handleGetFriendCards(post("tok-a", "/api/friends/cards", { userIds: [C] }), env, loader)).json()) as any;
    expect(res.cards).toEqual([]);
  });

  it("omits a blocked pair even though the edge once existed", async () => {
    const env = await seeded();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    await handleBlock(A, post("tok-b", `/api/blocks/${A}`), env);

    const res = (await (await handleGetFriendCards(post("tok-b", "/api/friends/cards", { userIds: [A] }), env, loader)).json()) as any;
    expect(res.cards).toEqual([]);
  });

  it("omits a friend who has never claimed a friendId or published a card", async () => {
    const env = await seeded();
    env.DB.users.find((u: any) => u.id === A).friend_id = null;
    await handleFriendRequest(post("tok-b", "/api/friends/request", { userId: A }), env);

    const res = (await (await handleGetFriendCards(post("tok-b", "/api/friends/cards", { userIds: [A] }), env, loader)).json()) as any;
    expect(res.cards).toEqual([]);
  });

  /** users.friend_id is claim-checked; the R2 blob is client-written. */
  it("rejects a card whose friendId disagrees with the claimed one", async () => {
    const env = await seeded();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    const lying = async () => ({ ...cards["FRIENDIDCCCC"] });

    const res = (await (await handleGetFriendCards(post("tok-b", "/api/friends/cards", { userIds: [A] }), env, lying)).json()) as any;
    expect(res.cards).toEqual([]);
  });

  it("requires a session and a well-formed body", async () => {
    const env = await seeded();
    expect((await handleGetFriendCards(post("nope", "/api/friends/cards", { userIds: [A] }), env, loader)).status).toBe(401);
    expect((await handleGetFriendCards(post("tok-a", "/api/friends/cards", {}), env, loader)).status).toBe(400);
  });

  it("caps the lookup and ignores junk ids without erroring", async () => {
    const env = await seeded();
    await handleFriendRequest(post("tok-a", "/api/friends/request", { userId: B }), env);
    const padding = Array.from({ length: 40 }, (_, i) => `ZZZZ${String(i).padStart(22, "0")}`);

    const res = (await (await handleGetFriendCards(
      post("tok-b", "/api/friends/cards", { userIds: [...padding, "not-an-id", A] }),
      env,
      loader,
    )).json()) as any;
    // A is past the 25-id cap once the junk ahead of it survives validation, so the
    // only guarantee is that this answers rather than throwing.
    expect(Array.isArray(res.cards)).toBe(true);
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

  it("keeps reports of DIFFERENT kinds about the same person separate", async () => {
    const env = await env0();
    await handleReport(post("tok-a", "/api/report", { userId: B, kind: "user" }), env);
    await handleReport(post("tok-a", "/api/report", { userId: B, kind: "picture" }), env);
    // Deduping on the pair alone would have swallowed the second: reporting someone's
    // picture must not silence a later report about their behaviour.
    expect(env.DB.reports.length).toBe(2);
  });

  it("accepts feed_comment, the kind the relay endpoint used to carry", async () => {
    const env = await env0();
    expect(
      (await handleReport(post("tok-a", "/api/report", { userId: B, kind: "feed_comment", context: "abuse" }), env))
        .status,
    ).toBe(204);
  });
});

// ── Profile-picture auto-hide ────────────────────────────────────────────────
// Ported from the relay report handler. It is the only automatic takedown in the
// system, so it gets its own coverage: losing it in the migration would have
// removed an abuse control rather than dead code.
describe("picture auto-hide", () => {
  /** A bucket fake that records puts, so the tombstone is observable. */
  const makeBucket = () => {
    const puts = new Map<string, string>();
    return {
      puts,
      put: async (k: string, v: string) => {
        puts.set(k, v);
      },
      delete: async (k: string) => {
        puts.delete(k);
      },
    } as any;
  };

  const withBucket = async (autohide = "3") => {
    const env: any = await env0();
    env.BUCKET = makeBucket();
    env.REPORT_AUTOHIDE = autohide;
    // The tombstone is keyed on the device friendId, so the target needs one claimed.
    env.DB.users.find((u: any) => u.id === B).friend_id = "BBBBBB151CNQ6XHC0J";
    return env;
  };

  it("tombstones the picture once enough DISTINCT reporters flag it", async () => {
    const env = await withBucket("2");
    await handleReport(post("tok-a", "/api/report", { userId: B, kind: "picture" }), env);
    expect(env.BUCKET.puts.size).toBe(0);
    await handleReport(post("tok-c", "/api/report", { userId: B, kind: "picture" }), env);
    expect(env.BUCKET.puts.get(`_moderation/u/${B}.json`)).toContain("auto_report_threshold");
  });

  /**
   * The picture is reachable by two routes — account-keyed and legacy friendId — and
   * each checks only its own key. Writing one and not the other leaves the image up on
   * the other route, which is this control silently not working. Drop the legacy half
   * of this assertion when the legacy route goes, not before.
   */
  it("writes BOTH tombstone keys while the legacy picture route still serves", async () => {
    const env = await withBucket("1");
    await handleReport(post("tok-a", "/api/report", { userId: B, kind: "picture" }), env);
    expect([...env.BUCKET.puts.keys()].sort()).toEqual(
      [`_moderation/BBBBBB151CNQ6XHC0J.json`, `_moderation/u/${B}.json`].sort(),
    );
  });

  it("does not let ONE reporter trip the threshold by reporting repeatedly", async () => {
    const env = await withBucket("2");
    await handleReport(post("tok-a", "/api/report", { userId: B, kind: "picture" }), env);
    await handleReport(post("tok-a", "/api/report", { userId: B, kind: "picture" }), env);
    await handleReport(post("tok-a", "/api/report", { userId: B, kind: "picture" }), env);
    expect(env.BUCKET.puts.size).toBe(0);
  });

  /**
   * Was a documented gap: while the tombstone was keyed on the device friendId, an
   * account that had never claimed one could NEVER have its picture taken down, and
   * nothing said so. The account-keyed tombstone needs no friendId, so those accounts
   * are covered now — the legacy key is simply skipped.
   */
  it("tombstones a target with no claimed friendId, on the account key alone", async () => {
    const env: any = await env0();
    env.BUCKET = makeBucket();
    env.REPORT_AUTOHIDE = "1";
    expect((await handleReport(post("tok-a", "/api/report", { userId: B, kind: "picture" }), env)).status).toBe(204);
    expect(env.DB.reports.length).toBe(1);
    expect([...env.BUCKET.puts.keys()]).toEqual([`_moderation/u/${B}.json`]);
  });

  it("files the report with no bucket bound at all", async () => {
    const env: any = await env0();
    env.REPORT_AUTOHIDE = "1";
    expect((await handleReport(post("tok-a", "/api/report", { userId: B, kind: "picture" }), env)).status).toBe(204);
    expect(env.DB.reports.length).toBe(1);
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

    expect(res.linked).toBe(1);
    expect(res.pendingSignup).toBe(1);
    // The client cannot address a friend server-side without this pairing.
    expect(res.mapping).toEqual([{ friendId: "BBBBBB151CNQ6XHC0J", userId: B }]);
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

  /**
   * ⚠️ A table missing from the erasure batch fails SILENTLY — the delete returns 204
   * and the rows simply stay. That is how `episode_votes` was left behind when the poll
   * shipped, and it is only visible if something asserts it. The privacy policy claims
   * a vote is removed with the account; this is what makes that claim true.
   */
  it("erases episode poll votes", async () => {
    const env = await env0();
    env.DB.episode_votes = [
      { user_id: A, tmdb_id: 125988, media_type: "show", season: 1, episode: 1 },
      { user_id: B, tmdb_id: 125988, media_type: "show", season: 1, episode: 1 },
    ];

    await handleDeleteAccount(new Request("https://flickto.app/api/me/account", {
      method: "DELETE",
      headers: { Authorization: "Bearer tok-a" },
    }), env);

    expect(env.DB.episode_votes.map((v: any) => v.user_id)).toEqual([B]);
  });
});
