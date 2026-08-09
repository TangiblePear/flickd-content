import { describe, expect, it, vi, afterEach, beforeAll } from "vitest";
import { handleVerifyPremiere, isPremiere, visiblePictureUrl } from "./premiere";

const USER = "AAAAH73X7P55T48R4CFHDED9CW";

/**
 * A REAL PKCS#8 key, generated once for the suite.
 *
 * A placeholder string will not do: `getGoogleAccessToken` runs `importKey` on this,
 * so a fake PEM throws and every success path collapses into the same 502 the
 * failure tests assert — the suite would go green on the failure cases while proving
 * nothing about the happy one.
 */
let PEM = "";
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...pkcs8));
  PEM = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
});

/**
 * Minimal D1 double. Only two statements ever reach it: the session lookup and the
 * one UPDATE this module performs. `writes` is the assertion surface — several tests
 * below are about NOT writing.
 */
function fakeDb() {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  return {
    writes,
    prepare(sql: string) {
      const stmt: any = {
        args: [] as unknown[],
        bind(...a: unknown[]) {
          stmt.args = a;
          return stmt;
        },
        async first<T>() {
          if (sql.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
            return { user_id: USER, expires_at: Date.now() + 8.64e7, revoked_at: null } as T;
          }
          throw new Error(`unhandled first(): ${sql}`);
        },
        async run() {
          writes.push({ sql, args: stmt.args });
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: fakeDb(),
    PLAY_SA_CLIENT_EMAIL: "sa@example.iam.gserviceaccount.com",
    PLAY_SA_PRIVATE_KEY: PEM,
    PLAY_PACKAGE_NAME: "com.flickto.app",
    ...overrides,
  } as any;
}

const post = (body: unknown) =>
  new Request("https://flickto.app/api/me/premiere/verify", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Stub the two upstream calls: the OAuth token exchange, then the Play lookup. */
function stubFetch(playResponse: Response | Error, tokenOk = true) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return tokenOk
        ? new Response(JSON.stringify({ access_token: "at" }), { status: 200 })
        : new Response("nope", { status: 500 });
    }
    if (playResponse instanceof Error) throw playResponse;
    return playResponse;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("isPremiere", () => {
  const now = 1_000_000;

  it("is false for a never-subscribed row, a missing row, and an absent column", () => {
    expect(isPremiere({ premiere_until: 0 }, now)).toBe(false);
    expect(isPremiere(null, now)).toBe(false);
    // The LEFT JOIN case: an orphaned profile whose `users` parent is gone.
    expect(isPremiere({}, now)).toBe(false);
  });

  it("expires itself rather than needing a cron", () => {
    expect(isPremiere({ premiere_until: now + 1 }, now)).toBe(true);
    expect(isPremiere({ premiere_until: now }, now)).toBe(false);
    expect(isPremiere({ premiere_until: now - 1 }, now)).toBe(false);
  });
});

describe("POST /api/me/premiere/verify", () => {
  it("503s and writes nothing when the service account is not configured", async () => {
    const e = env({ PLAY_SA_PRIVATE_KEY: undefined });
    const res = await handleVerifyPremiere(post({ purchaseToken: "t" }), e);
    expect(res.status).toBe(503);
    expect(e.DB.writes).toHaveLength(0);
  });

  it("rejects a missing or absurd token before calling Google", async () => {
    const spy = stubFetch(new Response("{}", { status: 200 }));
    const e = env();
    expect((await handleVerifyPremiere(post({}), e)).status).toBe(400);
    expect((await handleVerifyPremiere(post({ purchaseToken: "x".repeat(4097) }), e)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    expect(e.DB.writes).toHaveLength(0);
  });

  it("stores the expiry Google reports for an active subscription", async () => {
    const expiry = Date.now() + 30 * 86_400_000;
    stubFetch(
      new Response(
        JSON.stringify({
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          lineItems: [{ expiryTime: new Date(expiry).toISOString() }],
        }),
        { status: 200 },
      ),
    );
    const e = env();
    const res = await handleVerifyPremiere(post({ purchaseToken: "tok" }), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isPremiere: true, premiereUntil: expiry });
    expect(e.DB.writes).toHaveLength(1);
    expect(e.DB.writes[0].args[0]).toBe(expiry);
  });

  it("takes the LONGEST line item, not the first", async () => {
    const near = Date.now() + 86_400_000;
    const far = Date.now() + 60 * 86_400_000;
    stubFetch(
      new Response(
        JSON.stringify({
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          lineItems: [{ expiryTime: new Date(near).toISOString() }, { expiryTime: new Date(far).toISOString() }],
        }),
        { status: 200 },
      ),
    );
    const e = env();
    await handleVerifyPremiere(post({ purchaseToken: "tok" }), e);
    expect(e.DB.writes[0].args[0]).toBe(far);
  });

  it("still entitles a CANCELED subscription until its term ends", async () => {
    const expiry = Date.now() + 5 * 86_400_000;
    stubFetch(
      new Response(
        JSON.stringify({
          subscriptionState: "SUBSCRIPTION_STATE_CANCELED",
          lineItems: [{ expiryTime: new Date(expiry).toISOString() }],
        }),
        { status: 200 },
      ),
    );
    const e = env();
    expect(await (await handleVerifyPremiere(post({ purchaseToken: "tok" }), e)).json()).toMatchObject({
      isPremiere: true,
    });
  });

  it("revokes on a token Play no longer recognises — a 404 IS an answer", async () => {
    stubFetch(new Response("not found", { status: 404 }));
    const e = env();
    const res = await handleVerifyPremiere(post({ purchaseToken: "refunded" }), e);
    expect(await res.json()).toEqual({ isPremiere: false, premiereUntil: 0 });
    // The write must happen: this is how a refund actually removes the badge.
    expect(e.DB.writes).toHaveLength(1);
    expect(e.DB.writes[0].args[0]).toBe(0);
  });

  it("revokes an EXPIRED subscription", async () => {
    stubFetch(
      new Response(JSON.stringify({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", lineItems: [] }), {
        status: 200,
      }),
    );
    const e = env();
    expect(e.DB.writes).toHaveLength(0);
    await handleVerifyPremiere(post({ purchaseToken: "old" }), e);
    expect(e.DB.writes[0].args[0]).toBe(0);
  });

  /**
   * The rule the whole failure design exists for. A subscriber who opens the app on a
   * flaky connection, or while Google is having an incident, must not lose their badge.
   * "We could not check" and "we checked and they are not entitled" are different
   * answers and only the second may be written.
   */
  describe("never revokes on a failure that is not about this user", () => {
    it("Google auth unavailable", async () => {
      stubFetch(new Response("{}", { status: 200 }), /* tokenOk */ false);
      const e = env();
      expect((await handleVerifyPremiere(post({ purchaseToken: "tok" }), e)).status).toBe(502);
      expect(e.DB.writes).toHaveLength(0);
    });

    it("Play 5xx", async () => {
      stubFetch(new Response("boom", { status: 503 }));
      const e = env();
      expect((await handleVerifyPremiere(post({ purchaseToken: "tok" }), e)).status).toBe(502);
      expect(e.DB.writes).toHaveLength(0);
    });

    it("our credentials are rejected", async () => {
      stubFetch(new Response("forbidden", { status: 403 }));
      const e = env();
      expect((await handleVerifyPremiere(post({ purchaseToken: "tok" }), e)).status).toBe(502);
      expect(e.DB.writes).toHaveLength(0);
    });

    it("the network throws", async () => {
      stubFetch(new Error("ECONNRESET"));
      const e = env();
      expect((await handleVerifyPremiere(post({ purchaseToken: "tok" }), e)).status).toBe(502);
      expect(e.DB.writes).toHaveLength(0);
    });

    it("an unanticipated 4xx", async () => {
      stubFetch(new Response("teapot", { status: 418 }));
      const e = env();
      expect((await handleVerifyPremiere(post({ purchaseToken: "tok" }), e)).status).toBe(502);
      expect(e.DB.writes).toHaveLength(0);
    });
  });
});

describe("visiblePictureUrl", () => {
  const now = 1_000_000;
  const URL = "https://flickto.app/api/profile/X/picture?v=1";

  it("serves a still picture whatever the subscription state", () => {
    expect(visiblePictureUrl(URL, { premiere_until: 0, picture_animated: 0 }, now)).toBe(URL);
    expect(visiblePictureUrl(URL, { premiere_until: now + 1, picture_animated: 0 }, now)).toBe(URL);
  });

  it("serves an animated picture while the subscription is live", () => {
    expect(visiblePictureUrl(URL, { premiere_until: now + 1, picture_animated: 1 }, now)).toBe(URL);
  });

  /** The whole point: one paid month must not buy a permanent GIF. */
  it("withholds an animated picture once Premiere lapses", () => {
    expect(visiblePictureUrl(URL, { premiere_until: now - 1, picture_animated: 1 }, now)).toBe("");
    expect(visiblePictureUrl(URL, { premiere_until: 0, picture_animated: 1 }, now)).toBe("");
  });

  it("is empty for no picture, and safe on a missing row", () => {
    expect(visiblePictureUrl("", { premiere_until: now + 1, picture_animated: 1 }, now)).toBe("");
    expect(visiblePictureUrl(null, null, now)).toBe("");
    // Orphaned profile: LEFT JOIN yields no user columns at all.
    expect(visiblePictureUrl(URL, {}, now)).toBe(URL);
  });
});
