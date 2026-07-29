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
  ["PUT", "/api/me/push", { selfTopic: "s_abc", friendTopic: "f_abc" }],
  // Account-keyed profile picture. The PUT/DELETE are session-authed under /api/me/;
  // the GET is public, which is why it is absent from the 401 list below.
  ["DELETE", "/api/me/picture"],
  ["GET", `/api/profile/${USER_ID}/picture`],
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
  // Episode poll. The GET is edge-cached and unauthenticated; the PUT is session-authed.
  ["GET", "/api/titles/show/1399/poll?season=2&episode=5"],
  ["PUT", "/api/titles/show/1399/vote?season=2&episode=5", { rating: 8, emotions: ["SAD"] }],
  ["POST", "/api/comments", { id: "AAAAAAAA", tmdbId: 603, mediaType: "movie", body: "hi" }],
  ["DELETE", "/api/comments/AAAAAAAA"],
  ["POST", "/api/comments/AAAAAAAA/reaction", { emoji: "🔥" }],
  ["DELETE", "/api/comments/AAAAAAAA/reaction"],
  ["POST", "/api/comments/AAAAAAAA/report", { reason: "spoiler" }],
  ["GET", "/api/giphy/trending"],
  ["GET", "/api/giphy/search?q=cat"],
  ["GET", "/api/moderation/comment-reports"],
  ["POST", "/api/moderation/comments/AAAAAAAA/restore"],
  ["GET", "/api/moderation/reports?state=open"],
  ["POST", "/api/moderation/act", { itemId: "AAAAAAAA:user", source: "d1", action: "dismiss" }],
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
      ["PUT", "/api/titles/show/1399/vote?season=2&episode=5"],
      ["POST", "/api/comments"],
      ["DELETE", "/api/comments/AAAAAAAA"],
      ["POST", "/api/comments/AAAAAAAA/reaction"],
      // The relay `PUT /api/user/{friendId}/push` it replaces answered 403 on a bad
      // owner secret; this one must answer 401 on a missing session, which is the
      // whole point of the move.
      ["PUT", "/api/me/push"],
      // The relay picture PUT answered 403 on a bad owner secret; these must answer
      // 401 on a missing session, which is the whole point of the move.
      ["PUT", "/api/me/picture"],
      ["DELETE", "/api/me/picture"],
    ];
    for (const [method, path] of authed) {
      const res = await worker.fetch(request(method, path, method === "GET" ? undefined : {}), env(), ctx);
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 401`);
    }
  });

  /**
   * The unified queue replaced two stopgap endpoints, and both halves of that swap are
   * invisible to `wrangler deploy --dry-run`: a new path that never got routed and an
   * old path still answering look exactly like success from there.
   *
   * 403 is the target, not 404 — it means the route matched, the handler ran, and the
   * admin key was rejected. 404 would mean the router has no handler at all.
   */
  it("routes the unified moderation queue behind the admin key", async () => {
    const listed = await worker.fetch(request("GET", "/api/moderation/reports?state=open"), env(), ctx);
    expect(listed.status).toBe(403);

    const acted = await worker.fetch(request("POST", "/api/moderation/act", {}), env(), ctx);
    expect(acted.status).toBe(403);
  });

  it("no longer serves the stopgap person-report endpoints", async () => {
    const listed = await worker.fetch(request("GET", "/api/moderation/user-reports"), env(), ctx);
    expect(listed.status).toBe(404);

    const acted = await worker.fetch(
      request("POST", `/api/moderation/users/${USER_ID}/hide-picture`, {}),
      env(),
      ctx,
    );
    expect(acted.status).toBe(404);
  });
});
