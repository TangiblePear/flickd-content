import { describe, it, expect } from "vitest";
import worker from "./index";

/**
 * Route **wiring**, exercised through `worker.fetch` rather than by calling
 * handlers directly.
 *
 * Every other suite here imports a handler and calls it. That tests the handler
 * and nothing else: a route that is mis-wired, missing, shadowed by an earlier
 * pattern, or that throws before its handler is even entered is invisible to all
 * of them. On 2026-07-28 exactly that happened — the friend-removal routes were
 * given `wake`, a `const` declared *below* them, so every DELETE hit the temporal
 * dead zone, threw `ReferenceError`, and the catch-all turned it into a 500.
 * Unfriending was broken outright for ~40 minutes with 227 tests green.
 *
 * The invariant below is deliberately weak and therefore cheap to keep true:
 * **no route may 500 on a well-formed request.** A 401/404/400/204 is a decision;
 * a 500 is the router falling over. Nothing here asserts business behaviour —
 * that belongs in the per-module suites, which are thorough.
 */

/** Answers every query with "nothing", which is all an unauthenticated pass needs. */
class FakeD1 {
  prepare() {
    return this;
  }
  bind() {
    return this;
  }
  async first() {
    return null;
  }
  async all() {
    return { results: [] };
  }
  async run() {
    return { success: true, meta: { changes: 0 } };
  }
  async batch(stmts: unknown[]) {
    return stmts.map(() => ({ success: true, meta: { changes: 0 } }));
  }
}

class StubBucket {
  async get() {
    return null;
  }
  async put() {}
  async head() {
    return null;
  }
  async delete() {}
  async list() {
    return { objects: [], delimitedPrefixes: [], truncated: false, cursor: undefined };
  }
}

const env = () =>
  ({
    DB: new FakeD1(),
    BUCKET: new StubBucket(),
    FIREBASE_PROJECT_ID: "flickto-cf7b6",
  }) as any;

const ctx = { waitUntil: () => {} } as any;

const USER_ID = "AAAAH73X7P55T48R4CFHDED9CW";
const FRIEND_ID = "FRIENDIDAAAA";

/**
 * Every route the worker declares. Bodies are well-formed where one is read, so a
 * 400 means "rejected on merit" rather than "never parsed".
 */
const ROUTES: Array<[string, string, unknown?]> = [
  // Sessions and accounts
  ["POST", "/api/auth/session"],
  ["POST", "/api/auth/logout"],
  ["POST", "/api/account/link", { idToken: "x" }],
  ["GET", "/api/account/resolve"],
  ["POST", "/api/account/unlink"],
  // Friend graph — the family that regressed
  ["GET", "/api/friends"],
  ["POST", "/api/friends/request", { userId: USER_ID }],
  ["POST", "/api/friends/accept", { userId: USER_ID }],
  ["POST", "/api/friends/cards", { userIds: [USER_ID] }],
  ["POST", "/api/friends/link-legacy", { friendIds: [FRIEND_ID] }],
  ["DELETE", `/api/friends/${USER_ID}`],
  ["DELETE", `/api/friends/by-friend/${FRIEND_ID}`],
  ["GET", "/api/blocks"],
  ["POST", `/api/blocks/${USER_ID}`],
  ["DELETE", `/api/blocks/${USER_ID}`],
  ["POST", "/api/report", { userId: USER_ID, kind: "user" }],
  ["PUT", "/api/me/friend-id", { friendId: FRIEND_ID }],
  ["DELETE", "/api/me/account"],
  // Profiles and feed
  ["GET", "/api/me/bootstrap"],
  ["GET", "/api/me/profile"],
  ["PUT", "/api/me/profile", {}],
  ["PUT", "/api/me/stats", {}],
  ["GET", "/api/feed"],
  ["POST", "/api/sync", {}],
  // Shared lists and match — the other `wake` consumers
  ["POST", "/api/lists/share", { id: "AAAAAAAA", recipientId: USER_ID, title: "t", payload: "p" }],
  ["GET", "/api/lists/shared"],
  ["POST", "/api/lists/shared/AAAAAAAA/accept"],
  ["DELETE", "/api/lists/shared/AAAAAAAA"],
  ["GET", "/api/match"],
  ["POST", "/api/match/request", { targetId: USER_ID, sealed: "s", keyset: "k" }],
  ["POST", "/api/match/AAAAAAAA/accept", { sealed: "s" }],
  ["DELETE", "/api/match/AAAAAAAA"],
  // Comments — both read paths, plus the write pair whose bare/wildcard split is
  // the pattern trap this file exists to backstop.
  ["GET", "/api/titles/movie/603/comments"],
  ["GET", "/api/titles/show/1399/comments?season=2&episode=5"],
  ["GET", "/api/titles/movie/603/comments/friends"],
  ["POST", "/api/comments", { id: "AAAAAAAA", tmdbId: 603, mediaType: "movie", body: "hi" }],
  ["DELETE", "/api/comments/AAAAAAAA"],
  ["POST", "/api/comments/AAAAAAAA/reaction", { emoji: "🔥" }],
  ["DELETE", "/api/comments/AAAAAAAA/reaction"],
  ["POST", "/api/comments/AAAAAAAA/report", { reason: "spoiler" }],
  ["GET", "/api/giphy/trending"],
  ["GET", "/api/giphy/search?q=cat"],
  ["GET", "/api/admin/comment-reports"],
  ["POST", "/api/admin/comments/AAAAAAAA/restore"],
  // Relay + public surfaces
  ["POST", "/api/friendcode", { friendId: FRIEND_ID }],
  ["GET", "/api/friendcode/ABCDEF"],
  ["POST", "/api/social/freshness", { items: [] }],
  ["PUT", "/api/social/backup", {}],
  ["POST", "/api/opinions/batch", { items: [] }],
];

const request = (method: string, path: string, body?: unknown) =>
  new Request(`https://flickto.app${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("route wiring", () => {
  it.each(ROUTES)("%s %s reaches a handler instead of throwing", async (method, path, body) => {
    const res = await worker.fetch(request(method, path, body), env(), ctx);
    // 500 is the only failure mode this suite cares about: it means the router
    // threw before, or instead of, deciding anything.
    expect(`${method} ${path} -> ${res.status}`).not.toContain("500");
  });

  /**
   * The specific shape of the 2026-07-28 regression: an argument evaluated at the
   * route line, before the handler runs, so even an unauthenticated request blows
   * up. Kept separate because it is the case a reviewer should recognise.
   */
  it("session-authed routes answer 401, not 500, when unauthenticated", async () => {
    const authed: Array<[string, string]> = [
      ["GET", "/api/friends"],
      ["DELETE", `/api/friends/${USER_ID}`],
      ["DELETE", `/api/friends/by-friend/${FRIEND_ID}`],
      ["POST", "/api/friends/cards"],
      ["GET", "/api/lists/shared"],
      ["GET", "/api/match"],
      ["POST", "/api/sync"],
      // The comment write paths. The PUBLIC comment list is deliberately absent:
      // it answers 200 unauthenticated, which is the whole point of it.
      ["GET", "/api/titles/movie/603/comments/friends"],
      ["POST", "/api/comments"],
      ["DELETE", "/api/comments/AAAAAAAA"],
      ["POST", "/api/comments/AAAAAAAA/reaction"],
    ];
    for (const [method, path] of authed) {
      const res = await worker.fetch(request(method, path, method === "GET" ? undefined : {}), env(), ctx);
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 401`);
    }
  });
});
