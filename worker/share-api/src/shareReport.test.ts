// Share-link moderation. The public `share/{code}` landing page renders a
// user-authored title, `POST /api/share` is unauthenticated, and until now there
// was no report route and no takedown — the classic "we host UGC on our own
// domain" gap. These tests pin the three properties that make the fix safe rather
// than merely present.

import { describe, it, expect } from "vitest";
import worker from "./index";

/** Prefix-aware fake, because the autohide counter lists `_reports/{code}/`. */
class FakeBucket {
  store = new Map<string, string>();
  async get(key: string) {
    if (!this.store.has(key)) return null;
    const body = this.store.get(key)!;
    return {
      text: async () => body,
      json: async () => JSON.parse(body),
      uploaded: new Date(),
      customMetadata: undefined,
      httpEtag: '"etag"',
    };
  }
  async put(key: string, value: string) {
    this.store.set(key, typeof value === "string" ? value : String(value));
    return { httpEtag: '"etag"' };
  }
  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) this.store.delete(k);
  }
  async head(key: string) {
    return this.store.has(key) ? { httpEtag: '"etag"' } : null;
  }
  async list(opts: { prefix?: string } = {}) {
    const prefix = opts.prefix ?? "";
    const objects = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key, uploaded: new Date() }));
    return { objects, delimitedPrefixes: [], truncated: false, cursor: undefined };
  }
}

/** Just enough D1 for `resolveSession` — nothing here touches another table. */
class FakeD1 {
  sessions = new Map<string, string>();
  prepare(sql: string) {
    const db = this;
    let args: unknown[] = [];
    return {
      bind(...a: unknown[]) {
        args = a;
        return this;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes("FROM sessions")) {
          const user = db.sessions.get(args[0] as string);
          return user ? ({ user_id: user, expires_at: Date.now() + 8.64e7, revoked_at: null } as T) : null;
        }
        return null;
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
}

const ctx = { waitUntil: () => {} } as any;

async function makeEnv(...sessionTokens: string[]) {
  const db = new FakeD1();
  const enc = new TextEncoder();
  for (const token of sessionTokens) {
    const d = await crypto.subtle.digest("SHA-256", enc.encode(token));
    db.sessions.set(
      [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      // The session's account id; any opaque string works for these tests.
      `USER-${token}`,
    );
  }
  return {
    BUCKET: new FakeBucket(),
    DB: db,
    RATE_LIMIT_PER_HOUR: "10",
    REPORT_AUTOHIDE: "3",
    SHARE_TTL_SECONDS: "2592000",
    MAX_ITEMS: "100",
  } as any;
}

const create = (env: any, title = "Weekend picks", token?: string) =>
  worker.fetch(
    new Request("https://flickto.app/api/share", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ title, items: [{ tmdbId: 603, type: "MOVIE" }] }),
    }),
    env,
    ctx,
  );

const fetchShare = (env: any, code: string) =>
  worker.fetch(new Request(`https://flickto.app/api/share/${code}`), env, ctx);

const landing = (env: any, code: string) =>
  worker.fetch(new Request(`https://flickto.app/share/${code}`), env, ctx);

const report = (env: any, code: string, token?: string) =>
  worker.fetch(
    new Request(`https://flickto.app/api/share/${code}/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.7",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ reason: "abuse" }),
    }),
    env,
    ctx,
  );

async function newCode(env: any, title?: string, token?: string): Promise<string> {
  return ((await (await create(env, title, token)).json()) as any).code;
}

describe("hidden share links", () => {
  // A takedown that reads differently from an expiry IS a signal — it tells an
  // abuser their link was actioned, and tells anyone else the code was real.
  it("404s from both read paths, with a body identical to an expired link", async () => {
    const env = await makeEnv();
    const live = await newCode(env, "Still here");
    const hiddenCode = await newCode(env, "Taken down");
    const expiredCode = await newCode(env, "Long gone");

    const stored = JSON.parse(env.BUCKET.store.get(`share/${hiddenCode}.json`));
    env.BUCKET.store.set(`share/${hiddenCode}.json`, JSON.stringify({ ...stored, hidden: true }));
    const old = JSON.parse(env.BUCKET.store.get(`share/${expiredCode}.json`));
    env.BUCKET.store.set(
      `share/${expiredCode}.json`,
      JSON.stringify({ ...old, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );

    expect((await fetchShare(env, live)).status).toBe(200);

    const hiddenApi = await fetchShare(env, hiddenCode);
    const expiredApi = await fetchShare(env, expiredCode);
    expect(hiddenApi.status).toBe(404);
    expect(await hiddenApi.text()).toBe(await expiredApi.text());

    const hiddenPage = await landing(env, hiddenCode);
    const expiredPage = await landing(env, expiredCode);
    expect(hiddenPage.status).toBe(404);
    expect(await hiddenPage.text()).toBe(await expiredPage.text());
  });
});

describe("reporting a share link", () => {
  it("hides after N DISTINCT signed-in reporters, and not from one repeating", async () => {
    const solo = await makeEnv("a");
    const code = await newCode(solo);
    for (let i = 0; i < 5; i++) await report(solo, code, "a");
    expect(JSON.parse(solo.BUCKET.store.get(`share/${code}.json`)).hidden).toBeFalsy();
    expect((await fetchShare(solo, code)).status).toBe(200);

    const many = await makeEnv("a", "b", "c");
    const code2 = await newCode(many);
    await report(many, code2, "a");
    await report(many, code2, "b");
    expect(JSON.parse(many.BUCKET.store.get(`share/${code2}.json`)).hidden).toBeFalsy();
    await report(many, code2, "c");
    expect(JSON.parse(many.BUCKET.store.get(`share/${code2}.json`)).hidden).toBe(true);
    expect((await fetchShare(many, code2)).status).toBe(404);
  });

  // THE test that stops the open endpoint becoming a takedown weapon. If this ever
  // goes red, anyone can delete any share link by volume. Do not skip it.
  it("never hides on anonymous reports alone — they only queue for review", async () => {
    const env = await makeEnv();
    const code = await newCode(env);
    for (let i = 0; i < 10; i++) await report(env, code);

    expect(JSON.parse(env.BUCKET.store.get(`share/${code}.json`)).hidden).toBeFalsy();
    expect((await fetchShare(env, code)).status).toBe(200);
    // ...but every one of them is in the admin queue.
    const queued = [...env.BUCKET.store.keys()].filter((k) => k.startsWith(`_reports/${code}/`));
    expect(queued.length).toBeGreaterThan(0);
  });

  it("answers 204 with no session, never 401, and rate-limits an anonymous flood by IP", async () => {
    const env = await makeEnv();
    env.RATE_LIMIT_PER_HOUR = "2";
    const code = await newCode(env);
    expect((await report(env, code)).status).toBe(204);
    expect((await report(env, code)).status).toBe(204);
    expect((await report(env, code)).status).toBe(429);
  });

  // Answering 404 for an unknown code would make this a probe for which codes exist.
  it("is a silent no-op for an unknown code, not a 404 and not a 500", async () => {
    const env = await makeEnv();
    const res = await report(env, "ZZZZZZ");
    expect(res.status).toBe(204);
    expect([...env.BUCKET.store.keys()].some((k) => k.startsWith("_reports/"))).toBe(false);
  });
});

describe("share attribution", () => {
  it("stamps creatorId only when the caller happened to be signed in", async () => {
    const env = await makeEnv("a");
    const anon = await newCode(env, "Anonymous list");
    const owned = await newCode(env, "Signed-in list", "a");

    expect(JSON.parse(env.BUCKET.store.get(`share/${anon}.json`)).creatorId).toBeNull();
    expect(JSON.parse(env.BUCKET.store.get(`share/${owned}.json`)).creatorId).toBe("USER-a");
  });

  // Attribution is for the admin, not for whoever holds the link.
  it("never returns creatorId on the public read", async () => {
    const env = await makeEnv("a");
    const code = await newCode(env, "Signed-in list", "a");
    expect(await (await fetchShare(env, code)).json()).not.toHaveProperty("creatorId");
  });
});
