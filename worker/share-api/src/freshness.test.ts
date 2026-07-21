import { describe, it, expect } from "vitest";
import worker from "./index";

/** R2 stand-in that preserves customMetadata + uploaded (what 0a-2/0a-3 rely on). */
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
const REQ = "BBBBBBBBBBBB"; // the requester (a friend of FID)
const SECRET = "s1";
const TA = "read-token-a"; // stable, gates access.json
const TC = "read-token-c"; // rotatable, gates profile/opinions

/** Blind slot hash matching the Worker's sha256hex("access-slot:" + id). */
async function slotHash(id: string): Promise<string> {
  const data = new TextEncoder().encode(`access-slot:${id}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function putProfile(env: any, tc: string | null, keyEpoch = 0) {
  const headers: Record<string, string> = { "X-Feed-Secret": SECRET, "X-Read-Token": TA };
  if (tc) headers["X-Read-Token-C"] = tc;
  const req = new Request(`https://flickto.app/api/user/${FID}/profile`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ header: { keyEpoch }, ciphertext: "x" }),
  });
  return worker.fetch(req, env, ctx);
}

async function freshness(env: any, items: unknown[], requesterId?: string) {
  const req = new Request("https://flickto.app/api/social/freshness", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, requesterId }),
  });
  return worker.fetch(req, env, ctx);
}

describe("freshness single-get auth (0a-2/0a-3)", () => {
  it("returns the profile when the read token matches the stashed tc", async () => {
    const env = makeEnv();
    await putProfile(env, TC);
    const resp = await freshness(env, [{ friendId: FID, readToken: TC, since: 0 }]);
    const body = (await resp.json()) as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].profile.ciphertext).toBe("x");
  });

  it("rejects a wrong tc", async () => {
    const env = makeEnv();
    await putProfile(env, TC);
    const resp = await freshness(env, [{ friendId: FID, readToken: "wrong", since: 0 }]);
    expect(((await resp.json()) as any).items).toHaveLength(0);
  });

  it("omits a profile not newer than `since`", async () => {
    const env = makeEnv();
    await putProfile(env, TC);
    const resp = await freshness(env, [{ friendId: FID, readToken: TC, since: Date.now() + 60_000 }]);
    expect(((await resp.json()) as any).items).toHaveLength(0);
  });

  it("falls back to owner.json.tc for a profile stored without a stashed token", async () => {
    const env = makeEnv();
    await putProfile(env, TC); // binds owner.json.tc = TC
    // Overwrite the object directly with NO customMetadata (a pre-stamp object).
    await env.BUCKET.put(`${FID}/profile.json`, JSON.stringify({ header: {}, ciphertext: "old" }));
    const resp = await freshness(env, [{ friendId: FID, readToken: TC, since: 0 }]);
    const body = (await resp.json()) as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].profile.ciphertext).toBe("old");
  });
});

describe("ta/tc token split (0a-3)", () => {
  it("gates access.json by ta and profile.json by tc", async () => {
    const env = makeEnv();
    // Bind both tokens via an access PUT (ta) and a profile PUT (tc).
    await worker.fetch(
      new Request(`https://flickto.app/api/user/${FID}/access`, {
        method: "PUT",
        headers: { "X-Feed-Secret": SECRET, "X-Read-Token": TA },
        body: JSON.stringify({ keys: {} }),
      }),
      env,
      ctx,
    );
    await putProfile(env, TC);

    const getWith = (kind: string, token: string) =>
      worker.fetch(
        new Request(`https://flickto.app/api/user/${FID}/${kind}`, {
          method: "GET",
          headers: { "X-Read-Token": token },
        }),
        env,
        ctx,
      );

    expect((await getWith("access", TA)).status).toBe(200);
    expect((await getWith("access", TC)).status).toBe(403); // tc must not open access
    expect((await getWith("profile", TC)).status).toBe(200);
    expect((await getWith("profile", TA)).status).toBe(403); // ta must not open profile
  });
});

describe("rotation slot delivery (0a-3)", () => {
  it("returns the requester's inline slot on a keyEpoch bump, and nothing to a removed friend", async () => {
    const env = makeEnv();
    // Author rotated: profile now at keyEpoch 2, and access.json carries a slot for
    // the remaining friend REQ (blind-indexed) but none for a removed friend.
    await putProfile(env, "tc2", 2);
    const hash = await slotHash(REQ);
    await env.BUCKET.put(
      `${FID}/access.json`,
      JSON.stringify({ keys: { [hash]: { feedKey: "wrapped", indexKey: "wrapped", tc: "wrapped", pushTopic: "wrapped" } } }),
    );

    // Remaining friend sends its stale keyEpoch (0) → gets the slot inline.
    const kept = (await (await freshness(env, [{ friendId: FID, readToken: "stale", since: 0, keyEpoch: 0 }], REQ)).json()) as any;
    expect(kept.items).toHaveLength(1);
    expect(kept.items[0].slot).toBeDefined();
    expect(kept.items[0].keyEpoch).toBe(2);

    // A removed friend (no slot in access.json) gets nothing, even on the bump.
    const removed = (await (await freshness(env, [{ friendId: FID, readToken: "stale", since: 0, keyEpoch: 0 }], "CCCCCCCCCCCC")).json()) as any;
    expect(removed.items).toHaveLength(0);
  });
});
