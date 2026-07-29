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

/**
 * Any owner-authed call will do. This used to probe the inbox GET; the inbox is gone
 * (Part C) but the self-heal it carried is not — `ownerRecreated` rides a dozen
 * owner-authed endpoints and `OwnerRecreatedInterceptor` peeks EVERY relay response,
 * so the guarantee is endpoint-agnostic and the coverage has to stay.
 */
async function ownerAuthed(env: any, friendId: string, secret: string) {
  const req = new Request(`https://flickto.app/api/user/${friendId}/fcm-token`, {
    method: "PUT",
    headers: { "X-Feed-Secret": secret, "X-Read-Token": "rt" },
    body: '{"token":"x"}',
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

  it("is true on the first call that has to bind an unseen owner, false after", async () => {
    const env = makeEnv();

    const first = await ownerAuthed(env, "BBBBBBBBBBBB", "s2");
    expect(((await first.json()) as any).ownerRecreated).toBe(true);

    const second = await ownerAuthed(env, "BBBBBBBBBBBB", "s2");
    expect(((await second.json()) as any).ownerRecreated).toBe(false);
  });

  it("still forbids a wrong secret after the owner is bound", async () => {
    const env = makeEnv();
    await put(env, "fcm-token", "secret1", '{"token":"x"}');
    const bad = await ownerAuthed(env, FID, "wrong-secret");
    expect(bad.status).toBe(403);
  });
});
