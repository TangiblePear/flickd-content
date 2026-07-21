import { describe, it, expect } from "vitest";
import worker from "./index";

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

function makeEnv() {
  return { BUCKET: new FakeBucket(), PICS: new FakeBucket(), RATE_LIMIT_PER_HOUR: "10" } as any;
}
const ctx = { waitUntil: () => {} } as any;
const FID = "AAAAAAAAAAAA";
const SECRET = "s1";

const post = (env: any, ciphertext: string) =>
  worker.fetch(
    new Request(`https://flickto.app/api/inbox/${FID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ciphertext }),
    }),
    env,
    ctx,
  );

const get = (env: any) =>
  worker.fetch(
    new Request(`https://flickto.app/api/inbox/${FID}`, { method: "GET", headers: { "X-Feed-Secret": SECRET } }),
    env,
    ctx,
  );

const ack = (env: any, ids: string[], action = "accepted", deviceId = "dev1") =>
  worker.fetch(
    new Request(`https://flickto.app/api/inbox/${FID}/ack`, {
      method: "POST",
      headers: { "X-Feed-Secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action, deviceId }),
    }),
    env,
    ctx,
  );

describe("inbox ack model (0b)", () => {
  it("delivers items to every fetch and never removes them on read", async () => {
    const env = makeEnv();
    await post(env, "c1");
    const a = (await (await get(env)).json()) as any;
    const b = (await (await get(env)).json()) as any;
    expect(a.items).toHaveLength(1);
    expect(a.acks).toEqual([]);
    expect(b.items).toHaveLength(1); // still there after a second read
  });

  it("records an ack (item stays within the grace window) and dedups repeat acks", async () => {
    const env = makeEnv();
    await post(env, "c1");
    const id = ((await (await get(env)).json()) as any).items[0].id;
    await ack(env, [id]);
    await ack(env, [id]); // idempotent
    const body = (await (await get(env)).json()) as any;
    expect(body.items).toHaveLength(1);
    expect(body.acks).toHaveLength(1);
    expect(body.acks[0]).toMatchObject({ id, action: "accepted", by: "dev1" });
  });

  it("keeps DELETE ?upTo= a no-op so a stale client can't wipe the shared inbox", async () => {
    const env = makeEnv();
    await post(env, "c1");
    await worker.fetch(
      new Request(`https://flickto.app/api/inbox/${FID}?upTo=${Date.now() + 1000}`, {
        method: "DELETE",
        headers: { "X-Feed-Secret": SECRET },
      }),
      env,
      ctx,
    );
    expect(((await (await get(env)).json()) as any).items).toHaveLength(1);
  });

  it("reads a legacy bare-array inbox.json as items-only", async () => {
    const env = makeEnv();
    // A pre-0b inbox.json is a bare array; the first owner-authed GET binds the
    // secret via TOFU and returns the array under `items`.
    env.BUCKET.store.set(`${FID}/inbox.json`, JSON.stringify([{ id: "legacy", at: Date.now(), ciphertext: "old" }]));
    const body = (await (await get(env)).json()) as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("legacy");
    expect(body.acks).toEqual([]);
  });

  it("prunes an acked item past the 7d grace window, and an unacked item past 30d", async () => {
    const env = makeEnv();
    const now = Date.now();
    const old = now - 8 * 24 * 3600 * 1000; // 8 days ago
    const ancient = now - 31 * 24 * 3600 * 1000; // 31 days ago
    env.BUCKET.store.set(
      `${FID}/inbox.json`,
      JSON.stringify({
        items: [
          { id: "acked-old", at: old, ciphertext: "a" },
          { id: "unacked-ancient", at: ancient, ciphertext: "b" },
          { id: "fresh", at: now, ciphertext: "c" },
        ],
        acks: [{ id: "acked-old", at: old, by: "d", action: "accepted" }],
      }),
    );
    // A fresh POST triggers pruneInbox on write.
    await post(env, "c-new");
    const body = (await (await get(env)).json()) as any;
    const ids = body.items.map((i: any) => i.id);
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("acked-old"); // acked + past grace → dropped
    expect(ids).not.toContain("unacked-ancient"); // unacked + past 30d → dropped
    expect(body.acks).toHaveLength(0); // its item gone + ack past grace → dropped
  });
});
