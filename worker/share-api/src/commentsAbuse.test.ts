// Comment abuse controls: burst limits, strike escalation, suspension reach,
// and the staged App Check rollout.
//
// Deliberately on the REAL-SQLite harness rather than comments.test.ts's hand-rolled
// double. Everything asserted here IS the SQL — windowed COUNTs, a MAX() that must not
// shorten an admin's suspension, an opportunistic prune — and a string-matching double
// would happily pass all of it while the statements were wrong.
//
// ⚠️ The first version of this file stubbed a Cloudflare `unsafe.bindings` ratelimit
// binding and passed, while that binding silently did nothing in production (eight
// writes in 27s all accepted against a limit of 5/60s). A double that cannot fail the
// way production failed is not a test. The limiter is now D1 rows, and these tests
// count the same rows the handler does.

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

/**
 * Puts [n] prior writes on the clock for [userId], so the very next write is over the
 * cap. Seeding the ledger beats driving real writes: the assertion is about the window
 * arithmetic, and a test that has to post four comments first hides which one refused.
 */
function seedWrites(db: TestD1, userId: string, n: number, at = Date.now()): void {
  for (let i = 0; i < n; i++) {
    db.prepare("INSERT INTO comment_write_events (id, user_id, ip_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(`seed-${userId}-${at}-${i}`, userId, null, at)
      .run();
  }
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

const caps = (perUser: number, perIp = 0) => ({
  COMMENT_WRITES_PER_MINUTE: String(perUser),
  COMMENT_WRITES_PER_MINUTE_IP: String(perIp),
});

afterEach(() => vi.restoreAllMocks());

describe("comment write burst limit", () => {
  it("refuses an EDIT, which the hourly cap never charges for", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, caps(1));

    const first = await handlePostComment(postReq(token, commentBody(A, "v1")), env);
    expect(first.status).toBe(200);

    // The second write is an EDIT of the same subject — exactly what `rateLimited`
    // lets through for free, and the hole this limit exists to close.
    const second = await handlePostComment(postReq(token, commentBody(A, "v2")), env);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });
    expect(second.headers.get("Retry-After")).toBe("60");

    expect(db.one<{ body: string }>("SELECT body FROM comments WHERE author_id = ?", A)?.body).toBe("v1");
  });

  it("only counts writes inside the window", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, caps(1));

    // At the cap, but 61s ago — outside the 60s window, so it must not refuse.
    seedWrites(db, A, 5, Date.now() - 61_000);

    expect((await handlePostComment(postReq(token, commentBody(A)), env)).status).toBe(200);
  });

  it("trips on the IP counter even across two different accounts", async () => {
    const db = new TestD1();
    const tokenA = await seedAuthed(db, A);
    const tokenB = await seedAuthed(db, B);
    // Per-user cap left generous, so only the shared IP can refuse this.
    const env = testEnv(db, caps(99, 1));
    const headers = { "CF-Connecting-IP": "203.0.113.9" };

    expect((await handlePostComment(postReq(tokenA, commentBody(A), headers), env)).status).toBe(200);

    const two = await handlePostComment(postReq(tokenB, commentBody(B), headers), env);
    expect(two.status).toBe(429);
    expect(db.count("comments")).toBe(1);
  });

  it("stores the IP hashed, never the address", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, caps(5, 5));

    await handlePostComment(postReq(token, commentBody(A), { "CF-Connecting-IP": "203.0.113.9" }), env);

    const row = db.one<{ ip_hash: string }>("SELECT ip_hash FROM comment_write_events LIMIT 1");
    expect(row?.ip_hash).toBe(await sha256Hex("203.0.113.9"));
    expect(row?.ip_hash).not.toContain("203.0.113.9");
  });

  it("lets a normal edit burst through on the shipped defaults", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db); // no caps configured → defaults (5/min user)

    for (const v of ["v1", "v2", "v3"]) {
      expect((await handlePostComment(postReq(token, commentBody(A, v)), env)).status).toBe(200);
    }
    expect(db.one<{ body: string }>("SELECT body FROM comments WHERE author_id = ?", A)?.body).toBe("v3");
  });

  it('"0" disables the limit entirely', async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, caps(0, 0));

    seedWrites(db, A, 50);

    expect((await handlePostComment(postReq(token, commentBody(A)), env)).status).toBe(200);
  });

  it("also covers DELETE, so delete-then-repost is not a free write loop", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, caps(1));

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
  /**
   * One refused write at [at], with the ledger pre-loaded so it is over the cap.
   * Steps are >1 debounce apart so each refusal actually counts as a strike.
   */
  async function refusedAt(db: TestD1, token: string, env: unknown, at: number): Promise<void> {
    vi.spyOn(Date, "now").mockReturnValue(at);
    seedWrites(db, A, 2, at);
    const res = await handlePostComment(postReq(token, commentBody(A)), env as never);
    expect(res.status).toBe(429);
  }

  it("suspends posting once strikes cross the threshold", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, { ...caps(1), STRIKES_TO_SUSPEND: "3" });
    const t0 = Date.now();

    await refusedAt(db, token, env, t0);
    await refusedAt(db, token, env, t0 + 61_000);
    expect(db.one<{ u: number | null }>("SELECT posting_suspended_until AS u FROM users WHERE id = ?", A)?.u).toBeFalsy();

    await refusedAt(db, token, env, t0 + 122_000);

    expect(db.count("rate_limit_strikes", "user_id = ?", A)).toBe(3);
    expect(
      db.one<{ u: number | null }>("SELECT posting_suspended_until AS u FROM users WHERE id = ?", A)?.u,
    ).toBeGreaterThan(t0);
  });

  it("counts a blind retry loop ONCE, so a fast thumb cannot earn a suspension", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, { ...caps(1), STRIKES_TO_SUSPEND: "3" });
    seedWrites(db, A, 2);

    // The shape syncOutbox actually produces: the row stays dirty and every user
    // action kicks another sweep, all within the same second.
    for (let i = 0; i < 12; i++) {
      expect((await handlePostComment(postReq(token, commentBody(A)), env)).status).toBe(429);
    }

    expect(db.count("rate_limit_strikes", "user_id = ?", A)).toBe(1);
    expect(db.one<{ u: number | null }>("SELECT posting_suspended_until AS u FROM users WHERE id = ?", A)?.u).toBeFalsy();
  });

  it("records the automatic suspension in the admin audit trail", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, { ...caps(1), STRIKES_TO_SUSPEND: "1" });
    seedWrites(db, A, 2);

    await handlePostComment(postReq(token, commentBody(A)), env);

    expect(
      db.one<{ actor: string; action: string; target_id: string }>(
        "SELECT actor, action, target_id FROM admin_actions WHERE target_id = ?",
        A,
      ),
    ).toMatchObject({ actor: "system", action: "auto_posting_suspend", target_id: A });
  });

  it("never shortens a longer suspension an admin already set", async () => {
    const db = new TestD1();
    const far = Date.now() + 30 * 86_400_000;
    const token = await seedAuthed(db, A, far);
    const env = testEnv(db, { ...caps(1), STRIKES_TO_SUSPEND: "1" });
    seedWrites(db, A, 2);

    // The burst limit is checked before the suspension gate, so a suspended user can
    // still trip it — which is the only way to drive a strike onto an already-suspended
    // account.
    expect((await handlePostComment(postReq(token, commentBody(A)), env)).status).toBe(429);

    expect(db.one<{ u: number }>("SELECT posting_suspended_until AS u FROM users WHERE id = ?", A)?.u).toBe(far);
  });

  it("STRIKES_TO_SUSPEND=0 records strikes but never suspends", async () => {
    const db = new TestD1();
    const token = await seedAuthed(db, A);
    const env = testEnv(db, { ...caps(1), STRIKES_TO_SUSPEND: "0" });
    const t0 = Date.now();

    for (let i = 0; i < 5; i++) await refusedAt(db, token, env, t0 + i * 61_000);

    expect(db.count("rate_limit_strikes", "user_id = ?", A)).toBe(5);
    expect(db.one<{ u: number | null }>("SELECT posting_suspended_until AS u FROM users WHERE id = ?", A)?.u).toBeFalsy();
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
      new Request("https://flickto.app/r", {
        method: "POST",
        headers: authed(reactor),
        body: JSON.stringify({ emoji: "👍" }),
      }),
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
      new Request("https://flickto.app/r", {
        method: "POST",
        headers: authed(reactor),
        body: JSON.stringify({ emoji: "👍" }),
      }),
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
