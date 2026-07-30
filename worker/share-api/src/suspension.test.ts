// The posting guard.
//
// Two properties are worth pinning because neither is obvious from the call sites:
// that an expired suspension needs no manual clearing step, and that a D1 failure
// fails OPEN. A lookup error blocking every post in the product would be a far worse
// outage than a suspended person getting one comment through.

import { describe, it, expect } from "vitest";
import {
  PERMANENT_UNTIL,
  postingSuspendedUntil,
  suspendedBody,
  suspensionUntil,
} from "./suspension";

const A = "AAAAH73X7P55T48R4CFHDED9CW";
const DAY = 86_400_000;

/** Answers the two SELECTs in suspension.ts and nothing else. */
class FakeD1 {
  users: { id: string; friend_id: string | null; posting_suspended_until: number | null }[] = [];
  throws = false;
  prepare(sql: string) {
    const self = this;
    let args: unknown[] = [];
    return {
      bind(...a: unknown[]) {
        args = a;
        return this;
      },
      async first<T>(): Promise<T | null> {
        if (self.throws) throw new Error("D1 is down");
        const byFriend = sql.includes("friend_id = ?");
        const row = self.users.find((u) => (byFriend ? u.friend_id === args[0] : u.id === args[0]));
        return row ? ({ until: row.posting_suspended_until } as T) : null;
      },
    };
  }
}

const db = (rows: FakeD1["users"], throws = false) => {
  const d = new FakeD1();
  d.users = rows;
  d.throws = throws;
  return d as unknown as D1Database;
};

describe("suspensionUntil", () => {
  it("turns a duration into an absolute deadline", () => {
    const before = Date.now();
    const until = suspensionUntil(DAY)!;
    expect(until).toBeGreaterThanOrEqual(before + DAY);
    expect(until).toBeLessThan(before + DAY + 5_000);
  });

  it("maps 0 to the permanent sentinel rather than to 'already expired'", () => {
    expect(suspensionUntil(0)).toBe(PERMANENT_UNTIL);
  });

  it("rejects a duration that is not one of the four presets", () => {
    expect(suspensionUntil(1234)).toBeNull();
    expect(suspensionUntil(-1)).toBeNull();
  });
});

describe("postingSuspendedUntil", () => {
  it("returns 0 for an unsuspended user", async () => {
    const d = db([{ id: A, friend_id: null, posting_suspended_until: null }]);
    expect(await postingSuspendedUntil(d, A)).toBe(0);
  });

  it("returns the deadline for a live suspension", async () => {
    const until = Date.now() + DAY;
    const d = db([{ id: A, friend_id: null, posting_suspended_until: until }]);
    expect(await postingSuspendedUntil(d, A)).toBe(until);
  });

  // No cron clears these, and none is needed: the comparison is against now, so the
  // suspension simply stops biting. A sweep would be a second mechanism to keep correct.
  it("treats an elapsed suspension as no suspension, with no manual step", async () => {
    const d = db([{ id: A, friend_id: null, posting_suspended_until: Date.now() - 1_000 }]);
    expect(await postingSuspendedUntil(d, A)).toBe(0);
  });

  it("returns 0 for an unknown user", async () => {
    expect(await postingSuspendedUntil(db([]), A)).toBe(0);
  });

  // ⚠️ Fails OPEN. If this threw or returned "suspended", one D1 blip would stop every
  // comment, every photo and every bio edit in the product.
  it("fails open when D1 throws", async () => {
    const d = db([{ id: A, friend_id: null, posting_suspended_until: PERMANENT_UNTIL }], true);
    expect(await postingSuspendedUntil(d, A)).toBe(0);
  });
});

describe("suspendedBody", () => {
  it("names the error so the client can branch on it, and carries the deadline", () => {
    expect(suspendedBody(123)).toEqual({ error: "posting_suspended", until: 123 });
  });
});
