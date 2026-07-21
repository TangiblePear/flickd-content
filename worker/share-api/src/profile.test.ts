import { describe, it, expect } from "vitest";
import worker from "./index";

/** R2 stand-in that models httpEtag + onlyIf.etagMatches (what 0c-2 relies on). */
class FakeBucket {
  store = new Map<string, { body: string; etag: string; meta?: Record<string, string> }>();
  seq = 0;
  async get(key: string) {
    const rec = this.store.get(key);
    if (!rec) return null;
    return {
      text: async () => rec.body,
      json: async () => JSON.parse(rec.body),
      httpEtag: rec.etag,
      customMetadata: rec.meta,
      uploaded: new Date(),
    };
  }
  async put(key: string, value: string, opts?: { onlyIf?: { etagMatches?: string }; customMetadata?: Record<string, string> }) {
    const cur = this.store.get(key);
    const want = opts?.onlyIf?.etagMatches;
    if (want !== undefined && cur?.etag !== want) return null; // conditional write failed
    const etag = `"e${++this.seq}"`;
    this.store.set(key, { body: value, etag, meta: opts?.customMetadata });
    return { httpEtag: etag };
  }
  async head(key: string) {
    const rec = this.store.get(key);
    return rec ? { httpEtag: rec.etag } : null;
  }
  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) this.store.delete(k);
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

function putProfile(env: any, body: string, ifMatch?: string) {
  const headers: Record<string, string> = { "X-Feed-Secret": "s1", "X-Read-Token": "ta", "X-Read-Token-C": "tc" };
  if (ifMatch) headers["X-If-Match"] = ifMatch;
  return worker.fetch(
    new Request(`https://flickto.app/api/user/${FID}/profile`, { method: "PUT", headers, body }),
    env,
    ctx,
  );
}

const getProfile = (env: any) =>
  worker.fetch(
    new Request(`https://flickto.app/api/user/${FID}/profile`, { method: "GET", headers: { "X-Read-Token": "tc" } }),
    env,
    ctx,
  );

describe("profile conditional write (0c-2)", () => {
  it("returns an etag on write and exposes it on GET", async () => {
    const env = makeEnv();
    const put = (await (await putProfile(env, JSON.stringify({ header: {}, ciphertext: "a" }))).json()) as any;
    expect(put.etag).toBeDefined();
    const get = await getProfile(env);
    expect(get.headers.get("ETag")).toBe(put.etag);
  });

  it("accepts a conditional write when X-If-Match is current, and 409s when stale", async () => {
    const env = makeEnv();
    const e1 = ((await (await putProfile(env, JSON.stringify({ ciphertext: "a" }))).json()) as any).etag;

    // Current etag → succeeds, returns a new etag.
    const ok = await putProfile(env, JSON.stringify({ ciphertext: "b" }), e1);
    expect(ok.status).toBe(200);
    const e2 = ((await ok.json()) as any).etag;
    expect(e2).not.toBe(e1);

    // Stale etag (e1) → 409 with the current etag so the client re-reads + retries.
    const conflict = await putProfile(env, JSON.stringify({ ciphertext: "c" }), e1);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as any).etag).toBe(e2);
  });
});
