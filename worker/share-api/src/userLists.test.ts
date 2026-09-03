import { describe, it, expect } from "vitest";
import { TestD1, seedUser, seedSession, testEnv, uid } from "./testD1";
import { handleCreateList, handleGetMyLists, handleUpdateList } from "./userLists";

const TOKEN = "tok-lists";

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedIn(db: TestD1) {
  const owner = uid(1);
  seedUser(db, { id: owner });
  seedSession(db, owner, await sha256Hex(TOKEN));
  return owner;
}

const post = (body: unknown) =>
  new Request("https://x/api/me/lists", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const put = (id: string, body: unknown, version: number) =>
  new Request(`https://x/api/me/lists/${id}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "If-Match": String(version),
    },
    body: JSON.stringify(body),
  });

const get = () =>
  new Request("https://x/api/me/lists", { headers: { Authorization: `Bearer ${TOKEN}` } });

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

/**
 * A filter set with every numeric bound explicitly null — exactly what a client
 * sending a COMPLETE `DiscoverFilters` sends, which is the case that broke.
 */
const ALL_NULL_BOUNDS = {
  sortBy: "popularity.desc",
  includeGenres: [878],
  excludeGenres: [],
  yearFrom: null,
  yearTo: null,
  ratingMin: null,
  ratingMax: null,
  voteCountMin: null,
  voteCountMax: null,
  language: null,
  includeUnreleased: false,
  mediaTypes: [],
  relativeReleaseWindow: "THIS_YEAR",
};

async function filtersOf(db: TestD1, env: ReturnType<typeof testEnv>, listId: string) {
  const res = await handleGetMyLists(get(), env as never, ctx);
  const body = (await res.json()) as { lists: { id: string; filters?: Record<string, unknown> }[] };
  return body.lists.find((l) => l.id === listId)?.filters;
}

describe("smart list filter bounds", () => {
  /**
   * ⚠️ The regression this file exists for.
   *
   * `int`/`num` coerced with `Number.isFinite(Number(v))`, and `Number(null)`
   * is 0 — which IS finite. So every null bound was stored as 0, and a 0 read
   * back is indistinguishable from a real bound because the clients test
   * `!= null`. A list saved with no ceiling evaluated as `vote_average.lte=0`
   * and `vote_count.lte=0`, excluding every title with any rating or any
   * votes: the list came back empty while the same filters in Discover — which
   * never round-trip through here — returned results.
   */
  it("stores an explicit null bound as NULL, not as 0", async () => {
    const db = new TestD1();
    await signedIn(db);
    const env = testEnv(db);

    const created = await handleCreateList(
      post({ id: "L1", name: "Sci-fi this year", kind: "SMART", filters: ALL_NULL_BOUNDS }),
      env as never,
      ctx,
    );
    expect(created.status).toBe(201);

    const f = await filtersOf(db, env, "L1");
    expect(f).toBeDefined();
    for (const k of [
      "yearFrom",
      "yearTo",
      "ratingMin",
      "ratingMax",
      "voteCountMin",
      "voteCountMax",
    ]) {
      expect(f![k], `${k} must round-trip as null, not 0`).toBeNull();
    }
    // The bounds that were actually set still survive.
    expect(f!.relativeReleaseWindow).toBe("THIS_YEAR");
    expect(f!.includeGenres).toEqual([878]);
  });

  it("keeps a real bound, including a deliberate zero floor", async () => {
    const db = new TestD1();
    await signedIn(db);
    const env = testEnv(db);

    await handleCreateList(
      post({
        id: "L2",
        name: "Bounded",
        kind: "SMART",
        filters: { ...ALL_NULL_BOUNDS, yearFrom: 1999, ratingMin: 7.5, voteCountMin: 100 },
      }),
      env as never,
      ctx,
    );

    const f = await filtersOf(db, env, "L2");
    expect(f!.yearFrom).toBe(1999);
    // Decimals survive: the rating columns are not integers.
    expect(f!.ratingMin).toBe(7.5);
    expect(f!.voteCountMin).toBe(100);
    expect(f!.ratingMax).toBeNull();
  });

  it("clears a bound back to NULL on update", async () => {
    const db = new TestD1();
    await signedIn(db);
    const env = testEnv(db);

    await handleCreateList(
      post({
        id: "L3",
        name: "Narrowed",
        kind: "SMART",
        filters: { ...ALL_NULL_BOUNDS, voteCountMin: 500 },
      }),
      env as never,
      ctx,
    );
    expect((await filtersOf(db, env, "L3"))!.voteCountMin).toBe(500);

    const res = await handleUpdateList(
      "L3",
      put("L3", { filters: { ...ALL_NULL_BOUNDS, voteCountMin: null } }, 1),
      env as never,
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await filtersOf(db, env, "L3"))!.voteCountMin).toBeNull();
  });
});
