import { describe, it, expect } from "vitest";
import worker from "./index";

/** In-memory R2 stand-in covering the surface the handlers touch. */
class FakeBucket {
  store = new Map<string, string>();
  when = new Map<string, Date>();
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
  async list() {
    return { objects: [], delimitedPrefixes: [], truncated: false, cursor: undefined };
  }
}

function makeEnv() {
  return { BUCKET: new FakeBucket(), PICS: new FakeBucket(), RATE_LIMIT_PER_HOUR: "10" } as any;
}
const ctx = { waitUntil: () => {} } as any;

const FID = "AAAAAAAAAAAA";

async function put(env: any, kind: string, secret: string, body: string) {
  const req = new Request(`https://flickto.app/api/user/${FID}/${kind}`, {
    method: "PUT",
    headers: { "X-Feed-Secret": secret, "X-Read-Token": "rt" },
    body,
  });
  return worker.fetch(req, env, ctx);
}

async function getInbox(env: any, friendId: string, secret: string) {
  const req = new Request(`https://flickto.app/api/inbox/${friendId}`, {
    method: "GET",
    headers: { "X-Feed-Secret": secret },
  });
  return worker.fetch(req, env, ctx);
}

describe("ownerRecreated flag", () => {
  it("is true on the first owner-authed PUT (owner.json absent) and false after", async () => {
    const env = makeEnv();

    const first = await put(env, "fcm-token", "secret1", '{"token":"x"}');
    expect(((await first.json()) as any).ownerRecreated).toBe(true);

    const second = await put(env, "fcm-token", "secret1", '{"token":"y"}');
    expect(((await second.json()) as any).ownerRecreated).toBe(false);
  });

  it("is true on the first inbox GET that has to bind the owner, false after", async () => {
    const env = makeEnv();

    const first = await getInbox(env, "BBBBBBBBBBBB", "s2");
    const firstBody = (await first.json()) as any;
    expect(firstBody.ownerRecreated).toBe(true);
    expect(firstBody.items).toEqual([]);

    const second = await getInbox(env, "BBBBBBBBBBBB", "s2");
    expect(((await second.json()) as any).ownerRecreated).toBe(false);
  });

  it("still forbids a wrong secret after the owner is bound", async () => {
    const env = makeEnv();
    await put(env, "fcm-token", "secret1", '{"token":"x"}');
    const bad = await getInbox(env, FID, "wrong-secret");
    expect(bad.status).toBe(403);
  });
});
