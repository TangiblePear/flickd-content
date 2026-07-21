import { describe, it, expect } from "vitest";
import worker from "./index";

/** R2 stand-in that preserves customMetadata + uploaded (what 0a-2 relies on). */
class FakeBucket {
  store = new Map<string, { body: string; meta?: Record<string, string>; when: Date }>();
  async get(key: string) {
    const rec = this.store.get(key);
    if (!rec) return null;
    return {
      text: async () => rec.body,
      json: async () => JSON.parse(rec.body),
      uploaded: rec.when,
      customMetadata: rec.meta,
    };
  }
  async put(key: string, value: string, opts?: { customMetadata?: Record<string, string> }) {
    this.store.set(key, { body: value, meta: opts?.customMetadata, when: new Date() });
  }
  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) this.store.delete(k);
  }
  async head(key: string) {
    const rec = this.store.get(key);
    return rec ? { uploaded: rec.when, customMetadata: rec.meta } : null;
  }
  async list() {
    return { objects: [], delimitedPrefixes: [], truncated: false, cursor: undefined };
  }
}

function makeEnv() {
  return { BUCKET: new FakeBucket(), PICS: new FakeBucket(), RATE_LIMIT_PER_HOUR: "10" } as any;
}
const ctx = { waitUntil: () => {} } as any;

const FID = "AAAAAAAAAAAA";
const SECRET = "s1";
const RT = "read-token-1";

async function putProfile(env: any, readToken: string | null) {
  const headers: Record<string, string> = { "X-Feed-Secret": SECRET };
  if (readToken) headers["X-Read-Token"] = readToken;
  const req = new Request(`https://flickto.app/api/user/${FID}/profile`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ header: {}, ciphertext: "x" }),
  });
  return worker.fetch(req, env, ctx);
}

async function freshness(env: any, items: unknown[]) {
  const req = new Request("https://flickto.app/api/social/freshness", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  return worker.fetch(req, env, ctx);
}

describe("freshness single-get auth (0a-2)", () => {
  it("returns the profile when the read token matches the stashed customMetadata", async () => {
    const env = makeEnv();
    await putProfile(env, RT);
    const resp = await freshness(env, [{ friendId: FID, readToken: RT, since: 0 }]);
    const body = (await resp.json()) as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].friendId).toBe(FID);
    expect(body.items[0].profile).toEqual({ header: {}, ciphertext: "x" });
  });

  it("rejects a wrong read token (no owner.json fallback matches either)", async () => {
    const env = makeEnv();
    await putProfile(env, RT);
    const resp = await freshness(env, [{ friendId: FID, readToken: "wrong", since: 0 }]);
    expect(((await resp.json()) as any).items).toHaveLength(0);
  });

  it("omits a profile that is not newer than `since`", async () => {
    const env = makeEnv();
    await putProfile(env, RT);
    const resp = await freshness(env, [{ friendId: FID, readToken: RT, since: Date.now() + 60_000 }]);
    expect(((await resp.json()) as any).items).toHaveLength(0);
  });

  it("falls back to owner.json for a profile stored without a stashed token", async () => {
    const env = makeEnv();
    // Bind the owner + read token via a push write (owner.json.t = RT), then store a
    // profile object directly with NO customMetadata (a pre-0a-2 object).
    await worker.fetch(
      new Request(`https://flickto.app/api/user/${FID}/push`, {
        method: "PUT",
        headers: { "X-Feed-Secret": SECRET, "X-Read-Token": RT },
        body: JSON.stringify({ selfTopic: "t_a", friendTopic: "t_b" }),
      }),
      env,
      ctx,
    );
    await env.BUCKET.put(`${FID}/profile.json`, JSON.stringify({ header: {}, ciphertext: "old" }));
    const resp = await freshness(env, [{ friendId: FID, readToken: RT, since: 0 }]);
    const body = (await resp.json()) as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].profile.ciphertext).toBe("old");
  });
});
