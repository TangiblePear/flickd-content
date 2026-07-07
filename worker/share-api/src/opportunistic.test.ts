import { describe, it, expect } from "vitest";
import worker from "./index";

const DAY = 24 * 60 * 60 * 1000;

/** In-memory R2 stand-in covering get/put/delete/head/list (prefix + delimiter). */
class FakeBucket {
  store = new Map<string, string>();
  when = new Map<string, Date>();
  seed(key: string, uploadedMs: number, body = "{}") {
    this.store.set(key, body);
    this.when.set(key, new Date(uploadedMs));
  }
  async get(key: string) {
    if (!this.store.has(key)) return null;
    const body = this.store.get(key)!;
    return { text: async () => body, json: async () => JSON.parse(body) };
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
    this.when.set(key, new Date());
  }
  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) {
      this.store.delete(k);
      this.when.delete(k);
    }
  }
  async head(key: string) {
    return this.store.has(key) ? { uploaded: this.when.get(key)! } : null;
  }
  async list(opts: { prefix?: string; delimiter?: string; cursor?: string } = {}) {
    const prefix = opts.prefix ?? "";
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    if (opts.delimiter) {
      const prefixes = new Set<string>();
      const objects: { key: string; uploaded: Date }[] = [];
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const idx = rest.indexOf(opts.delimiter);
        if (idx >= 0) prefixes.add(prefix + rest.slice(0, idx + 1));
        else objects.push({ key: k, uploaded: this.when.get(k)! });
      }
      return { objects, delimitedPrefixes: [...prefixes], truncated: false, cursor: undefined };
    }
    return {
      objects: keys.map((k) => ({ key: k, uploaded: this.when.get(k)! })),
      delimitedPrefixes: [] as string[],
      truncated: false,
      cursor: undefined,
    };
  }
  has(prefix: string) {
    return [...this.store.keys()].some((k) => k.startsWith(prefix));
  }
}

function makeEnv(bucket: FakeBucket, extra: Record<string, string> = {}) {
  return {
    BUCKET: bucket,
    PICS: new FakeBucket(),
    RATE_LIMIT_PER_HOUR: "10",
    REAP_GATE_THROTTLE_SECONDS: "0", // disable per-isolate throttle in tests
    ...extra,
  } as any;
}

/** Drive a cheap request through the worker, awaiting any background work. */
async function hitOnce(env: any) {
  const promises: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => promises.push(p) } as any;
  const req = new Request("https://flickto.app/api/friendcode/ZZZZZZ", { method: "GET" });
  await worker.fetch(req, env, ctx);
  await Promise.all(promises);
}

describe("opportunistic reaper trigger", () => {
  it("a normal request purges a stale folder when a run is due", async () => {
    const bucket = new FakeBucket();
    bucket.seed("BBBBBBBBBBBB/profile.json", Date.now() - 400 * DAY); // stale (> 365d)
    bucket.seed("AAAAAAAAAAAA/fcm-token.json", Date.now()); // fresh
    const env = makeEnv(bucket, { REAP_INTERVAL_SECONDS: "0" }); // always due

    await hitOnce(env);

    expect(bucket.has("BBBBBBBBBBBB/")).toBe(false);
    expect(bucket.has("AAAAAAAAAAAA/")).toBe(true);
    const gc = JSON.parse(bucket.store.get("_gc/cursor.json")!);
    expect(typeof gc.lastRunAt).toBe("number");
  });

  it("does not reap when a run happened recently", async () => {
    const bucket = new FakeBucket();
    bucket.seed("_gc/cursor.json", Date.now(), JSON.stringify({ lastRunAt: Date.now() }));
    bucket.seed("BBBBBBBBBBBB/profile.json", Date.now() - 400 * DAY);
    const env = makeEnv(bucket, { REAP_INTERVAL_SECONDS: "86400" }); // 24h

    await hitOnce(env);

    expect(bucket.has("BBBBBBBBBBBB/")).toBe(true);
  });
});
