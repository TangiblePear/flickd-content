import { describe, expect, it, vi, afterEach, beforeAll } from "vitest";
import {
  handleVerifyPremiere,
  isPremiere,
  readPremiereWire,
  visibleBorderId,
  visibleHeaderColor,
  visiblePictureUrl,
  visibleStickers,
} from "./premiere";
import { TestD1, seedUser, uid } from "./testD1";

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

  // ── The admin comp (migration 0031) ────────────────────────────────────────
  it("entitles on an admin comp alone, with no Play subscription", () => {
    expect(isPremiere({ premiere_until: 0, premiere_comp_until: now + 1 }, now)).toBe(true);
  });

  it("takes the LONGER of the two, in either direction", () => {
    // A comp outliving a lapsed subscription.
    expect(isPremiere({ premiere_until: now - 1, premiere_comp_until: now + 1 }, now)).toBe(true);
    // A subscription outliving an expired comp.
    expect(isPremiere({ premiere_until: now + 1, premiere_comp_until: now - 1 }, now)).toBe(true);
    // Both gone.
    expect(isPremiere({ premiere_until: now - 1, premiere_comp_until: now - 1 }, now)).toBe(false);
  });

  it("comps expire themselves too", () => {
    expect(isPremiere({ premiere_comp_until: now }, now)).toBe(false);
    expect(isPremiere({ premiere_comp_until: now - 1 }, now)).toBe(false);
  });

  /**
   * ⚠️ The regression the second column exists for.
   *
   * `handleVerifyPremiere` writes Play's answer to `premiere_until` and is entitled to
   * write 0 — a refund, a cancellation, or a token Play has never heard of. Had the comp
   * been stored in that column it would have been erased here, and only for people who
   * HAVE a subscription: `PremiereVerifier.reconcile` returns early without a purchase
   * token, so the bug would have passed every test on a comped non-subscriber and failed
   * in production. See the note in migration 0031.
   */
  it("survives a Play verification that revokes the subscription", () => {
    const comped = { premiere_until: now + 86_400_000, premiere_comp_until: now + 30 * 86_400_000 };
    expect(isPremiere(comped, now)).toBe(true);
    // Play reports the subscription is gone. Only its own column is touched.
    const afterRevoke = { ...comped, premiere_until: 0 };
    expect(isPremiere(afterRevoke, now)).toBe(true);
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

describe("visibleBorderId", () => {
  const now = 1_000_000;

  it("never touches an earned border, subscribed or not", () => {
    // Genre, achievement and meta borders are earned and permanent — suppressing one
    // would take away something the user worked for.
    for (const id of ["bd_g_horror_anim", "bd_ach_inferno", "bd_meta_supreme", "bd_ach_beta_tester"]) {
      expect(visibleBorderId(id, { premiere_until: 0 }, now)).toBe(id);
      expect(visibleBorderId(id, { premiere_until: now + 1 }, now)).toBe(id);
    }
  });

  it("shows a Premiere border only while the subscription is live", () => {
    expect(visibleBorderId("bd_pre_gold", { premiere_until: now + 1 }, now)).toBe("bd_pre_gold");
    expect(visibleBorderId("bd_pre_gold", { premiere_until: now - 1 }, now)).toBe("");
    expect(visibleBorderId("bd_pre_aurora", { premiere_until: 0 }, now)).toBe("");
  });

  it("is safe on empty and on a missing row", () => {
    expect(visibleBorderId("", { premiere_until: now + 1 }, now)).toBe("");
    expect(visibleBorderId(null, null, now)).toBe("");
    expect(visibleBorderId("bd_pre_gold", null, now)).toBe("");
  });
});

describe("visibleHeaderColor", () => {
  const now = 1_700_000_000_000;

  it("passes a single colour through regardless of entitlement", () => {
    expect(visibleHeaderColor("#3949AB", { premiere_until: 0 }, now)).toBe("#3949AB");
    expect(visibleHeaderColor("#3949AB", { premiere_until: now + 1 }, now)).toBe("#3949AB");
  });

  it("serves a duotone while entitled", () => {
    expect(visibleHeaderColor("#FFD700,#8A6100", { premiere_until: now + 1 }, now))
      .toBe("#FFD700,#8A6100");
  });

  /**
   * The first stop, NOT empty — emptying drops them to the genre Flare gradient, which
   * reads as "they changed their profile" rather than "they stopped paying".
   */
  it("degrades a lapsed duotone to its first stop", () => {
    expect(visibleHeaderColor("#FFD700,#8A6100", { premiere_until: now - 1 }, now)).toBe("#FFD700");
    expect(visibleHeaderColor("#FFD700, #8A6100", { premiere_until: 0 }, now)).toBe("#FFD700");
  });

  it("treats a missing users row as not entitled", () => {
    expect(visibleHeaderColor("#FFD700,#8A6100", null, now)).toBe("#FFD700");
    expect(visibleHeaderColor("", null, now)).toBe("");
    expect(visibleHeaderColor(null, null, now)).toBe("");
  });
});

// ── readPremiereWire ─────────────────────────────────────────────────────────
// Real SQL against the real migrations: this reads a table the rest of this file
// only ever fakes, and the whole point of the function is WHICH table it reads.

describe("readPremiereWire", () => {
  const DAY = 86_400_000;

  it("returns both expiries so the client can tell paid from comped", async () => {
    const db = new TestD1();
    const paid = Date.now() + 10 * DAY;
    const comp = Date.now() + 30 * DAY;
    const a = seedUser(db, { id: uid(70), premiereUntil: paid, premiereCompUntil: comp });

    expect(await readPremiereWire(db as never, a)).toEqual({
      premiereUntil: paid,
      premiereCompUntil: comp,
    });
  });

  /**
   * ⚠️ The reason this reads `users` and not `readProfileRow`. Someone who has never
   * opened the social half of the app has no `profiles` row at all, and the profile join
   * would hand them a silent 0 — comped by the admin, ordinary in the app, nothing logged.
   */
  it("answers for an account that has never written a profile", async () => {
    const db = new TestD1();
    const comp = Date.now() + 30 * DAY;
    const a = seedUser(db, { id: uid(71), displayName: null, premiereCompUntil: comp });
    expect(db.count("profiles")).toBe(0);

    expect(await readPremiereWire(db as never, a)).toEqual({ premiereUntil: 0, premiereCompUntil: comp });
  });

  it("reads a missing account as no entitlement rather than throwing", async () => {
    const db = new TestD1();
    expect(await readPremiereWire(db as never, uid(72))).toEqual({ premiereUntil: 0, premiereCompUntil: 0 });
  });
});

describe("visibleStickers", () => {
  const active = { premiere_until: Date.now() + 60_000, premiere_comp_until: 0 };
  const lapsed = { premiere_until: Date.now() - 60_000, premiere_comp_until: 0 };
  const four =
    "a;https://x/a;0.10;0.10;0.30;0.00;holo|" +
    "b;https://x/b;0.20;0.20;0.30;0.00;silver|" +
    "c;https://x/c;0.30;0.30;0.30;0.00;#FF375F|" +
    "d;https://x/d;0.40;0.40;0.30;0.00;foil";

  it("publishes everything untouched while Premiere is active", () => {
    expect(visibleStickers(four, active)).toBe(four);
  });

  /**
   * One sticker, plain border — the free entitlement. Not zero: the free tier includes a
   * sticker, and blanking it would punish a lapse harder than never subscribing.
   */
  it("degrades to one sticker with a white border once lapsed", () => {
    const out = visibleStickers(four, lapsed);
    expect(out.split("|")).toHaveLength(1);
    expect(out.split(";")[6]).toBe("#FFFFFF");
    // Position and scale are untouched; only the count and the border are entitlements.
    expect(out.split(";").slice(2, 6)).toEqual(["0.10", "0.10", "0.30", "0.00"]);
  });

  /**
   * ⚠️ The guarantee that makes this safe to apply on every read: the STORED column is
   * never rewritten, so resubscribing restores all four with their original borders.
   */
  it("is non-destructive — the same input degrades and restores", () => {
    expect(visibleStickers(four, lapsed)).not.toBe(four);
    expect(visibleStickers(four, active)).toBe(four);
  });

  it("handles an empty column and a malformed record", () => {
    expect(visibleStickers("", lapsed)).toBe("");
    expect(visibleStickers(null, lapsed)).toBe("");
    expect(visibleStickers("nonsense", lapsed)).toBe("");
  });
});
