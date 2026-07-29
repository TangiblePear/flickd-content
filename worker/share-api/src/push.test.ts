// Account-keyed push topics.
//
// The property worth pinning hardest is the FALLBACK. A device that has published
// `push.json` to the relay but not yet `/api/me/push` must stay reachable — otherwise
// this migration silently makes every existing install unpushable, and the symptom is
// "things quietly arrive late", which is exactly how the 2026-07-27 tablet bug hid.
//
// The second is that a blank topic CLEARS the column rather than being stored. A
// stored empty string would pass a null check and then fail `FCM_TOPIC_RE`, leaving a
// row that looks published and pushes nothing.

import { describe, it, expect } from "vitest";
import { handlePutMyPush, readAccountPush } from "./push";

const OWNER = "C3VXH73X7P55T48R4CFHDED9CW";
const SESSION_HASH_FOR: Record<string, string> = { "tok-owner": OWNER };

class FakeD1 {
  users: Record<string, any>[] = [];
  sessions = new Map<string, string>();
  prepare(sql: string) {
    const self = this;
    const s = sql.replace(/\s+/g, " ").trim();
    let args: unknown[] = [];
    return {
      bind(...a: unknown[]) {
        args = a;
        return this;
      },
      async first<T>(): Promise<T | null> {
        if (s.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
          const user = self.sessions.get(args[0] as string);
          return user ? ({ user_id: user, expires_at: Date.now() + 86400_000, revoked_at: null } as T) : null;
        }
        if (s.startsWith("SELECT push_self_topic")) {
          const row = self.users.find((u) => u.id === args[0]);
          return row
            ? ({
                push_self_topic: row.push_self_topic ?? null,
                push_friend_topic: row.push_friend_topic ?? null,
                friend_id: row.friend_id ?? null,
              } as T)
            : null;
        }
        throw new Error(`FakeD1: unhandled first() ${s}`);
      },
      async run() {
        if (s.startsWith("UPDATE users SET push_self_topic")) {
          const row = self.users.find((u) => u.id === args[2]);
          if (row) {
            row.push_self_topic = args[0];
            row.push_friend_topic = args[1];
          }
          return { success: true, meta: { changes: row ? 1 : 0 } };
        }
        throw new Error(`FakeD1: unhandled run() ${s}`);
      },
    };
  }
}

const env0 = async () => {
  const env = { DB: new FakeD1(), FIREBASE_PROJECT_ID: "flickto-cf7b6" } as any;
  const enc = new TextEncoder();
  for (const [token, user] of Object.entries(SESSION_HASH_FOR)) {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(token));
    env.DB.sessions.set([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""), user);
  }
  env.DB.users.push({ id: OWNER, friend_id: "FRIENDIDAAAA" });
  return env;
};

const put = (env: any, body: unknown, token = "tok-owner") =>
  handlePutMyPush(
    new Request("https://flickto.app/api/me/push", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );

describe("PUT /api/me/push", () => {
  it("401s without a session", async () => {
    const env = await env0();
    const res = await handlePutMyPush(
      new Request("https://flickto.app/api/me/push", { method: "PUT", body: "{}" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("stores both topics on the account", async () => {
    const env = await env0();
    const res = await put(env, { selfTopic: "s_abc123", friendTopic: "f_abc123" });
    expect(res.status).toBe(200);
    expect(env.DB.users[0].push_self_topic).toBe("s_abc123");
    expect(env.DB.users[0].push_friend_topic).toBe("f_abc123");
  });

  it("rejects a topic FCM would refuse, rather than storing an unusable one", async () => {
    const env = await env0();
    const res = await put(env, { selfTopic: "not a topic!", friendTopic: "f_abc123" });
    expect(res.status).toBe(400);
    expect(env.DB.users[0].push_self_topic).toBeUndefined();
  });

  // A stored "" passes a null check and then fails FCM_TOPIC_RE, leaving a row that
  // looks published and pushes nothing. Blank must mean "clear it".
  it("clears a column when the topic is blank", async () => {
    const env = await env0();
    await put(env, { selfTopic: "s_abc123", friendTopic: "f_abc123" });
    await put(env, { selfTopic: "", friendTopic: "f_abc123" });
    expect(env.DB.users[0].push_self_topic).toBeNull();
    expect(env.DB.users[0].push_friend_topic).toBe("f_abc123");
  });

  it("rejects a malformed body without touching the row", async () => {
    const env = await env0();
    const res = await handlePutMyPush(
      new Request("https://flickto.app/api/me/push", {
        method: "PUT",
        headers: { Authorization: "Bearer tok-owner", "Content-Type": "application/json" },
        body: "not json",
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(env.DB.users[0].push_self_topic).toBeUndefined();
  });
});

describe("readAccountPush", () => {
  it("returns the stored topics and the friendId for the fallback", async () => {
    const env = await env0();
    await put(env, { selfTopic: "s_abc123", friendTopic: "f_abc123" });
    const rec = await readAccountPush(env.DB, OWNER);
    expect(rec).toEqual({ selfTopic: "s_abc123", friendTopic: "f_abc123", friendId: "FRIENDIDAAAA" });
  });

  // ⚠️ The migration's whole risk. An account that has never called /api/me/push must
  // report null TOPICS but still hand back its friendId, so the caller can fall back to
  // the relay record. Collapsing this to "no push" would make every existing install
  // silently unreachable.
  it("reports null topics but still yields the friendId when nothing was published", async () => {
    const env = await env0();
    const rec = await readAccountPush(env.DB, OWNER);
    expect(rec).toEqual({ selfTopic: null, friendTopic: null, friendId: "FRIENDIDAAAA" });
  });

  it("returns null for an unknown account", async () => {
    const env = await env0();
    expect(await readAccountPush(env.DB, "ZZZZZ73X7P55T48R4CFHDED9CW")).toBeNull();
  });

  it("never throws on a D1 error — a push failure must not fail the write that caused it", async () => {
    const broken = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            throw new Error("D1 is down");
          },
        };
      },
    } as unknown as D1Database;
    expect(await readAccountPush(broken, OWNER)).toBeNull();
  });
});
