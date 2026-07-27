// Step 4: retiring the E2EE inbox behind a server-controlled date.
//
// The property that matters most here is a NEGATIVE one: retirement is scoped to the
// inbox and must not touch `freshness` or the friends record, which ride the same
// relay block and are how friend profiles are pulled. Switching off the whole relay
// would silently break the friend feed, and nothing would fail loudly enough to catch it.

import { describe, it, expect } from "vitest";
import { inboxRetired, inboxRetiresAt } from "./sync";
import worker from "./index";

const FUTURE = Date.now() + 86_400_000;
const PAST = Date.now() - 86_400_000;

describe("the retirement date itself", () => {
  it("is off unless a real future/past timestamp is configured", () => {
    // Unset is the default and MUST mean "never" — a parsing slip that read as 0 =
    // "retired now" would switch the inbox off for everyone on the next deploy.
    expect(inboxRetired({})).toBe(false);
    expect(inboxRetired({ RELAY_RETIRES_AT: "" })).toBe(false);
    expect(inboxRetired({ RELAY_RETIRES_AT: "0" })).toBe(false);
    expect(inboxRetired({ RELAY_RETIRES_AT: "not a number" })).toBe(false);
    expect(inboxRetired({ RELAY_RETIRES_AT: String(FUTURE) })).toBe(false);
    expect(inboxRetired({ RELAY_RETIRES_AT: String(PAST) })).toBe(true);
  });

  it("reports the date so the client can stop asking before the server refuses", () => {
    expect(inboxRetiresAt({ RELAY_RETIRES_AT: String(FUTURE) })).toBe(FUTURE);
    expect(inboxRetiresAt({})).toBe(0);
  });
});

class FakeBucket {
  store = new Map<string, string>();
  async get(key: string) {
    if (!this.store.has(key)) return null;
    const body = this.store.get(key)!;
    return { text: async () => body, json: async () => JSON.parse(body), uploaded: new Date() };
  }
  async put(key: string, value: string) { this.store.set(key, String(value)); }
  async delete(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) this.store.delete(k); }
  async head() { return null; }
  async list() { return { objects: [], delimitedPrefixes: [], truncated: false, cursor: undefined }; }
}

const ctx = { waitUntil: () => {} } as any;
const FID = "AAAAAAAAAAAA";
const SECRET = "s1";

function makeEnv(retiresAt?: number) {
  return {
    BUCKET: new FakeBucket(),
    RATE_LIMIT_PER_HOUR: "10",
    ...(retiresAt ? { RELAY_RETIRES_AT: String(retiresAt) } : {}),
  } as any;
}

const post = (env: any, ciphertext: string) =>
  worker.fetch(
    new Request(`https://flickto.app/api/inbox/${FID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ciphertext }),
    }),
    env, ctx,
  );

const get = (env: any) =>
  worker.fetch(
    new Request(`https://flickto.app/api/inbox/${FID}`, { headers: { "X-Feed-Secret": SECRET } }),
    env, ctx,
  );

const ack = (env: any, ids: string[]) =>
  worker.fetch(
    new Request(`https://flickto.app/api/inbox/${FID}/ack`, {
      method: "POST",
      headers: { "X-Feed-Secret": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action: "processed" }),
    }),
    env, ctx,
  );

describe("the inbox endpoints once retired", () => {
  it("accepts and discards a post rather than erroring", async () => {
    const env = makeEnv(PAST);
    const res = await post(env, "CIPHERTEXT");
    // Quietly ok: a stale client posting a friend request must not surface a
    // crash-shaped message for something the user cannot act on.
    expect(res.status).toBe(200);
    expect([...env.BUCKET.store.keys()].some((k) => k.includes("inbox"))).toBe(false);
  });

  it("returns an empty inbox, and still refuses a bad owner secret first", async () => {
    const live = makeEnv();
    await post(live, "CIPHERTEXT");
    expect((((await (await get(live)).json()) as any).items).length).toBe(1);

    // Same bucket contents, retired: nothing comes back.
    const retired = makeEnv(PAST);
    retired.BUCKET = live.BUCKET;
    const body = (await (await get(retired)).json()) as any;
    expect(body.items).toEqual([]);
    expect(body.acks).toEqual([]);

    // Retirement must not become a way to probe identities that owner-auth would hide.
    const wrongSecret = await worker.fetch(
      new Request(`https://flickto.app/api/inbox/${FID}`, { headers: { "X-Feed-Secret": "wrong" } }),
      retired, ctx,
    );
    expect(wrongSecret.status).toBe(403);
  });

  it("no-ops an ack instead of rewriting the object", async () => {
    const live = makeEnv();
    await post(live, "CIPHERTEXT");
    const before = live.BUCKET.store.get(`${FID}/inbox.json`);

    const retired = makeEnv(PAST);
    retired.BUCKET = live.BUCKET;
    expect((await ack(retired, ["some-id"])).status).toBe(200);
    // Writing an ack would resurrect the very object retirement exists to stop writing.
    expect(retired.BUCKET.store.get(`${FID}/inbox.json`)).toBe(before);
  });

  it("changes nothing at all before the date", async () => {
    const env = makeEnv(FUTURE);
    await post(env, "CIPHERTEXT");
    expect((((await (await get(env)).json()) as any).items).length).toBe(1);
  });
});
