// Comment abuse controls: burst limiters, strike escalation, suspension reach,
// and the staged App Check rollout.
//
// Deliberately on the REAL-SQLite harness rather than comments.test.ts's hand-rolled
// double. Everything asserted here IS the SQL — a windowed COUNT, a MAX() that must
// not shorten an admin's suspension, an opportunistic prune — and a string-matching
// double would happily pass all of it while the statements were wrong.

import { describe, it, expect, vi, afterEach } from "vitest";
import { handleDeleteComment, handlePostComment, handleReactToComment, handleReportComment } from "./comments";
import { evaluateAppCheck } from "./appcheck";
import { TestD1, seedSession, seedUser, testEnv, uid } from "./testD1";

const A = uid(1);
const B = uid(2);

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let s = "";
  for (const b of new Uint8Array(digest)) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Seeds a user plus a live session and returns the bearer token for it. */
async function seedAuthed(db: TestD1, id: string, postingSuspendedUntil: number | null = null): Promise<string> {
  seedUser(db, { id, postingSuspendedUntil });
  const token = `tok-${id}`;
  seedSession(db, id, await sha256Hex(token));
  return token;
}

const authed = (token: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  ...extra,
});

const postReq = (token: string, body: unknown, extra: Record<string, string> = {}) =>
  new Request("https://flickto.app/api/comments", {
    method: "POST",
    headers: authed(token, extra),
    body: JSON.stringify(body),
  });

/**
 * COMMENT_ID_RE is `[0-9A-Z:]` — no hyphens, so the `-1` sentinels a movie subject
 * uses for season/episode cannot appear in the id. The id only has to be stable and
 * caller-minted; the subject travels in its own fields.
 */
const commentId = (author: string) => `${author}:MOVIE:603`;

const commentBody = (author: string, body = "hello") => ({
  id: commentId(author),
  tmdbId: 603,
  mediaType: "movie",
  season: -1,
  episode: -1,
  body,
  // Public so a non-friend can read it — `mayReadComment` would otherwise 404 the
  // reaction and report paths before the assertion under test is reached.
  visibility: "public",
});

/** A limiter binding that refuses after [allow] calls, and counts the keys it saw. */
function limiter(allow: number) {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: keys.length <= allow };
      },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("comment write burst limiter", () => {
  it("refuses an EDIT, which the hourly cap never charges for", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    // First write lands, second is refused — the point being that the second is an
    // edit of the same subject, which `rateLimited` deliberately lets through.
    const env = testEnv(db, { COMMENT_USER_LIMITER: limiter(1).binding });

    const first = await handlePostComment(postReq(token, commentBody(A, "v1")), env);
    expect(first.status).toBe(200);

    const second = await handlePostComment(postReq(token, commentBody(A, "v2")), env);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });

    // The edit must NOT have landed.
    expect(db.one<{ body: string }>("SELECT body FROM comments WHERE author_id = ?", A)?.body).toBe("v1");
  });

  it("sends Retry-After so a blind outbox can park instead of spinning", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, { COMMENT_USER_LIMITER: limiter(0).binding });

    const res = await handlePostComment(postReq(token, commentBody(A)), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("trips on the IP key even when two different accounts are used", async () => {
    const db = new TestD1();
    const tokenA = await seedAuthed(db, A);
    const tokenB = await seedAuthed(db, B);
    const ip = limiter(1);
    // Per-user limiter left generous, so only the shared IP key can refuse this.
    const env = testEnv(db, { COMMENT_USER_LIMITER: limiter(99).binding, COMMENT_IP_LIMITER: ip.binding });
    const headers = { "CF-Connecting-IP": "203.0.113.9" };

    const one = await handlePostComment(postReq(tokenA, commentBody(A), headers), env);
    expect(one.status).toBe(200);

    const two = await handlePostComment(postReq(tokenB, commentBody(B), headers), env);
    expect(two.status).toBe(429);
    expect(ip.keys).toEqual(["ci:203.0.113.9", "ci:203.0.113.9"]);
  });

  it("degrades to no limit when the bindings are absent", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db);

    for (const v of ["v1", "v2", "v3"]) {
      expect((await handlePostComment(postReq(token, commentBody(A, v)), env)).status).toBe(200);
    }
    expect(db.one<{ body: string }>("SELECT body FROM comments WHERE author_id = ?", A)?.body).toBe("v3");
  });

  it("also covers DELETE, so delete-then-repost is not a free write loop", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, { COMMENT_USER_LIMITER: limiter(1).binding });

    expect((await handlePostComment(postReq(token, commentBody(A)), env)).status).toBe(200);

    const del = await handleDeleteComment(
      commentId(A),
      new Request("https://flickto.app/api/comments/x", { method: "DELETE", headers: authed(token) }),
      env,
    );
    expect(del.status).toBe(429);
  });
});

describe("strike escalation", () => {
  it("suspends posting once strikes cross the threshold", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, { COMMENT_USER_LIMITER: limiter(0).binding, STRIKES_TO_SUSPEND: "3" });

    for (let i = 0; i < 2; i++) {
      expect((await handlePostComment(postReq(token, commentBody(A)), env)).status).toBe(429);
    }
    // Two strikes is not yet a suspension.
    expect(db.one<{ u: number | null }>("SELECT posting_suspended_until AS u FROM users WHERE id = ?", A)?.u).toBeFalsy();

    expect((await handlePostComment(postReq(token, commentBody(A)), env)).status).toBe(429);

    const until = db.one<{ u: number | null }>("SELECT posting_suspended_until AS u FROM users WHERE id = ?", A)?.u;
    expect(until).toBeGreaterThan(Date.now());
    expect(db.count("rate_limit_strikes", "user_id = ?", A)).toBe(3);
  });

  it("records the automatic suspension in the admin audit trail", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, { COMMENT_USER_LIMITER: limiter(0).binding, STRIKES_TO_SUSPEND: "1" });

    await handlePostComment(postReq(token, commentBody(A)), env);

    const row = db.one<{ actor: string; action: string; target_id: string }>(
      "SELECT actor, action, target_id FROM admin_actions WHERE target_id = ?",
      A,
    );
    expect(row).toMatchObject({ actor: "system", action: "auto_posting_suspend", target_id: A });
  });

  it("never shortens a longer suspension an admin already set", async () => {
    const db = new TestD1();
    const far = Date.now() + 30 * 86_400_000;
    const token = await seedAuthed(db, A, far);
    const env = testEnv(db, { COMMENT_USER_LIMITER: limiter(0).binding, STRIKES_TO_SUSPEND: "1" });

    // Suspended users are refused before the limiter, so drive the strike through
    // the limiter directly on DELETE, which has no suspension gate.
    await handleDeleteComment(
      commentId(A),
      new Request("https://flickto.app/api/comments/x", { method: "DELETE", headers: authed(token) }),
      env,
    );

    expect(db.one<{ u: number }>("SELECT posting_suspended_until AS u FROM users WHERE id = ?", A)?.u).toBe(far);
  });

  it("STRIKES_TO_SUSPEND=0 records strikes but never suspends", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, { COMMENT_USER_LIMITER: limiter(0).binding, STRIKES_TO_SUSPEND: "0" });

    for (let i = 0; i < 5; i++) await handlePostComment(postReq(token, commentBody(A)), env);

    expect(db.one<{ u: number | null }>("SELECT posting_suspended_until AS u FROM users WHERE id = ?", A)?.u).toBeFalsy();
    expect(db.count("rate_limit_strikes", "user_id = ?", A)).toBe(5);
  });
});

describe("suspension reach", () => {
  it("refuses a reaction from a suspended user", async () => {
    const db = new TestD1();
    const author = await seedAuthed(db, B);
    const env = testEnv(db);
    await handlePostComment(postReq(author, commentBody(B)), env);

    const reactor = await seedAuthed(db, A, Date.now() + 86_400_000);
    const res = await handleReactToComment(
      commentId(B),
      new Request("https://flickto.app/r", { method: "POST", headers: authed(reactor), body: JSON.stringify({ emoji: "👍" }) }),
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "posting_suspended" });
    expect(db.count("comment_reactions")).toBe(0);
  });

  it("still lets a suspended user REMOVE a reaction", async () => {
    const db = new TestD1();
    const author = await seedAuthed(db, B);
    const env = testEnv(db);
    await handlePostComment(postReq(author, commentBody(B)), env);

    const reactor = await seedAuthed(db, A);
    const target = commentId(B);
    await handleReactToComment(
      target,
      new Request("https://flickto.app/r", { method: "POST", headers: authed(reactor), body: JSON.stringify({ emoji: "👍" }) }),
      env,
    );
    expect(db.count("comment_reactions")).toBe(1);

    db.prepare("UPDATE users SET posting_suspended_until = ? WHERE id = ?").bind(Date.now() + 86_400_000, A).run();

    const res = await handleReactToComment(
      target,
      new Request("https://flickto.app/r", { method: "DELETE", headers: authed(reactor) }),
      env,
    );
    expect(res.status).toBe(204);
    expect(db.count("comment_reactions")).toBe(0);
  });

  it("refuses a REPORT from a suspended user, so suspension is not a censorship promotion", async () => {
    const db = new TestD1();
    const author = await seedAuthed(db, B);
    const env = testEnv(db);
    await handlePostComment(postReq(author, commentBody(B)), env);

    const reporter = await seedAuthed(db, A, Date.now() + 86_400_000);
    const res = await handleReportComment(
      commentId(B),
      new Request("https://flickto.app/rep", {
        method: "POST",
        headers: authed(reporter),
        body: JSON.stringify({ reason: "abuse" }),
      }),
      env,
    );

    expect(res.status).toBe(403);
    expect(db.count("reports")).toBe(0);
  });
});

describe("App Check staged rollout", () => {
  const req = (headers: Record<string, string> = {}) => new Request("https://flickto.app/api/comments", { headers });

  it("is skipped entirely when the mode is off", async () => {
    const res = await evaluateAppCheck(req(), { APPCHECK_MODE: "off", FIREBASE_PROJECT_NUMBER: "1" }, 100);
    expect(res).toEqual({ outcome: "skipped", enforced: false });
  });

  it("log mode reports a missing token but never enforces", async () => {
    const res = await evaluateAppCheck(req(), { APPCHECK_MODE: "log", FIREBASE_PROJECT_NUMBER: "1" }, 100);
    expect(res).toEqual({ outcome: "absent", enforced: false });
  });

  it("enforce mode rejects a missing token", async () => {
    const res = await evaluateAppCheck(req(), { APPCHECK_MODE: "enforce", FIREBASE_PROJECT_NUMBER: "1" }, 100);
    expect(res).toEqual({ outcome: "absent", enforced: true });
  });

  it("enforce mode rejects a junk token rather than treating it as absent", async () => {
    const res = await evaluateAppCheck(
      req({ "X-Firebase-AppCheck": "not.a.jwt" }),
      { APPCHECK_MODE: "enforce", FIREBASE_PROJECT_NUMBER: "1" },
      100,
    );
    expect(res).toEqual({ outcome: "fail", enforced: true });
  });

  it("exempts a build older than APPCHECK_MIN_VERSION, so enforcing locks nobody out", async () => {
    const env = { APPCHECK_MODE: "enforce", APPCHECK_MIN_VERSION: "500", FIREBASE_PROJECT_NUMBER: "1" };
    expect(await evaluateAppCheck(req(), env, 499)).toEqual({ outcome: "skipped", enforced: false });
    // 0 means "no version header at all" (the PWA, pre-gate builds) and must also be exempt.
    expect(await evaluateAppCheck(req(), env, 0)).toEqual({ outcome: "skipped", enforced: false });
    expect(await evaluateAppCheck(req(), env, 500)).toEqual({ outcome: "absent", enforced: true });
  });

  it("a comment write is refused under enforce and allowed under log", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);

    const enforced = await handlePostComment(
      postReq(token, commentBody(A)),
      testEnv(db, { APPCHECK_MODE: "enforce", FIREBASE_PROJECT_NUMBER: "1" }),
    );
    expect(enforced.status).toBe(403);
    expect(await enforced.json()).toEqual({ error: "app_check_required" });
    expect(db.count("comments")).toBe(0);

    const logged = await handlePostComment(
      postReq(token, commentBody(A)),
      testEnv(db, { APPCHECK_MODE: "log", FIREBASE_PROJECT_NUMBER: "1" }),
    );
    expect(logged.status).toBe(200);
    expect(db.count("comments")).toBe(1);
  });
});
