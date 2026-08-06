import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { handleAdminFeedbackAct, handleAdminFeedbackList, handlePostFeedback } from "./feedback";

// Real SQLite, same harness as `insights.test.ts`: the list endpoint's behaviour IS
// its SQL (the LEFT JOIN that must not drop anonymous rows, the GROUP BY counts), and
// a fake D1 would only test the fake.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = InstanceType<typeof DatabaseSync>;

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../migrations/0025_feedback.sql", import.meta.url)),
  "utf8",
);

class Stmt {
  private args: unknown[] = [];
  constructor(
    private db: DatabaseSync,
    private sql: string,
  ) {}
  bind(...a: unknown[]) {
    this.args = a;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.args as never[])) ?? null) as T | null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}
class D1 {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
}

/** In-memory stand-in for the R2 bucket the rate limiter counts in. */
class Bucket {
  store = new Map<string, string>();
  async get(key: string) {
    const v = this.store.get(key);
    return v == null ? null : { json: async () => JSON.parse(v) };
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

const ME = "AAAAH73X7P55T48R4CFHDED9CW";
const KEY = "admin-key-for-tests";

let raw: DatabaseSync;
let bucket: Bucket;
let env: any;

const post = (body: unknown, ip = "1.2.3.4") =>
  new Request("https://flickto.app/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });

// `null` means "send no key at all". NOT `undefined` — that triggers the default
// parameter, which is how the first draft of these tests sent the real key to the
// cases asserting it was absent, and watched them pass a 200 as a 401.
const list = (query = "", key: string | null = KEY) =>
  new Request(
    `https://flickto.app/api/feedback/admin${query}`,
    key ? { headers: { "X-Admin-Key": key } } : undefined,
  );

const act = (body: unknown, key: string | null = KEY) =>
  new Request("https://flickto.app/api/feedback/admin/act", {
    method: "POST",
    headers: key
      ? { "Content-Type": "application/json", "X-Admin-Key": key }
      : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE profiles (user_id TEXT PRIMARY KEY, display_name TEXT)");
  raw.exec(MIGRATION);
  raw.prepare("INSERT INTO profiles (user_id, display_name) VALUES (?, ?)").run(ME, "Alex");
  bucket = new Bucket();
  env = { DB: new D1(raw), BUCKET: bucket, ADMIN_KEY: KEY, FEEDBACK_PER_HOUR: "5" };
});

const rows = () => raw.prepare("SELECT * FROM feedback").all() as any[];

describe("POST /api/feedback", () => {
  it("stores a submission from a signed-in user", async () => {
    const res = await handlePostFeedback(post({ topic: "bug", message: "Discover hangs" }), env, ME);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].user_id).toBe(ME);
    expect(all[0].topic).toBe("bug");
    expect(all[0].state).toBe("new");
  });

  // The whole point of the optional session: the people most likely to have something
  // to say about sign-in are the ones who cannot get past it.
  it("accepts an anonymous submission and stores a NULL user_id", async () => {
    const res = await handlePostFeedback(post({ topic: "idea", message: "Add widgets" }), env, null);
    expect(res.status).toBe(200);
    expect(rows()[0].user_id).toBeNull();
  });

  it("rejects a topic outside the closed set", async () => {
    const res = await handlePostFeedback(post({ topic: "wat", message: "hi" }), env, ME);
    expect(res.status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it("rejects an empty or whitespace-only message", async () => {
    const res = await handlePostFeedback(post({ topic: "bug", message: "   " }), env, ME);
    expect(res.status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it("truncates an over-long message rather than rejecting it", async () => {
    await handlePostFeedback(post({ topic: "bug", message: "x".repeat(5000) }), env, ME);
    expect(rows()[0].message).toHaveLength(2000);
  });

  it("stores the device context when the form sends it", async () => {
    await handlePostFeedback(
      post({
        topic: "sync",
        message: "Trakt stopped",
        contact: "a@example.com",
        platform: "android",
        appVersion: "1.9.2",
        versionCode: 34,
        device: "Pixel 8",
        osVersion: "15",
        locale: "en-GB",
      }),
      env,
      ME,
    );
    const row = rows()[0];
    expect(row.contact).toBe("a@example.com");
    expect(row.version_code).toBe(34);
    expect(row.device).toBe("Pixel 8");
  });

  it("rate-limits per IP", async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await handlePostFeedback(post({ topic: "bug", message: `m${i}` }), env, ME);
      expect(ok.status).toBe(200);
    }
    const blocked = await handlePostFeedback(post({ topic: "bug", message: "six" }), env, ME);
    expect(blocked.status).toBe(429);
    expect(rows()).toHaveLength(5);
  });

  it("counts the limit per IP, not globally", async () => {
    for (let i = 0; i < 5; i++) {
      await handlePostFeedback(post({ topic: "bug", message: `m${i}` }, "1.1.1.1"), env, ME);
    }
    const other = await handlePostFeedback(post({ topic: "bug", message: "hi" }, "9.9.9.9"), env, ME);
    expect(other.status).toBe(200);
  });
});

describe("GET /api/feedback/admin", () => {
  beforeEach(async () => {
    await handlePostFeedback(post({ topic: "bug", message: "one" }), env, ME);
    await handlePostFeedback(post({ topic: "idea", message: "two" }), env, null);
  });

  it("is closed without the admin key", async () => {
    expect((await handleAdminFeedbackList(list("", null), env)).status).toBe(401);
    expect((await handleAdminFeedbackList(list("", "wrong-key"), env)).status).toBe(401);
  });

  it("is closed when ADMIN_KEY is unset, rather than open", async () => {
    const res = await handleAdminFeedbackList(list(), { ...env, ADMIN_KEY: undefined });
    expect(res.status).toBe(401);
  });

  // The LEFT JOIN is the point: an inner join would drop exactly the submissions that
  // arrived with no account, which is the population this endpoint exists to hear from.
  it("returns the anonymous row alongside the signed-in one", async () => {
    const body = (await (await handleAdminFeedbackList(list("?state=all"), env)).json()) as any;
    expect(body.items).toHaveLength(2);
    const anon = body.items.find((i: any) => i.message === "two");
    const known = body.items.find((i: any) => i.message === "one");
    expect(anon.userId).toBeNull();
    expect(anon.displayName).toBeNull();
    expect(known.displayName).toBe("Alex");
  });

  // Explicit timestamps, because two submissions in one test run land in the same
  // millisecond and `created_at DESC` alone is then a tie with no defined winner.
  it("orders newest first", async () => {
    raw.exec("DELETE FROM feedback");
    for (const [id, at] of [["a", 1000], ["b", 3000], ["c", 2000]] as const) {
      raw
        .prepare("INSERT INTO feedback (id, topic, message, state, created_at) VALUES (?, 'bug', ?, 'new', ?)")
        .run(id, id, at);
    }
    const body = (await (await handleAdminFeedbackList(list("?state=all"), env)).json()) as any;
    expect(body.items.map((i: any) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("filters by topic", async () => {
    const body = (await (await handleAdminFeedbackList(list("?state=all&topic=idea"), env)).json()) as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].topic).toBe("idea");
  });

  // The chips have to show what is behind them across the table, not on this page.
  it("reports counts over the whole table, not the returned page", async () => {
    const body = (await (await handleAdminFeedbackList(list("?state=all&topic=idea"), env)).json()) as any;
    expect(body.counts.states.new).toBe(2);
    expect(body.counts.topics.bug).toBe(1);
    expect(body.counts.topics.idea).toBe(1);
  });
});

describe("POST /api/feedback/admin/act", () => {
  let id: string;
  beforeEach(async () => {
    await handlePostFeedback(post({ topic: "bug", message: "one" }), env, ME);
    id = rows()[0].id;
  });

  it("is closed without the admin key", async () => {
    expect((await handleAdminFeedbackAct(act({ id, state: "closed" }, null), env)).status).toBe(401);
    expect(rows()[0].state).toBe("new");
  });

  it("moves state and stamps updated_at", async () => {
    const res = await handleAdminFeedbackAct(act({ id, state: "triaged" }), env);
    expect(res.status).toBe(200);
    expect(rows()[0].state).toBe("triaged");
    expect(rows()[0].updated_at).toBeGreaterThan(0);
  });

  it("saves a note without touching state", async () => {
    await handleAdminFeedbackAct(act({ id, note: "emailed them" }), env);
    expect(rows()[0].admin_note).toBe("emailed them");
    expect(rows()[0].state).toBe("new");
  });

  it("rejects an unknown state instead of writing it", async () => {
    const res = await handleAdminFeedbackAct(act({ id, state: "banana" }), env);
    expect(res.status).toBe(400);
    expect(rows()[0].state).toBe("new");
  });

  // A 200 for a row that does not exist would let the panel render a state the
  // database never took.
  it("404s an unknown id", async () => {
    const res = await handleAdminFeedbackAct(act({ id: "nope", state: "closed" }), env);
    expect(res.status).toBe(404);
  });
});
