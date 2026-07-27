// Shared lists + Friend Match in D1 — the two directed-message types that used to
// live on the E2EE inbox.
//
// The properties worth pinning are the ones that are easy to get subtly wrong and
// impossible to notice in manual testing: the block rule (which must report success
// rather than reveal a block), the exchange order (nothing of the target's leaves
// before they consent), and the terminal states.

import { describe, it, expect } from "vitest";
import {
  handleAcceptSharedList,
  handleDeleteSharedList,
  handleGetSharedLists,
  handleShareList,
  loadSharedLists,
} from "./lists";
import {
  handleDeleteMatch,
  handleGetMatchPayload,
  handleGetMatches,
  handleMatchAccept,
  handleMatchRequest,
  loadMatches,
  sweepOnceMatchPayloads,
} from "./match";

const A = "AAAAH73X7P55T48R4CFHDED9CW";
const B = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const C = "CCCCK95Z9R77W60T6EHKFGFBY1";
const TOKENS: Record<string, string> = { "tok-a": A, "tok-b": B, "tok-c": C };

const LIST_ID = "0123456789ABCDEFGHJK";
const LIST_ID2 = "0123456789ABCDEFGHJM";

/**
 * Hand-rolled D1 stand-in, matching the shape `friends.test.ts` established: each
 * SQL prefix the handlers issue gets an explicit branch, and anything unrecognised
 * throws rather than silently returning nothing — a fake that quietly answers
 * "no rows" turns a broken query into a passing test.
 */
class FakeD1 {
  users: any[] = [];
  friendships: any[] = [];
  blocks: any[] = [];
  shared_lists: any[] = [];
  match_requests: any[] = [];
  match_payloads: any[] = [];
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
  bind(...args: unknown[]) {
    this.args = args as any[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    const s = this.sql;
    const a = this.args;
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
    if (s.startsWith("SELECT id FROM shared_lists")) {
      const r = this.db.shared_lists.find((x) => x.id === a[0] && x.recipient_id === a[1]);
      return r ? ({ id: r.id } as T) : null;
    }
    if (s.startsWith("SELECT id, state FROM match_requests")) {
      const r = this.db.match_requests.find((x) => x.requester_id === a[0] && x.target_id === a[1]);
      return r ? ({ id: r.id, state: r.state } as T) : null;
    }
    if (s.startsWith("SELECT id, requester_id, target_id, state FROM match_requests")) {
      const r = this.db.match_requests.find((x) => x.id === a[0] && x.target_id === a[1]);
      return (r as T) ?? null;
    }
    if (s.startsWith("SELECT id, requester_id, target_id, state, retention FROM match_requests")) {
      return (this.db.match_requests.find((x) => x.id === a[0]) as T) ?? null;
    }
    if (s.startsWith("SELECT id, requester_id, target_id FROM match_requests")) {
      return (this.db.match_requests.find((x) => x.id === a[0]) as T) ?? null;
    }
    if (s.startsWith("SELECT sealed FROM match_payloads")) {
      const r = this.db.match_payloads.find((x) => x.request_id === a[0] && x.sender_id === a[1]);
      return r ? ({ sealed: r.sealed } as T) : null;
    }
    if (s.startsWith("SELECT COUNT(*) AS n, SUM(")) {
      const rows = this.db.match_payloads.filter((x) => x.request_id === a[0]);
      return { n: rows.length, got: rows.filter((x) => x.fetched_at > 0).length } as T;
    }
    if (s.startsWith("SELECT COUNT(*) AS n FROM match_requests WHERE requester_id")) {
      return { n: this.db.match_requests.filter((x) => x.requester_id === a[0] && x.created_at > a[1]).length } as T;
    }
    throw new Error(`FakeD1: unhandled first() ${s}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const s = this.sql;
    const a = this.args;
    if (s.startsWith("SELECT id, sender_id, recipient_id, title, kind, item_count, payload, created_at, state")) {
      return {
        results: this.db.shared_lists
          .filter((x) => x.recipient_id === a[0])
          .sort((x, y) => y.created_at - x.created_at)
          .slice(0, a[1]) as T[],
      };
    }
    if (s.startsWith("SELECT id, requester_id, target_id, state, origin, retention, requester_keyset")) {
      return { results: this.db.match_requests.filter((x) => x.requester_id === a[0] || x.target_id === a[1]) as T[] };
    }
    throw new Error(`FakeD1: unhandled all() ${s}`);
  }

  async run() {
    const s = this.sql;
    const a = this.args;
    if (s.startsWith("INSERT INTO shared_lists")) {
      if (!this.db.shared_lists.some((x) => x.id === a[0])) {
        this.db.shared_lists.push({
          id: a[0], sender_id: a[1], recipient_id: a[2], title: a[3], kind: a[4],
          item_count: a[5], payload: a[6], created_at: a[7], state: "pending",
        });
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE shared_lists SET state = 'accepted'")) {
      const r = this.db.shared_lists.find(
        (x) => x.id === a[0] && x.recipient_id === a[1] && x.state !== "accepted",
      );
      if (r) r.state = "accepted";
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("DELETE FROM shared_lists")) {
      const before = this.db.shared_lists.length;
      this.db.shared_lists = this.db.shared_lists.filter(
        (x) => !(x.id === a[0] && (x.recipient_id === a[1] || x.sender_id === a[2])),
      );
      return { success: true, meta: { changes: before - this.db.shared_lists.length } };
    }
    if (s.startsWith("INSERT INTO match_requests")) {
      this.db.match_requests.push({
        id: a[0], requester_id: a[1], target_id: a[2], state: "pending", origin: a[3],
        retention: a[4], requester_keyset: a[5], anchor_at: a[6], created_at: a[7], updated_at: a[8],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE match_requests SET state = 'pending'")) {
      const r = this.db.match_requests.find((x) => x.id === a[6]);
      if (r) Object.assign(r, {
        state: "pending", origin: a[0], retention: a[1], requester_keyset: a[2],
        anchor_at: a[3], created_at: a[4], updated_at: a[5],
      });
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE match_requests SET state = 'accepted'")) {
      const r = this.db.match_requests.find((x) => x.id === a[1]);
      if (r) r.state = "accepted";
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE match_requests SET state = ?")) {
      const r = this.db.match_requests.find((x) => x.id === a[2]);
      if (r) r.state = a[0];
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("INSERT INTO match_payloads")) {
      const found = this.db.match_payloads.find((x) => x.request_id === a[0] && x.sender_id === a[1]);
      if (found) Object.assign(found, { sealed: a[2], created_at: a[3], fetched_at: 0 });
      else this.db.match_payloads.push({ request_id: a[0], sender_id: a[1], sealed: a[2], created_at: a[3], fetched_at: 0 });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE match_payloads SET fetched_at")) {
      const r = this.db.match_payloads.find((x) => x.request_id === a[1] && x.sender_id === a[2] && x.fetched_at === 0);
      if (r) r.fetched_at = a[0];
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("DELETE FROM match_payloads WHERE created_at <")) {
      const once = new Set(this.db.match_requests.filter((x) => x.retention === "once").map((x) => x.id));
      this.db.match_payloads = this.db.match_payloads.filter((x) => !(x.created_at < a[0] && once.has(x.request_id)));
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM match_payloads WHERE request_id")) {
      this.db.match_payloads = this.db.match_payloads.filter((x) => x.request_id !== a[0]);
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() ${s}`);
  }
}

async function env0() {
  const env = { DB: new FakeD1(), FIREBASE_PROJECT_ID: "flickto-cf7b6" } as any;
  const enc = new TextEncoder();
  for (const [token, user] of Object.entries(TOKENS)) {
    const d = await crypto.subtle.digest("SHA-256", enc.encode(token));
    env.DB.sessions.set([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""), user);
    env.DB.users.push({ id: user, status: "active" });
  }
  return env;
}

/** Canonical ordering, as `friendshipKey` does — the fake stores what the code binds. */
function befriend(env: any, x: string, y: string) {
  const [a, b] = x < y ? [x, y] : [y, x];
  env.DB.friendships.push({ user_a: a, user_b: b, state: "accepted", requested_by: a });
}

const post = (token: string, path: string, body?: unknown) =>
  new Request(`https://flickto.app${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (token: string, path: string) =>
  new Request(`https://flickto.app${path}`, { headers: { Authorization: `Bearer ${token}` } });
const del = (token: string, path: string) =>
  new Request(`https://flickto.app${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });

const shareBody = (recipientId: string, id = LIST_ID) => ({
  id,
  recipientId,
  title: "Weekend picks",
  kind: "manual",
  itemCount: 2,
  payload: JSON.stringify([{ tmdbId: 603, mediaType: "MOVIE" }]),
});

const requestBody = (targetId: string, extra: Record<string, unknown> = {}) => ({
  targetId,
  sealed: "SEALED-BY-REQUESTER",
  keyset: "PUBKEYSET-A",
  retention: "keep",
  anchorAt: 1000,
  ...extra,
});

// ── Shared lists ─────────────────────────────────────────────────────────────

describe("sharing a list to a friend", () => {
  it("delivers to a friend and shows up as pending for them, not for a bystander", async () => {
    const env = await env0();
    befriend(env, A, B);
    const res = await handleShareList(post("tok-a", "/api/lists/share", shareBody(B)), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: LIST_ID });

    const mine = (await (await handleGetSharedLists(get("tok-b", "/api/lists/shared"), env)).json()) as any;
    expect(mine.pending.map((l: any) => l.id)).toEqual([LIST_ID]);
    expect(mine.pending[0].senderId).toBe(A);

    const theirs = (await (await handleGetSharedLists(get("tok-c", "/api/lists/shared"), env)).json()) as any;
    expect(theirs.pending).toEqual([]);
  });

  // These are directed messages: a non-friend must not be able to address you at all.
  it("403s a share to a non-friend and creates nothing", async () => {
    const env = await env0();
    const res = await handleShareList(post("tok-a", "/api/lists/share", shareBody(B)), env);
    expect(res.status).toBe(403);
    expect(env.DB.shared_lists.length).toBe(0);
  });

  // Otherwise this endpoint is a block detector.
  it("reports success for a share to someone who blocked you, and creates nothing", async () => {
    const env = await env0();
    befriend(env, A, B);
    env.DB.blocks.push({ blocker_id: B, blocked_id: A });
    const res = await handleShareList(post("tok-a", "/api/lists/share", shareBody(B)), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: LIST_ID }); // indistinguishable from delivery
    expect(env.DB.shared_lists.length).toBe(0); // ...but nothing was created
  });

  // The sender mints the id so the same share riding both transports de-dupes; a
  // retry after a dropped response must not stack either.
  it("is idempotent on the sender-minted id", async () => {
    const env = await env0();
    befriend(env, A, B);
    await handleShareList(post("tok-a", "/api/lists/share", shareBody(B)), env);
    await handleShareList(post("tok-a", "/api/lists/share", shareBody(B)), env);
    expect(env.DB.shared_lists.length).toBe(1);
  });

  it("rejects a payload over the cap and a share to yourself", async () => {
    const env = await env0();
    befriend(env, A, B);
    const big = { ...shareBody(B), payload: "x".repeat(3000) };
    expect((await handleShareList(post("tok-a", "/api/lists/share", big), env)).status).toBe(413);
    expect((await handleShareList(post("tok-a", "/api/lists/share", shareBody(A)), env)).status).toBe(400);
  });
});

describe("accepting and declining a shared list", () => {
  it("accepts idempotently and moves the row from pending to accepted", async () => {
    const env = await env0();
    befriend(env, A, B);
    await handleShareList(post("tok-a", "/api/lists/share", shareBody(B)), env);

    expect((await handleAcceptSharedList(LIST_ID, post("tok-b", ""), env)).status).toBe(204);
    expect((await handleAcceptSharedList(LIST_ID, post("tok-b", ""), env)).status).toBe(204);

    const after = await loadSharedLists(env, B);
    expect(after.pending).toEqual([]);
    expect(after.accepted.map((l: any) => l.id)).toEqual([LIST_ID]);
  });

  // 404 rather than 403: answering differently would confirm the id exists.
  it("404s an accept by anyone other than the recipient", async () => {
    const env = await env0();
    befriend(env, A, B);
    await handleShareList(post("tok-a", "/api/lists/share", shareBody(B)), env);
    expect((await handleAcceptSharedList(LIST_ID, post("tok-c", ""), env)).status).toBe(404);
    expect((await handleAcceptSharedList(LIST_ID, post("tok-a", ""), env)).status).toBe(404);
    expect(env.DB.shared_lists[0].state).toBe("pending");
  });

  it("lets the recipient decline and the sender withdraw, and 204s an unknown id", async () => {
    const env = await env0();
    befriend(env, A, B);
    await handleShareList(post("tok-a", "/api/lists/share", shareBody(B)), env);
    expect((await handleDeleteSharedList(LIST_ID, del("tok-b", ""), env)).status).toBe(204);
    expect(env.DB.shared_lists.length).toBe(0);

    await handleShareList(post("tok-a", "/api/lists/share", shareBody(B, LIST_ID2)), env);
    expect((await handleDeleteSharedList(LIST_ID2, del("tok-a", ""), env)).status).toBe(204);
    expect(env.DB.shared_lists.length).toBe(0);

    expect((await handleDeleteSharedList(LIST_ID, del("tok-c", ""), env)).status).toBe(204);
  });

  it("401s every list endpoint without a session", async () => {
    const env = await env0();
    const anon = (method: string) => new Request("https://flickto.app/api/lists/shared", { method, body: undefined });
    expect((await handleShareList(new Request("https://flickto.app/api/lists/share", { method: "POST" }), env)).status).toBe(401);
    expect((await handleGetSharedLists(anon("GET"), env)).status).toBe(401);
    expect((await handleAcceptSharedList(LIST_ID, anon("POST"), env)).status).toBe(401);
    expect((await handleDeleteSharedList(LIST_ID, anon("DELETE"), env)).status).toBe(401);
  });
});

// ── Friend Match ─────────────────────────────────────────────────────────────

describe("the match handshake", () => {
  it("carries the requester's blob on the request and the target's only on accept", async () => {
    const env = await env0();
    befriend(env, A, B);
    const { id } = (await (await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B)), env)).json()) as any;

    // THE privacy property. Before accept the server holds one blob, the
    // requester's, and it is addressed to the target.
    expect(env.DB.match_payloads.map((p: any) => p.sender_id)).toEqual([A]);
    // ...and neither side may collect anything yet.
    expect((await handleGetMatchPayload(id, get("tok-b", ""), env)).status).toBe(404);
    expect((await handleGetMatchPayload(id, get("tok-a", ""), env)).status).toBe(404);

    const accepted = await handleMatchAccept(id, post("tok-b", "", { sealed: "SEALED-BY-TARGET" }), env);
    expect(await accepted.json()).toEqual({ state: "accepted" });
    expect(env.DB.match_payloads.map((p: any) => p.sender_id).sort()).toEqual([A, B]);

    // Each side fetches the OTHER's blob, never their own.
    expect(await (await handleGetMatchPayload(id, get("tok-a", ""), env)).json()).toEqual({ sealed: "SEALED-BY-TARGET" });
    expect(await (await handleGetMatchPayload(id, get("tok-b", ""), env)).json()).toEqual({ sealed: "SEALED-BY-REQUESTER" });
  });

  it("hands the target the requester's public keyset, so a stranger can seal back", async () => {
    const env = await env0();
    befriend(env, A, B);
    await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B)), env);
    const incoming = (await loadMatches(env, B)).incoming as any[];
    expect(incoming[0].requesterKeyset).toBe("PUBKEYSET-A");
  });

  it("is one row per direction, and re-requesting after a decline is allowed", async () => {
    const env = await env0();
    befriend(env, A, B);
    const first = (await (await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B)), env)).json()) as any;
    const again = (await (await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B)), env)).json()) as any;
    expect(env.DB.match_requests.length).toBe(1);
    expect(again.id).toBe(first.id);

    await handleDeleteMatch(first.id, del("tok-b", ""), env);
    expect(env.DB.match_requests[0].state).toBe("declined");

    const reopened = (await (await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B)), env)).json()) as any;
    expect(env.DB.match_requests.length).toBe(1);
    expect(reopened.state).toBe("pending");
  });

  it("lands revoke and decline on distinct terminal states and drops the blobs", async () => {
    const env = await env0();
    befriend(env, A, B);
    const { id } = (await (await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B)), env)).json()) as any;
    await handleMatchAccept(id, post("tok-b", "", { sealed: "SEALED-BY-TARGET" }), env);

    expect((await handleDeleteMatch(id, del("tok-a", ""), env)).status).toBe(204);
    expect(env.DB.match_requests[0].state).toBe("revoked");
    // Whatever this was, it is over — the sealed halves go with it.
    expect(env.DB.match_payloads.length).toBe(0);
    // The handshake row survives so the other side converges rather than the
    // request simply vanishing.
    expect((await loadMatches(env, B)).incoming.length).toBe(1);
  });

  it("reports success for a request to someone who blocked you, and creates nothing", async () => {
    const env = await env0();
    befriend(env, A, B);
    env.DB.blocks.push({ blocker_id: B, blocked_id: A });
    const res = await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B)), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).state).toBe("pending"); // indistinguishable
    expect(env.DB.match_requests.length).toBe(0);
    expect(env.DB.match_payloads.length).toBe(0);
  });

  // Not a new restriction — FriendMatchRepository already refuses on both ends
  // unless the pair are accepted friends. The rule just moved server-side.
  it("403s a friend-origin request between non-friends", async () => {
    const env = await env0();
    expect((await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B)), env)).status).toBe(403);
    expect(env.DB.match_requests.length).toBe(0);
  });

  // The fallback read, for a pass that could not use the consolidated sync. Without
  // it the only way to read a handshake would be the very request that just failed.
  it("lists both directions, and never someone else's handshake", async () => {
    const env = await env0();
    befriend(env, A, B);
    await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B)), env);

    const mine = (await (await handleGetMatches(get("tok-a", "/api/match"), env)).json()) as any;
    expect(mine.outgoing.map((m: any) => m.targetId)).toEqual([B]);
    expect(mine.incoming).toEqual([]);

    const theirs = (await (await handleGetMatches(get("tok-b", "/api/match"), env)).json()) as any;
    expect(theirs.incoming.map((m: any) => m.requesterId)).toEqual([A]);

    const bystander = (await (await handleGetMatches(get("tok-c", "/api/match"), env)).json()) as any;
    expect(bystander.incoming).toEqual([]);
    expect(bystander.outgoing).toEqual([]);
  });

  it("401s every match endpoint without a session", async () => {
    const env = await env0();
    const anon = (method: string) => new Request("https://flickto.app/api/match/request", { method });
    expect((await handleMatchRequest(anon("POST"), env)).status).toBe(401);
    expect((await handleGetMatches(new Request("https://flickto.app/api/match"), env)).status).toBe(401);
    expect((await handleMatchAccept("Z".repeat(26), anon("POST"), env)).status).toBe(401);
    expect((await handleGetMatchPayload("Z".repeat(26), anon("GET"), env)).status).toBe(401);
    expect((await handleDeleteMatch("Z".repeat(26), anon("DELETE"), env)).status).toBe(401);
  });
});

describe("stranger match (origin = scan)", () => {
  const resolver = (owner: string | null) => async (_code: string) => owner;

  it("lets a non-friend request when they present that person's published card", async () => {
    const env = await env0();
    const res = await handleMatchRequest(
      post("tok-a", "/api/match/request", requestBody(B, { origin: "scan", targetFriendCode: "ABC123", retention: "keep" })),
      env,
      undefined,
      resolver(B),
    );
    expect(res.status).toBe(200);
    // `once` is forced: a stranger match is exactly what that term was invented for,
    // so the requester does not get to propose "keep".
    expect(env.DB.match_requests[0].retention).toBe("once");
    expect(env.DB.match_requests[0].origin).toBe("scan");
  });

  it("403s a scan request whose card belongs to someone else, or is unknown", async () => {
    const env = await env0();
    const wrong = await handleMatchRequest(
      post("tok-a", "/api/match/request", requestBody(B, { origin: "scan", targetFriendCode: "ABC123" })),
      env,
      undefined,
      resolver(C),
    );
    expect(wrong.status).toBe(403);

    const unknown = await handleMatchRequest(
      post("tok-a", "/api/match/request", requestBody(B, { origin: "scan", targetFriendCode: "ABC123" })),
      env,
      undefined,
      resolver(null),
    );
    expect(unknown.status).toBe(403);
    expect(env.DB.match_requests.length).toBe(0);
  });

  it("still lets a block win silently, card or no card", async () => {
    const env = await env0();
    env.DB.blocks.push({ blocker_id: B, blocked_id: A });
    const res = await handleMatchRequest(
      post("tok-a", "/api/match/request", requestBody(B, { origin: "scan", targetFriendCode: "ABC123" })),
      env,
      undefined,
      resolver(B),
    );
    expect(res.status).toBe(200);
    expect(env.DB.match_requests.length).toBe(0);
  });
});

describe("retention = once", () => {
  it("really deletes both blobs once both sides have collected", async () => {
    const env = await env0();
    befriend(env, A, B);
    const { id } = (await (
      await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B, { retention: "once" })), env)
    ).json()) as any;
    await handleMatchAccept(id, post("tok-b", "", { sealed: "SEALED-BY-TARGET" }), env);

    await handleGetMatchPayload(id, get("tok-a", ""), env);
    expect(env.DB.match_payloads.length).toBe(2); // one side collected; the other may still be offline
    await handleGetMatchPayload(id, get("tok-b", ""), env);
    expect(env.DB.match_payloads.length).toBe(0);
    // The record that a match happened outlives the payload.
    expect(env.DB.match_requests.length).toBe(1);
  });

  it("keeps a 'keep' match's blobs after both sides collect", async () => {
    const env = await env0();
    befriend(env, A, B);
    const { id } = (await (await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B)), env)).json()) as any;
    await handleMatchAccept(id, post("tok-b", "", { sealed: "SEALED-BY-TARGET" }), env);
    await handleGetMatchPayload(id, get("tok-a", ""), env);
    await handleGetMatchPayload(id, get("tok-b", ""), env);
    expect(env.DB.match_payloads.length).toBe(2);
  });

  // The backstop for a device that never comes back. Not a cron — this account is
  // at its 5-cron limit, so it rides ambient sync traffic.
  it("sweeps abandoned once payloads past the TTL, and leaves keep alone", async () => {
    const env = await env0();
    befriend(env, A, B);
    const once = (await (
      await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(B, { retention: "once" })), env)
    ).json()) as any;
    befriend(env, A, C);
    await handleMatchRequest(post("tok-a", "/api/match/request", requestBody(C)), env);
    expect(env.DB.match_payloads.length).toBe(2);

    await sweepOnceMatchPayloads(env, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(env.DB.match_payloads.map((p: any) => p.request_id)).not.toContain(once.id);
    expect(env.DB.match_payloads.length).toBe(1);
  });
});
