import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleAdhocCreate,
  handleAdhocGet,
  handleAdhocMeta,
  handleAdhocPut,
  TTL_MS,
} from "./matchAdhoc";

// ── In-memory R2 fake ────────────────────────────────────────────────────────
// Only the four methods matchAdhoc.ts uses. Anything else throws, so a future call
// fails loudly rather than silently passing against a permissive stub.

class FakeR2 {
  store = new Map<string, string>();

  async get(key: string) {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return { json: async () => JSON.parse(v) };
  }
  async head(key: string) {
    return this.store.has(key) ? {} : null;
  }
  async put(key: string, body: string) {
    this.store.set(key, body);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

const env0 = () => ({ BUCKET: new FakeR2() }) as any;

const post = (body: unknown, ip = "1.2.3.4") =>
  new Request("https://flickto.app/api/match/adhoc", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "CF-Connecting-IP": ip },
  });

const put = (token: string, side: string, body: unknown) =>
  new Request(`https://flickto.app/api/match/adhoc/${token}/${side}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

async function openRendezvous(env: any, keyset = "PUB-A") {
  const res = await handleAdhocCreate(post({ publicKeyset: keyset }), env);
  return (await res.json()).token as string;
}

afterEach(() => vi.useRealTimers());

describe("opening a rendezvous", () => {
  it("mints a token and returns the expiry", async () => {
    const env = env0();
    const res = await handleAdhocCreate(post({ publicKeyset: "PUB-A" }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("serves the initiator's keyset so a scanner can seal to it", async () => {
    const env = env0();
    const token = await openRendezvous(env, "PUB-A");
    const body = await (await handleAdhocMeta(token, env)).json();
    expect(body.publicKeyset).toBe("PUB-A");
  });

  it("rejects a missing or oversized keyset", async () => {
    const env = env0();
    expect((await handleAdhocCreate(post({}), env)).status).toBe(400);
    expect(
      (await handleAdhocCreate(post({ publicKeyset: "x".repeat(5000) }), env)).status,
    ).toBe(400);
  });

  it("rate-limits token minting per IP", async () => {
    const env = { BUCKET: new FakeR2(), ADHOC_MATCH_PER_HOUR: "2" } as any;
    expect((await handleAdhocCreate(post({ publicKeyset: "K" }), env)).status).toBe(200);
    expect((await handleAdhocCreate(post({ publicKeyset: "K" }), env)).status).toBe(200);
    expect((await handleAdhocCreate(post({ publicKeyset: "K" }), env)).status).toBe(429);
    // A different IP is unaffected.
    expect(
      (await handleAdhocCreate(post({ publicKeyset: "K" }, "9.9.9.9"), env)).status,
    ).toBe(200);
  });
});

describe("the token is server-minted", () => {
  /**
   * ⚠️ The property that separates this from `PUT /api/social/backup`, whose lookup key is
   * CLIENT-chosen and which is therefore a write-anything primitive. A PUT under a token
   * this Worker never issued must not create anything.
   */
  it("refuses a PUT under a token the server never issued", async () => {
    const env = env0();
    const invented = "0123456789ABCDEFGHJKMNPQRS";
    const res = await handleAdhocPut(
      invented,
      "b",
      put(invented, "b", { sealed: "X", publicKeyset: "PUB-B" }),
      env,
    );
    expect(res.status).toBe(404);
    expect(env.BUCKET.store.size).toBe(0);
  });

  it("refuses a malformed token", async () => {
    const env = env0();
    expect((await handleAdhocMeta("not-a-token", env)).status).toBe(404);
  });
});

describe("the exchange", () => {
  it("round-trips both halves", async () => {
    const env = env0();
    const token = await openRendezvous(env);

    // The SCANNER (side b) uploads first — it has demonstrated physical presence.
    expect(
      (await handleAdhocPut(token, "b", put(token, "b", { sealed: "SEALED-B", publicKeyset: "PUB-B" }), env)).status,
    ).toBe(200);

    const bHalf = await (await handleAdhocGet(token, "b", env)).json();
    expect(bHalf).toEqual({ sealed: "SEALED-B", publicKeyset: "PUB-B" });

    expect(
      (await handleAdhocPut(token, "a", put(token, "a", { sealed: "SEALED-A", publicKeyset: "PUB-A" }), env)).status,
    ).toBe(200);
    const aHalf = await (await handleAdhocGet(token, "a", env)).json();
    expect(aHalf.sealed).toBe("SEALED-A");
  });

  /** One-shot: a leaked token is worth nothing once the exchange has happened. */
  it("a second GET of the same half 404s", async () => {
    const env = env0();
    const token = await openRendezvous(env);
    await handleAdhocPut(token, "b", put(token, "b", { sealed: "S", publicKeyset: "P" }), env);

    expect((await handleAdhocGet(token, "b", env)).status).toBe(200);
    expect((await handleAdhocGet(token, "b", env)).status).toBe(404);
  });

  it("collecting both halves destroys the whole rendezvous", async () => {
    const env = env0();
    const token = await openRendezvous(env);
    await handleAdhocPut(token, "b", put(token, "b", { sealed: "SB", publicKeyset: "PB" }), env);
    await handleAdhocPut(token, "a", put(token, "a", { sealed: "SA", publicKeyset: "PA" }), env);

    await handleAdhocGet(token, "b", env);
    await handleAdhocGet(token, "a", env);

    expect([...env.BUCKET.store.keys()].filter((k) => k.startsWith("match-adhoc/"))).toEqual([]);
    expect((await handleAdhocMeta(token, env)).status).toBe(404);
  });

  /** Overwriting would let anyone holding a live token replace a half after it was read. */
  it("a half may be written only once", async () => {
    const env = env0();
    const token = await openRendezvous(env);
    await handleAdhocPut(token, "b", put(token, "b", { sealed: "FIRST", publicKeyset: "P" }), env);
    const res = await handleAdhocPut(token, "b", put(token, "b", { sealed: "SECOND", publicKeyset: "P" }), env);
    expect(res.status).toBe(409);

    const half = await (await handleAdhocGet(token, "b", env)).json();
    expect(half.sealed).toBe("FIRST");
  });

  it("413s past the byte cap", async () => {
    const env = env0();
    const token = await openRendezvous(env);
    const res = await handleAdhocPut(
      token,
      "b",
      put(token, "b", { sealed: "x".repeat(200_000), publicKeyset: "P" }),
      env,
    );
    expect(res.status).toBe(413);
  });

  it("rejects an unknown side", async () => {
    const env = env0();
    const token = await openRendezvous(env);
    expect((await handleAdhocGet(token, "c", env)).status).toBe(404);
  });
});

describe("expiry", () => {
  /**
   * ⚠️ Enforced in the HANDLER, not left to a bucket lifecycle rule. A lifecycle rule is
   * eventually consistent and unverifiable from the code; an expired rendezvous must be
   * unreadable the instant it expires, whether or not a sweep has run.
   */
  it("an expired token 404s even though the object still exists", async () => {
    vi.useFakeTimers();
    const env = env0();
    const token = await openRendezvous(env);
    await handleAdhocPut(token, "b", put(token, "b", { sealed: "S", publicKeyset: "P" }), env);
    expect(env.BUCKET.store.size).toBeGreaterThan(0);

    vi.setSystemTime(Date.now() + TTL_MS + 1000);

    expect((await handleAdhocMeta(token, env)).status).toBe(404);
    expect((await handleAdhocGet(token, "b", env)).status).toBe(404);
    expect((await handleAdhocPut(token, "a", put(token, "a", { sealed: "S", publicKeyset: "P" }), env)).status).toBe(404);
  });

  it("reading an expired token cleans it up", async () => {
    vi.useFakeTimers();
    const env = env0();
    const token = await openRendezvous(env);
    await handleAdhocPut(token, "b", put(token, "b", { sealed: "S", publicKeyset: "P" }), env);

    vi.setSystemTime(Date.now() + TTL_MS + 1000);
    await handleAdhocMeta(token, env);

    expect([...env.BUCKET.store.keys()].filter((k) => k.startsWith("match-adhoc/"))).toEqual([]);
  });
});
