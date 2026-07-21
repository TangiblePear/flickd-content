import { describe, it, expect, beforeAll, vi } from "vitest";
import { verifyGoogleIdToken } from "./account";
import worker from "./index";

const AUD = "test-web-client.apps.googleusercontent.com";
const KID = "test-kid-1";
const PEPPER = "pepper-0123456789abcdef0123456789";
let signKey: CryptoKey;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
const b64urlStr = (str: string) => b64url(new TextEncoder().encode(str));

async function makeToken(claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey } = {}): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: "RS256", kid: opts.kid ?? KID, typ: "JWT" }));
  const payload = b64urlStr(JSON.stringify(claims));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? signKey, new TextEncoder().encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const validClaims = (over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: AUD,
  sub: "google-sub-1",
  exp: future(),
  ...over,
});

class FakeBucket {
  store = new Map<string, string>();
  async get(key: string) {
    if (!this.store.has(key)) return null;
    const body = this.store.get(key)!;
    return { text: async () => body, json: async () => JSON.parse(body) };
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) this.store.delete(k);
  }
  async head() {
    return null;
  }
  async list() {
    return { objects: [], delimitedPrefixes: [], truncated: false, cursor: undefined };
  }
}
const makeEnv = () =>
  ({ BUCKET: new FakeBucket(), PICS: new FakeBucket(), RATE_LIMIT_PER_HOUR: "1000", GOOGLE_WEB_CLIENT_ID: AUD, ACCOUNT_PEPPER: PEPPER }) as any;
const ctx = { waitUntil: () => {} } as any;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signKey = pair.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as any;
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  vi.stubGlobal("fetch", async (u: unknown) => {
    if (String(u).includes("oauth2/v3/certs")) {
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "cache-control": "max-age=3600" } });
    }
    return new Response("no", { status: 404 });
  });
});

describe("verifyGoogleIdToken (Part 1)", () => {
  it("accepts a valid token and returns its sub", async () => {
    const r = await verifyGoogleIdToken(await makeToken(validClaims()), makeEnv());
    expect(r).toEqual({ sub: "google-sub-1" });
  });
  it("rejects a wrong aud", async () => {
    expect(await verifyGoogleIdToken(await makeToken(validClaims({ aud: "someone-else" })), makeEnv())).toBeNull();
  });
  it("rejects an expired token", async () => {
    expect(await verifyGoogleIdToken(await makeToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 60 })), makeEnv())).toBeNull();
  });
  it("rejects a bad signature", async () => {
    const t = await makeToken(validClaims());
    const tampered = t.slice(0, -3) + (t.slice(-3) === "AAA" ? "BBB" : "AAA");
    expect(await verifyGoogleIdToken(tampered, makeEnv())).toBeNull();
  });
  it("rejects a wrong issuer", async () => {
    expect(await verifyGoogleIdToken(await makeToken(validClaims({ iss: "evil.example.com" })), makeEnv())).toBeNull();
  });
});

describe("account link conflict (Part 1)", () => {
  const link = (env: any, token: string, body: unknown, force = false) =>
    worker.fetch(
      new Request(`https://flickto.app/api/account/link${force ? "?force=1" : ""}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );

  it("links, then 409s a second sub with the existing friendId + count, and force overwrites", async () => {
    const env = makeEnv();
    const token = await makeToken(validClaims());
    const body = { ciphertext: "ct", dek: btoa("dek-material"), friendId: "AAAAAAAAAAAA", friendCount: 3 };

    expect((await link(env, token, body)).status).toBe(200);

    const conflict = await link(env, token, { ...body, friendId: "BBBBBBBBBBBB", friendCount: 0 });
    expect(conflict.status).toBe(409);
    const cbody = (await conflict.json()) as any;
    expect(cbody.existingFriendId).toBe("AAAAAAAAAAAA");
    expect(cbody.friendCount).toBe(3);

    // force overwrite succeeds
    expect((await link(env, token, { ...body, friendId: "BBBBBBBBBBBB" }, true)).status).toBe(200);

    // resolve returns the new friendId + the unwrapped dek
    const resolved = await worker.fetch(
      new Request("https://flickto.app/api/account/resolve", { method: "GET", headers: { Authorization: `Bearer ${token}` } }),
      env,
      ctx,
    );
    expect(resolved.status).toBe(200);
    const rbody = (await resolved.json()) as any;
    expect(rbody.friendId).toBe("BBBBBBBBBBBB");
    expect(atob(rbody.dek)).toBe("dek-material");
  });

  it("returns 401 without a valid token", async () => {
    const env = makeEnv();
    const r = await link(env, "not-a-jwt", { ciphertext: "c", dek: "d", friendId: "AAAAAAAAAAAA" });
    expect(r.status).toBe(401);
  });
});
