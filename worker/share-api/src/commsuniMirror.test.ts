import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DRAIN_LIMIT, archiveCreatedAt, identityChoice, mayMirror, mirrorEnabled, mirrorKey } from "./commsuniMirror";

/**
 * The write mirror is the only code here that makes a user's words leave our systems.
 * These tests are about what must NEVER happen, so most of them assert a negative.
 */

describe("the kill switch", () => {
  const base = { COMMSUNI_KEY: "k" } as any;

  it("⚠️ is OFF when the variable is absent", () => {
    // The single most important default in the phase. Publishing user content to a
    // third party before the privacy policy says so is a compliance failure, and
    // "someone forgot to set a variable" must not be the thing that starts it.
    expect(mirrorEnabled(base)).toBe(false);
  });

  it("⚠️ is OFF for every value except exactly \"1\"", () => {
    // Fails CLOSED. A truthiness test would make "0", "false" and "off" all enable it.
    for (const v of ["0", "", "true", "false", "off", "yes", "no", "2", "01"]) {
      expect(mirrorEnabled({ ...base, COMMSUNI_MIRROR: v })).toBe(false);
    }
  });

  it("is on for \"1\", and tolerates surrounding whitespace", () => {
    expect(mirrorEnabled({ ...base, COMMSUNI_MIRROR: "1" })).toBe(true);
    expect(mirrorEnabled({ ...base, COMMSUNI_MIRROR: " 1 " })).toBe(true);
  });

  it("stays off when upstream is not configured at all", () => {
    expect(mirrorEnabled({ COMMSUNI_MIRROR: "1" } as any)).toBe(false);
  });
});

describe("mayMirror — the visibility guard", () => {
  const ok = { id: "c1", author_id: "u1", visibility: "public", body: "hello" };

  it("passes a public, live, non-empty comment", () => {
    expect(mayMirror(ok)).toBe(true);
  });

  it("⚠️ NEVER publishes a friends-only comment", () => {
    // The highest-consequence line in the phase. This comment was written under a
    // promise about who could read it; publishing it is unrecoverable in the way that
    // matters, because the words were already read before any delete could land.
    expect(mayMirror({ ...ok, visibility: "friends" })).toBe(false);
  });

  it("⚠️ treats an UNKNOWN visibility as not-public", () => {
    // Default deny. Compared to the exact string "public" rather than tested for not
    // being "friends", so a visibility value added later is excluded by default
    // instead of silently mirroring the day it ships.
    for (const v of ["private", "unlisted", "followers", "", null, undefined]) {
      expect(mayMirror({ ...ok, visibility: v as any })).toBe(false);
    }
  });

  it("⚠️ refuses a row moderation has already acted on", () => {
    // The queue/drain gap is the whole point: a retry queued before an auto-hide must
    // not republish it afterwards.
    expect(mayMirror({ ...ok, hidden_at: Date.now() })).toBe(false);
    expect(mayMirror({ ...ok, deleted_at: Date.now() })).toBe(false);
  });

  it("⚠️ uses hidden_at, the column that exists", () => {
    // `hidden` is not a column on `comments` (0003 names it `hidden_at`). Reading the
    // wrong name yields undefined — i.e. "not hidden" — so a moderated row would have
    // sailed through this guard. Caught by reading the migration, not the code.
    expect(mayMirror({ ...ok, hidden_at: 1 } as any)).toBe(false);
    expect(mayMirror({ ...(ok as any), hidden: 1 })).toBe(true);
  });

  it("refuses an empty or whitespace-only body, and a missing row", () => {
    expect(mayMirror({ ...ok, body: "   " })).toBe(false);
    expect(mayMirror(null)).toBe(false);
    expect(mayMirror(undefined)).toBe(false);
  });
});

describe("idempotency keys", () => {
  it("are stable for the same action and different across an edit", () => {
    // Reused verbatim on retry so a replay is the original write; different per edit so
    // the second edit is not replayed as the first. `write_units` are charged on the
    // request and not the outcome, so a fresh key per attempt costs real money.
    expect(mirrorKey("c1", 1000)).toBe(mirrorKey("c1", 1000));
    expect(mirrorKey("c1", 1000)).not.toBe(mirrorKey("c1", 1001));
    expect(mirrorKey("c1", 1000)).not.toBe(mirrorKey("c2", 1000));
  });
});

describe("the drain bound", () => {
  it("⚠️ is 5, well inside the 50-subrequest cap", () => {
    // Not a tuning knob. The drain rides someone else's request and each item is an
    // outbound subrequest; an unbounded drain of a 40-item backlog would blow the cap
    // and take down whatever request happened to trigger it.
    expect(DRAIN_LIMIT).toBe(5);
    expect(DRAIN_LIMIT).toBeLessThanOrEqual(10);
  });
});

describe("author identity", () => {
  const envWith = (row: unknown) =>
    ({
      DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
    }) as any;

  it("⚠️ returns null for never-asked, NOT false", async () => {
    // The distinction carries the whole feature. Both publish anonymously, but
    // "never asked" must still be prompted and "declined" must never be prompted
    // again. Collapsing them either nags someone who said no, or lets silence pass
    // for consent to putting their name in other apps.
    expect(await identityChoice(envWith(null), "u1")).toBe(null);
    expect(await identityChoice(envWith({ shares: 0 }), "u1")).toBe(false);
    expect(await identityChoice(envWith({ shares: 1 }), "u1")).toBe(true);
  });

  it("treats a database failure as never-asked rather than as consent", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("d1 down"); } }) }) } } as any;
    expect(await identityChoice(env, "u1")).toBe(null);
  });
});

describe("archiveCreatedAt", () => {
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);

  it("formats as ISO 8601 with an explicit Z", () => {
    // ⚠️ Naive datetimes are REJECTED by the archive, so the trailing Z is load-bearing.
    const out = archiveCreatedAt(Date.UTC(2020, 4, 18, 21, 4, 11), now);
    expect(out).toBe("2020-05-18T21:04:11.000Z");
    expect(out!.endsWith("Z")).toBe(true);
  });

  it("⚠️ omits rather than sends anything outside the accepted window", () => {
    // Both bounds are the archive's. Ours is a server clock so neither should ever
    // trip — which is why they are checked: an out-of-range value is a 400, a 400 is
    // not retryable, and the outbox would drop the comment silently instead of
    // retrying it. Omitting the field is always legal; guessing is not.
    expect(archiveCreatedAt(Date.UTC(2009, 11, 31), now)).toBe(null);
    expect(archiveCreatedAt(now + 6 * 60_000, now)).toBe(null);
    // Just inside each bound still sends.
    expect(archiveCreatedAt(Date.UTC(2010, 0, 1), now)).not.toBe(null);
    expect(archiveCreatedAt(now + 60_000, now)).not.toBe(null);
  });

  it("omits for a missing or nonsense value rather than sending an epoch date", () => {
    // A null created_at must not become 1970-01-01, which would be a plausible-looking
    // lie about when someone wrote something.
    expect(archiveCreatedAt(null, now)).toBe(null);
    expect(archiveCreatedAt(undefined, now)).toBe(null);
    expect(archiveCreatedAt(NaN, now)).toBe(null);
    expect(archiveCreatedAt(0, now)).toBe(null);
  });
});
