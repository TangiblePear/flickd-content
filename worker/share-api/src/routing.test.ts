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
/** 32 lowercase hex, matching `STICKER_ID` in stickers.ts. */
const STICKER_ID = "0123456789abcdef0123456789abcdef";

/**
 * Every route the worker declares. Bodies are well-formed where one is read, so a
 * 400 means "rejected on merit" rather than "never parsed".
 */
const ROUTES: Array<[string, string, unknown?]> = [
  // Sessions and accounts
  ["POST", "/api/auth/session"],
  ["POST", "/api/auth/logout"],
  ["POST", "/api/auth/probe"],
  ["POST", "/api/account/link", { idToken: "x" }],
  ["GET", "/api/account/resolve"],
  ["POST", "/api/account/unlink"],
  // Friend graph — the family that regressed
  ["GET", "/api/friends"],
  ["POST", "/api/friends/request", { userId: USER_ID }],
  ["POST", "/api/friends/accept", { userId: USER_ID }],
  ["POST", "/api/friends/cards", { userIds: [USER_ID] }],
  ["DELETE", `/api/friends/${USER_ID}`],
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
  // Sticker cut-outs. Same split as the picture above: the two writes are session-authed
  // under /api/me/, the read is public and so absent from the 401 list below.
  ["POST", "/api/me/stickers"],
  ["DELETE", `/api/me/stickers/${STICKER_ID}`],
  ["GET", `/api/stickers/${STICKER_ID}`],
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
  // The caller's own episode ratings. Sits under `/api/me/` rather than the subject
  // shape above because it is keyed on the reader, not on an episode — and so it is
  // authenticated and uncacheable where the poll read is neither.
  ["GET", "/api/me/episode-ratings"],
  ["GET", "/api/me/episode-ratings?limit=20"],
  ["POST", "/api/comments", { id: "AAAAAAAA", tmdbId: 603, mediaType: "movie", body: "hi" }],
  ["DELETE", "/api/comments/AAAAAAAA"],
  ["POST", "/api/comments/AAAAAAAA/reaction", { emoji: "🔥" }],
  ["DELETE", "/api/comments/AAAAAAAA/reaction"],
  ["POST", "/api/comments/AAAAAAAA/report", { reason: "spoiler" }],
  // Watch history. The bare `/api/history` and the two fixed subpaths are three
  // separate router entries, and the DELETE regex is matched AFTER them — it would
  // otherwise swallow `/api/history/sync` and `/api/history/stats` whole.
  ["POST", "/api/history/sync", { events: [], ratings: [], lastSyncTimestamp: 0, deviceId: "dev-1" }],
  ["GET", "/api/history"],
  ["GET", "/api/history?limit=50&type=MOVIE"],
  ["GET", "/api/history/stats"],
  ["POST", "/api/history/confirm-push", { pushId: "p1", succeeded: true }],
  ["GET", "/api/history/integrations"],
  ["PUT", "/api/history/integrations", { target: "TRAKT", connected: true }],
  ["DELETE", "/api/history/watch-EPISODE-1396-s2e5-1753027200"],
  // Public and unauthenticated by design, which is why it is absent from the 401
  // list below — it answers 503 without the Analytics Engine credential.
  ["GET", "/api/stats/global"],
  ["GET", "/api/giphy/trending"],
  ["GET", "/api/giphy/search?q=cat"],
  // In-app feedback. The POST deliberately takes an OPTIONAL session, so unlike every
  // other write here it must NOT answer 401 — see the exemption list below.
  ["POST", "/api/feedback", { topic: "bug", message: "hi" }],
  ["GET", "/api/feedback/admin"],
  ["POST", "/api/feedback/admin/act", { id: "AAAAAAAA", state: "closed" }],
  ["GET", "/api/moderation/comment-reports"],
  ["POST", "/api/moderation/comments/AAAAAAAA/restore"],
  ["GET", "/api/moderation/reports?state=open"],
  ["POST", "/api/moderation/act", { itemId: "AAAAAAAA:user", source: "d1", action: "dismiss" }],
  // Relay + public surfaces
  ["POST", "/api/friendcode", { friendId: FRIEND_ID }],
  ["GET", "/api/friendcode/ABCDEF"],
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
      ["POST", "/api/friends/cards"],
      ["GET", "/api/lists/shared"],
      ["GET", "/api/match"],
      ["POST", "/api/sync"],
      // The comment write paths. The PUBLIC comment list is deliberately absent:
      // it answers 200 unauthenticated, which is the whole point of it.
      ["GET", "/api/titles/movie/603/comments/friends"],
      ["PUT", "/api/titles/show/1399/vote?season=2&episode=5"],
      // The per-reader half of the poll: unlike the aggregate GET above it is the
      // caller's own data, so it must refuse rather than answer for nobody.
      ["GET", "/api/me/episode-ratings"],
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
      // Sticker writes. The public GET /api/stickers/{userId}/{id} is deliberately
      // absent — it answers unauthenticated by design, and asserting 401 on it would
      // pin the opposite of the intended behaviour.
      ["POST", "/api/me/stickers"],
      ["DELETE", `/api/me/stickers/${STICKER_ID}`],
      // Watch history. `GET /api/stats/global` is deliberately absent — it is public,
      // and asserting 401 on it would pin the opposite of the intended behaviour.
      ["POST", "/api/history/sync"],
      ["GET", "/api/history"],
      ["GET", "/api/history/stats"],
      ["POST", "/api/history/confirm-push"],
      ["GET", "/api/history/integrations"],
      ["PUT", "/api/history/integrations"],
      ["DELETE", "/api/history/watch-MOVIE-550-1753027200"],
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

  /**
   * Feedback is the one write path that must work signed OUT — someone who cannot get
   * past sign-in is exactly who needs to be able to tell us so. A 401 here would mean
   * the endpoint had quietly been given the session guard every other write has.
   *
   * Its admin half must NOT be reachable that way: 401 there is the target.
   */
  it("accepts anonymous feedback but gates the admin half", async () => {
    const submitted = await worker.fetch(
      request("POST", "/api/feedback", { topic: "bug", message: "hi" }),
      env(),
      ctx,
    );
    expect(submitted.status).toBe(200);

    const listed = await worker.fetch(request("GET", "/api/feedback/admin"), env(), ctx);
    expect(listed.status).toBe(401);

    const acted = await worker.fetch(request("POST", "/api/feedback/admin/act", { id: "x" }), env(), ctx);
    expect(acted.status).toBe(401);
  });

  /**
   * Step 7 retired the E2EE relay profile. These must 404, and the ONE that must not is
   * `push` — it shares the `/api/user/*` pattern, so a matcher edit that took it out with
   * the others would silently stop every directed notification with nothing failing.
   */
  it("no longer serves the relay profile, access bundle or freshness scan", async () => {
    const gone: Array<[string, string]> = [
      ["PUT", `/api/user/${FRIEND_ID}/profile`],
      ["GET", `/api/user/${FRIEND_ID}/profile`],
      ["PUT", `/api/user/${FRIEND_ID}/access`],
      ["GET", `/api/user/${FRIEND_ID}/access`],
      ["POST", "/api/social/freshness"],
    ];
    for (const [method, path] of gone) {
      const res = await worker.fetch(request(method, path, method === "GET" ? undefined : {}), env(), ctx);
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 404`);
    }
  });

  it("no longer routes PUT push — the relay dual-write is retired (9a)", async () => {
    const res = await worker.fetch(request("PUT", `/api/user/${FRIEND_ID}/push`, { selfTopic: "t_a" }), env(), ctx);
    // Was 403 (matcher ran, owner auth rejected). Now 404: the whole
    // `/api/user/{friendId}/(fcm-token|push)` matcher is gone and topics live on
    // `users`. An account with no topics is unreachable by directed push rather than
    // falling back to the relay record — the accepted, measured price.
    expect(res.status).toBe(404);
  });

  it("still serves GET picture — one live account's picture_url points at it", async () => {
    // PUT/DELETE went with the client that called them, but this READ is load-bearing
    // until 8adbcbb5 heals the last stale `profiles.picture_url`.
    //
    // ⚠️ Asserting `not 404` would be worthless: an unmatched route and a missing
    // object BOTH return 404, so that assertion passes whether or not the route
    // exists. Serve an object and require 200 — only a wired route can produce it.
    const e = env();
    e.BUCKET = {
      async get(key: string) {
        if (key.endsWith("/pics/picture.jpg")) {
          return { body: "bytes", httpMetadata: { contentType: "image/jpeg" } };
        }
        return null; // no tombstone
      },
      async put() {},
      async head() {
        return null;
      },
      async delete() {},
      async list() {
        return { objects: [], delimitedPrefixes: [], truncated: false, cursor: undefined };
      },
    };
    const res = await worker.fetch(request("GET", `/api/user/${FRIEND_ID}/picture`), e, ctx);
    expect(res.status).toBe(200);
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
