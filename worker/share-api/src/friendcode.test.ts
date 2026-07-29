import { describe, it, expect } from "vitest";
import worker from "./index";

/**
 * `POST /api/friendcode` after the code moved onto the account (step 4).
 *
 * **The one thing that must never happen is minting a new code for someone who
 * already has one.** The code is printed on QR codes, pasted into messages and
 * written down; replacing it breaks every one of those silently, and the user finds
 * out when a friend says the code does not work. Nothing else in this file matters
 * as much as `preserves`, and both of its cases — already in D1, and still only in
 * the legacy R2 pointer — have to hold.
 *
 * Driven through `worker.fetch` rather than the handler, because the handler is
 * private to index.ts and the route wiring is half of what is being changed.
 */

const USER = "D0KNW3BZ0P1MZVN74375PQSW94";
const FRIEND = "5TSDPTZP97CW0V0TBX";
const TOKEN = "session-token";
/** sha256("session-token"), which is what `resolveSession` looks the row up by. */
const TOKEN_HASH = "d3a4f2f0e30a0c5f0a4d3d6a1e1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c";

interface Row {
  friend_id: string | null;
  friend_code: string | null;
}

class FakeD1 {
  sql = "";
  args: unknown[] = [];
  constructor(public user: Row) {}
  prepare(sql: string) {
    this.sql = sql;
    return this;
  }
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      // Any hash resolves: the bearer is present or it is not, and which token it was
      // is not what these tests are about.
      return { user_id: USER, expires_at: Date.now() + 60_000, revoked_at: null } as T;
    }
    if (this.sql.startsWith("SELECT friend_id, friend_code FROM users")) return { ...this.user } as T;
    return null;
  }
  async run() {
    if (this.sql.startsWith("UPDATE users SET friend_code")) {
      this.user.friend_code = this.args[0] as string;
    }
    return { success: true, meta: { changes: 1 } };
  }
  async all() {
    return { results: [] };
  }
  async batch(stmts: unknown[]) {
    return stmts.map(() => ({ success: true, meta: { changes: 0 } }));
  }
}

class FakeBucket {
  store = new Map<string, string>();
  async get(k: string) {
    const v = this.store.get(k);
    // `json()` as well as `text()`: getJson swallows a throw and returns null, so a
    // fake missing it reads exactly like "no legacy pointer" and the mint path runs.
    return v === undefined ? null : { text: async () => v, json: async () => JSON.parse(v), body: v, httpMetadata: {} };
  }
  async put(k: string, v: string) {
    this.store.set(k, typeof v === "string" ? v : String(v));
  }
  async head(k: string) {
    return this.store.has(k) ? {} : null;
  }
  async delete(k: string) {
    this.store.delete(k);
  }
  async list() {
    return { objects: [], delimitedPrefixes: [], truncated: false, cursor: undefined };
  }
}

const card = {
  friendId: FRIEND,
  publicKeyset: "keyset",
  feedReadToken: "rt",
  displayName: "Enes",
};

const publish = (db: FakeD1, bucket: FakeBucket, body: unknown = card) =>
  worker.fetch(
    new Request("https://flickto.app/api/friendcode", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
    { DB: db, BUCKET: bucket, FIREBASE_PROJECT_ID: "flickto-cf7b6" } as any,
    { waitUntil: () => {} } as any,
  );

describe("friend code on the account", () => {
  it("preserves a code already stored on the account", async () => {
    const db = new FakeD1({ friend_id: FRIEND, friend_code: "OLDCODE" });
    const res = await publish(db, new FakeBucket());

    expect(res.status).toBe(200);
    expect(((await res.json()) as any).code).toBe("OLDCODE");
  });

  /**
   * The migration case, and the one a backfill job would have had to get right. The
   * account has no `friend_code` yet, so the value has to come off the legacy R2
   * pointer rather than the mint — and be adopted into D1 so the next publish is a
   * single lookup.
   */
  it("adopts the legacy R2 code instead of minting a new one", async () => {
    const db = new FakeD1({ friend_id: FRIEND, friend_code: null });
    const bucket = new FakeBucket();
    bucket.store.set(`${FRIEND}/friendcode.json`, JSON.stringify({ c: "LEGACY1" }));

    const res = await publish(db, bucket);

    expect(((await res.json()) as any).code).toBe("LEGACY1");
    expect(db.user.friend_code).toBe("LEGACY1");
    expect(bucket.store.has("fc/LEGACY1.json")).toBe(true);
  });

  it("mints only when the account has no code anywhere", async () => {
    const db = new FakeD1({ friend_id: FRIEND, friend_code: null });
    const res = await publish(db, new FakeBucket());

    const code = ((await res.json()) as any).code;
    expect(code).toMatch(/^[A-Z0-9]{6,12}$/);
    expect(db.user.friend_code).toBe(code);
  });

  /**
   * `resolveCardOwner` trusts `serverUserId` to address a match request, and the card
   * is client-written — so a body naming someone else's account would have pointed
   * everyone who scanned this code at them. Stamping it from the session is only
   * possible because the endpoint is session-authed now.
   */
  it("stamps serverUserId from the session, ignoring the body", async () => {
    const db = new FakeD1({ friend_id: FRIEND, friend_code: "OLDCODE" });
    const bucket = new FakeBucket();

    await publish(db, bucket, { ...card, serverUserId: "C3VXH73X7P55T48R4CFHDED9CW" });

    expect(JSON.parse(bucket.store.get("fc/OLDCODE.json")!).serverUserId).toBe(USER);
  });

  it("refuses an unauthenticated publish", async () => {
    const res = await worker.fetch(
      new Request("https://flickto.app/api/friendcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(card),
      }),
      { DB: new FakeD1({ friend_id: FRIEND, friend_code: null }), BUCKET: new FakeBucket() } as any,
      { waitUntil: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });
});

// Silence the unused-constant lint without pretending the hash is checked.
void TOKEN_HASH;
