import { describe, it, expect } from "vitest";
import { TestD1, seedUser, seedSession, testEnv, uid } from "./testD1";
import { handlePublishList, handleUnpublishList } from "./publicLists";

const TOKEN = "tok-owner";

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A user with a session, and one list of the given kind holding `items` titles. */
async function withList(db: TestD1, owner: string, kind: string, items = 3, listId = "L1") {
  seedUser(db, { id: owner });
  seedSession(db, owner, await sha256Hex(TOKEN));
  const t = Date.now();
  await db
    .prepare(
      `INSERT INTO lists (user_id, id, name, kind, auto_updated, is_pinned_to_home,
         display_order, home_order, version, created_at, updated_at)
       VALUES (?1, ?2, 'Neo-Noir Essentials', ?3, 0, 0, 0, 0, 1, ?4, ?4)`,
    )
    .bind(owner, listId, kind, t)
    .run();
  for (let i = 0; i < items; i++) {
    await db
      .prepare(
        `INSERT INTO list_items (user_id, list_id, tmdb_id, type, position, added_at, updated_at)
         VALUES (?1, ?2, ?3, 'MOVIE', ?4, ?5, ?5)`,
      )
      .bind(owner, listId, 500 + i, i, t)
      .run();
  }
}

const authed = (url: string, method: string, body?: unknown) =>
  new Request(`https://flickto.app${url}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

/**
 * Public lists, against REAL SQL.
 *
 * The browse query is a JOIN across four tables with two correlated aggregates and a
 * decay expression in the ORDER BY. A string-matching D1 double would prove it was
 * called and nothing about whether it returns the right rows in the right order — so
 * this builds a real SQLite from the real migrations, 0039 included.
 */
describe("migration 0039", () => {
  it("creates the four tables with the documented keys", () => {
    const db = new TestD1();
    const names = db
      .rows<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table'
           AND name IN ('public_lists','public_list_tags','list_follows','public_list_likes')
         ORDER BY name`,
      )
      .map((r) => r.name);
    expect(names).toEqual(["list_follows", "public_list_likes", "public_list_tags", "public_lists"]);
  });

  it("keys public_lists on (owner_id, list_id) so one user's list cannot displace another's", () => {
    const db = new TestD1();
    seedUser(db, { id: uid(1) });
    seedUser(db, { id: uid(2) });
    const ins = (owner: string) =>
      db.one(
        `INSERT INTO public_lists (owner_id, list_id, tags, engagement, published_at, hidden_at)
         VALUES (?, 'watchlist', '[]', 0, 1, NULL)`,
        owner,
      );
    ins(uid(1));
    ins(uid(2));
    const n = db.count("public_lists", "list_id = 'watchlist'");
    expect(n).toBe(2);
  });
});

describe("publishing", () => {
  it("publishes a MANUAL list with its tags", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    const res = await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["neo-noir", "crime"] }),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(200);

    const row = await db
      .prepare(`SELECT tags, engagement, hidden_at FROM public_lists WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .first<{ tags: string; engagement: number; hidden_at: number | null }>();
    expect(JSON.parse(row!.tags)).toEqual(["crime", "neo-noir"]);
    expect(row!.engagement).toBe(0);
    expect(row!.hidden_at).toBeNull();

    const tagRows = await db
      .prepare(`SELECT tag FROM public_list_tags WHERE owner_id = ?1 AND list_id = 'L1' ORDER BY tag`)
      .bind(uid(1))
      .all<{ tag: string }>();
    expect((tagRows.results ?? []).map((r) => r.tag)).toEqual(["crime", "neo-noir"]);
  });

  // The whole point of the restriction. A crafted request must not get past the client.
  it.each(["SMART", "AI_GENERATED", "AWARDS", "COLLECTION_TMDB", "COLLECTION_AI", "BUILTIN_WATCHLIST"])(
    "refuses to publish a %s list",
    async (kind) => {
      const db = new TestD1();
      await withList(db, uid(1), kind);
      const res = await handlePublishList(
        "L1",
        authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
        testEnv(db),
        ctx,
      );
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe("kind_not_publishable");
    },
  );

  it("refuses an empty list — it would publish as a name with no titles", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 0);
    const res = await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("list_empty");
  });

  it("requires at least one valid tag", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    const res = await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["not-a-real-tag"] }),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("tags_required");
  });

  it("cannot publish someone else's list", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");        // owner has the session
    seedUser(db, { id: uid(2) });
    await db                                      // uid(2) owns L2
      .prepare(
        `INSERT INTO lists (user_id, id, name, kind, auto_updated, is_pinned_to_home,
           display_order, home_order, version, created_at, updated_at)
         VALUES (?1, 'L2', 'Theirs', 'MANUAL', 0, 0, 0, 0, 1, 1, 1)`,
      )
      .bind(uid(2))
      .run();
    const res = await handlePublishList(
      "L2",
      authed("/api/me/lists/L2/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("re-publishing replaces the tag rows rather than accumulating them", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    const publish = (tags: string[]) =>
      handlePublishList("L1", authed("/api/me/lists/L1/publish", "POST", { tags }), testEnv(db), ctx);
    await publish(["neo-noir", "crime"]);
    await publish(["horror"]);
    const rows = await db
      .prepare(`SELECT tag FROM public_list_tags WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .all<{ tag: string }>();
    expect((rows.results ?? []).map((r) => r.tag)).toEqual(["horror"]);
  });
});

describe("unpublishing", () => {
  it("removes the directory row and its tags, but never the list itself", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    const res = await handleUnpublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "DELETE"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(200);

    const pub = await db
      .prepare(`SELECT COUNT(*) AS n FROM public_lists WHERE owner_id = ?1`)
      .bind(uid(1))
      .first<{ n: number }>();
    expect(pub!.n).toBe(0);

    const tags = await db
      .prepare(`SELECT COUNT(*) AS n FROM public_list_tags WHERE owner_id = ?1`)
      .bind(uid(1))
      .first<{ n: number }>();
    expect(tags!.n).toBe(0);

    // The author keeps their list. Unpublishing is not deleting.
    const list = await db
      .prepare(`SELECT COUNT(*) AS n FROM lists WHERE user_id = ?1 AND id = 'L1'`)
      .bind(uid(1))
      .first<{ n: number }>();
    expect(list!.n).toBe(1);
  });

  // Followers keeping a frozen copy is the client's job, but it depends on the follow
  // ROW surviving so /api/me/follows can report status "unpublished".
  it("leaves follow rows intact so followers can be told it stopped updating", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    seedUser(db, { id: uid(2) });
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await db
      .prepare(`INSERT INTO list_follows (user_id, owner_id, list_id, created_at) VALUES (?1, ?2, 'L1', 1)`)
      .bind(uid(2), uid(1))
      .run();
    await handleUnpublishList("L1", authed("/api/me/lists/L1/publish", "DELETE"), testEnv(db), ctx);
    const n = await db
      .prepare(`SELECT COUNT(*) AS n FROM list_follows WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
});
