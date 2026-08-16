import { describe, it, expect } from "vitest";
import { TestD1, seedUser, seedSession, testEnv, uid } from "./testD1";
import {
  handlePublishList,
  handleUnpublishList,
  handleFollow,
  handleLike,
  handleBrowse,
  handleMyFollows,
  handleMyPublishedLists,
  handlePublicListDetail,
  handleReportPublicList,
  MAX_FOLLOWS,
  MAX_PUBLISHED_PER_USER,
} from "./publicLists";
import { handleModerationAct } from "./moderationQueue";
import { eraseAccount, MAX_ERASURE_RECOMPUTE } from "./friends";
import { handleDeleteList } from "./userLists";

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

  // handleUnpublishList deliberately keeps `list_follows`/`public_list_likes` so a
  // follower can be told "unpublished" — but that means those rows are still there
  // when the author republishes, and the fresh INSERT sets engagement = 0. Without a
  // recompute here, a 30-save list comes back ranked at zero and stays there forever:
  // nothing in this worker recomputes it until someone follows or likes again.
  it("republishing recomputes engagement from the surviving follows and likes, not zero", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await withViewer(db, uid(3), "tok-3");
    const url = `/api/public/lists/${uid(1)}/L1`;
    await handleFollow(uid(1), "L1", asUser("tok-2", `${url}/follow`, "POST"), testEnv(db), ctx);
    await handleFollow(uid(1), "L1", asUser("tok-3", `${url}/follow`, "POST"), testEnv(db), ctx);
    await handleLike(uid(1), "L1", asUser("tok-2", `${url}/like`, "POST"), testEnv(db), ctx);

    await handleUnpublishList("L1", authed("/api/me/lists/L1/publish", "DELETE"), testEnv(db), ctx);
    const republish = await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    expect(republish.status).toBe(200);

    const row = await db
      .prepare(`SELECT engagement FROM public_lists WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .first<{ engagement: number }>();
    // 2 follows * 3 + 1 like * 1 = 7.
    expect(row!.engagement).toBe(7);
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

  // The evasion: an admin takedown must survive an unpublish/republish cycle, or the
  // author can clear it themselves with two taps. The `reports` row that justified the
  // takedown is the only thing that survives the DELETE in handleUnpublishList, so it
  // is what handlePublishList has to check.
  it("does not let an author clear an admin takedown by unpublishing and republishing", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "L1", asUser("tok-2", `/api/public/lists/${uid(1)}/L1/follow`, "POST"), testEnv(db), ctx);

    // A report is filed, then an admin hides the list from the moderation queue —
    // the real path, not a raw UPDATE.
    await handleReportPublicList(
      uid(1),
      "L1",
      new Request(`https://flickto.app/api/public/lists/${uid(1)}/L1/report`, {
        method: "POST",
        headers: { Authorization: "Bearer tok-2", "Content-Type": "application/json" },
        body: JSON.stringify({ context: "spam" }),
      }),
      testEnv(db),
      ctx,
    );
    const actRes = await handleModerationAct(
      new Request("https://flickto.app/api/moderation/act", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Key": "test-admin-key" },
        body: JSON.stringify({ itemId: `${uid(1)}:L1:public_list`, source: "d1", action: "hide" }),
      }),
      testEnv(db) as never,
    );
    expect(actRes.status).toBe(200);

    // The author unpublishes and republishes, trying to wash the takedown off.
    await handleUnpublishList("L1", authed("/api/me/lists/L1/publish", "DELETE"), testEnv(db), ctx);
    const republish = await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    expect(republish.status).toBe(200);

    // Must not reappear in the directory or on its own detail page.
    expect(await browseAs(db, "tok-2")).toHaveLength(0);
    const detail = await handlePublicListDetail(
      uid(1),
      "L1",
      asUser("tok-2", `/api/public/lists/${uid(1)}/L1`, "GET"),
      testEnv(db),
      ctx,
    );
    expect(detail.status).toBe(404);

    // And the follower must still see it as an ordinary "unpublished", never anything
    // that would tell them a takedown happened.
    const [f] = await followsFor(db, "tok-2");
    expect(f.status).toBe("unpublished");
  });
});

/** A second user with their own bearer token. */
async function withViewer(db: TestD1, id: string, token: string) {
  seedUser(db, { id });
  seedSession(db, id, await sha256Hex(token));
}

const asUser = (token: string, url: string, method: string) =>
  new Request(`https://flickto.app${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });

describe("follow and like", () => {
  it("engagement weights a follow at 3 and a like at 1", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    const url = `/api/public/lists/${uid(1)}/L1`;

    await handleFollow(uid(1), "L1", asUser("tok-2", `${url}/follow`, "POST"), testEnv(db), ctx);
    let row = await db
      .prepare(`SELECT engagement FROM public_lists WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .first<{ engagement: number }>();
    expect(row!.engagement).toBe(3);

    await handleLike(uid(1), "L1", asUser("tok-2", `${url}/like`, "POST"), testEnv(db), ctx);
    row = await db
      .prepare(`SELECT engagement FROM public_lists WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .first<{ engagement: number }>();
    expect(row!.engagement).toBe(4);
  });

  it("unfollowing takes the weight back off", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    const url = `/api/public/lists/${uid(1)}/L1/follow`;
    await handleFollow(uid(1), "L1", asUser("tok-2", url, "POST"), testEnv(db), ctx);
    await handleFollow(uid(1), "L1", asUser("tok-2", url, "DELETE"), testEnv(db), ctx);
    const row = await db
      .prepare(`SELECT engagement FROM public_lists WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .first<{ engagement: number }>();
    expect(row!.engagement).toBe(0);
  });

  // A removal can only ever reduce what someone has, so it must stay possible even
  // once a block exists — unlike the add path, which liveList correctly still gates.
  // Before the fix, toggleEngagement's liveList check ran unconditionally on BOTH the
  // insert and delete paths, so a block created after a follow left that follow row
  // stuck forever: the follower could never unfollow, and the engagement weight it
  // added was permanently uncollectable.
  it("a blocked user can still unfollow a list they already followed", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    const url = `/api/public/lists/${uid(1)}/L1/follow`;
    await handleFollow(uid(1), "L1", asUser("tok-2", url, "POST"), testEnv(db), ctx);

    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(1), uid(2))
      .run();

    const res = await handleFollow(uid(1), "L1", asUser("tok-2", url, "DELETE"), testEnv(db), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()) as { active: boolean }).toEqual({ ok: true, active: false });
    expect(db.count("list_follows", "user_id = ? AND owner_id = ? AND list_id = 'L1'", uid(2), uid(1))).toBe(0);

    // recomputeEngagement must still have run on the removal.
    const row = await db
      .prepare(`SELECT engagement FROM public_lists WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .first<{ engagement: number }>();
    expect(row!.engagement).toBe(0);
  });

  // The natural key does the work; a double tap must not count twice.
  it("following twice is idempotent", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    const url = `/api/public/lists/${uid(1)}/L1/follow`;
    await handleFollow(uid(1), "L1", asUser("tok-2", url, "POST"), testEnv(db), ctx);
    await handleFollow(uid(1), "L1", asUser("tok-2", url, "POST"), testEnv(db), ctx);
    const row = await db
      .prepare(`SELECT engagement FROM public_lists WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .first<{ engagement: number }>();
    expect(row!.engagement).toBe(3);
  });

  it("cannot follow a list that is not published", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");   // never published
    await withViewer(db, uid(2), "tok-2");
    const res = await handleFollow(
      uid(1),
      "L1",
      asUser("tok-2", `/api/public/lists/${uid(1)}/L1/follow`, "POST"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  // The privacy leak: `liveList` (the follow/like precondition) did not check
  // `blocks` at all, so a user the author blocked could still follow — and then
  // read the list's name, description and every item back through
  // `/api/me/follows`, all content `handlePublicListDetail` correctly 404s for.
  it("cannot follow a list whose author blocked the viewer", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(1), uid(2))
      .run();
    const res = await handleFollow(
      uid(1),
      "L1",
      asUser("tok-2", `/api/public/lists/${uid(1)}/L1/follow`, "POST"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  // The other direction: the viewer did the blocking.
  it("cannot follow a list whose author the viewer blocked", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(2), uid(1))
      .run();
    const res = await handleFollow(
      uid(1),
      "L1",
      asUser("tok-2", `/api/public/lists/${uid(1)}/L1/follow`, "POST"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("cannot like a list whose author blocked the viewer", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(1), uid(2))
      .run();
    const res = await handleLike(
      uid(1),
      "L1",
      asUser("tok-2", `/api/public/lists/${uid(1)}/L1/like`, "POST"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("cannot follow a hidden list", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await db
      .prepare(`UPDATE public_lists SET hidden_at = 1 WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .run();
    await withViewer(db, uid(2), "tok-2");
    const res = await handleFollow(
      uid(1),
      "L1",
      asUser("tok-2", `/api/public/lists/${uid(1)}/L1/follow`, "POST"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  // Seeded with SQL, not 100 handler calls — the point is the cap arithmetic, not the
  // write path, and 100 round trips through handleFollow would only slow this down.
  async function withViewerAtCap(db: TestD1, viewer: string, targetOwner: string, targetList: string) {
    await withViewer(db, viewer, "tok-2");
    // One of the MAX_FOLLOWS rows IS the target — the viewer already follows it.
    db.exec(
      `INSERT INTO list_follows (user_id, owner_id, list_id, created_at)
       VALUES ('${viewer}', '${targetOwner}', '${targetList}', 1)`,
    );
    for (let i = 1; i < MAX_FOLLOWS; i++) {
      db.exec(
        `INSERT INTO list_follows (user_id, owner_id, list_id, created_at)
         VALUES ('${viewer}', 'filler-owner-${i}', 'filler-list-${i}', 1)`,
      );
    }
  }

  // The defect: counting ALL of the viewer's follows — including the row this very
  // request would (no-op) write — made a re-follow at the cap indistinguishable from a
  // genuinely new 101st follow. Re-following something already followed must never fail.
  it("re-following at the cap is a no-op, not a 409", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewerAtCap(db, uid(2), uid(1), "L1");
    expect(db.count("list_follows", "user_id = ?", uid(2))).toBe(MAX_FOLLOWS);

    const res = await handleFollow(
      uid(1),
      "L1",
      asUser("tok-2", `/api/public/lists/${uid(1)}/L1/follow`, "POST"),
      testEnv(db),
      ctx,
    );
    expect(res.status).not.toBe(409);
    expect(res.status).toBe(200);
  });

  // The cap itself still has to bite: a genuinely new list is a genuinely new row, and
  // the exclusion in the fix above must not let it slip through.
  it("still refuses a genuinely new follow at the cap", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "L2");
    await handlePublishList(
      "L2",
      authed("/api/me/lists/L2/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    // At the cap on lists that do NOT include L2.
    await withViewer(db, uid(2), "tok-2");
    for (let i = 0; i < MAX_FOLLOWS; i++) {
      db.exec(
        `INSERT INTO list_follows (user_id, owner_id, list_id, created_at)
         VALUES ('${uid(2)}', 'filler-owner-${i}', 'filler-list-${i}', 1)`,
      );
    }

    const res = await handleFollow(
      uid(1),
      "L2",
      asUser("tok-2", `/api/public/lists/${uid(1)}/L2/follow`, "POST"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "too_many_follows" });
  });
});

interface Card {
  ownerId: string;
  listId: string;
  name: string;
  tags: string[];
  saves: number;
  likes: number;
  saved: boolean;
  liked: boolean;
  posters: { tmdbId: number; type: string }[];
  matchedTitle: boolean;
}

/** Publish `listId` owned by `owner`, `ageDays` old, with the given tags. */
async function publishAged(
  db: TestD1,
  owner: string,
  listId: string,
  tags: string[],
  ageDays: number,
) {
  await db
    .prepare(
      `INSERT INTO public_lists (owner_id, list_id, tags, engagement, published_at, hidden_at)
       VALUES (?1, ?2, ?3, 0, ?4, NULL)`,
    )
    .bind(owner, listId, JSON.stringify(tags), Date.now() - ageDays * 86_400_000)
    .run();
  for (const tag of tags) {
    await db
      .prepare(`INSERT INTO public_list_tags (tag, owner_id, list_id) VALUES (?1, ?2, ?3)`)
      .bind(tag, owner, listId)
      .run();
  }
}

async function browseAs(db: TestD1, token: string, query = ""): Promise<Card[]> {
  const res = await handleBrowse(
    asUser(token, `/api/public/lists${query}`, "GET"),
    testEnv(db),
    ctx,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { lists: Card[] }).lists;
}

describe("browse", () => {
  // Decay order and recency order are made to DISAGREE here on purpose. If
  // `sort=trending` silently fell through to plain `published_at DESC`, this would
  // pick NEW first (it is more recent) instead of OLD — so this test only passes if
  // the decay expression is actually driving the order.
  it("decays: the correct trending winner is the OLDER list, against plain recency", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "OLD");
    await db
      .prepare(
        `INSERT INTO lists (user_id, id, name, kind, auto_updated, is_pinned_to_home,
           display_order, home_order, version, created_at, updated_at)
         VALUES (?1, 'NEW', 'Fresh Picks', 'MANUAL', 0, 0, 0, 0, 1, 1, 1)`,
      )
      .bind(uid(1))
      .run();
    await db
      .prepare(
        `INSERT INTO list_items (user_id, list_id, tmdb_id, type, position, added_at, updated_at)
         VALUES (?1, 'NEW', 99, 'MOVIE', 0, 1, 1)`,
      )
      .bind(uid(1))
      .run();

    await publishAged(db, uid(1), "OLD", ["crime"], 8);
    await publishAged(db, uid(1), "NEW", ["crime"], 0);
    // engagement / (age_days + 2):
    //   OLD: 50 / (8 + 2) = 5.0
    //   NEW:  6 / (0 + 2) = 3.0
    // OLD wins on decay even though NEW is more recent — plain `published_at DESC`
    // would put NEW first, so the two orderings disagree.
    await db.prepare(`UPDATE public_lists SET engagement = 50 WHERE list_id = 'OLD'`).run();
    await db.prepare(`UPDATE public_lists SET engagement = 6 WHERE list_id = 'NEW'`).run();

    await withViewer(db, uid(2), "tok-2");
    const cards = await browseAs(db, "tok-2", "?sort=trending");
    expect(cards.map((c) => c.listId)).toEqual(["OLD", "NEW"]);
  });

  // 'crime' is a SUBSTRING of 'true-crime' — the exact pair migration 0039's header
  // cites as why `WHERE tags LIKE '%crime%'` is wrong (it "matches `horror-comedy`").
  // A wrong substring implementation would return both lists here; only an exact
  // match on the join table returns just A.
  it("filters by tag exactly — 'crime' must not match 'true-crime' via a substring", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");
    await db
      .prepare(
        `INSERT INTO lists (user_id, id, name, kind, auto_updated, is_pinned_to_home,
           display_order, home_order, version, created_at, updated_at)
         VALUES (?1, 'B', 'True Crime Docs', 'MANUAL', 0, 0, 0, 0, 1, 1, 1)`,
      )
      .bind(uid(1))
      .run();
    await db
      .prepare(
        `INSERT INTO list_items (user_id, list_id, tmdb_id, type, position, added_at, updated_at)
         VALUES (?1, 'B', 7, 'MOVIE', 0, 1, 1)`,
      )
      .bind(uid(1))
      .run();
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await publishAged(db, uid(1), "B", ["true-crime"], 1);

    await withViewer(db, uid(2), "tok-2");
    const cards = await browseAs(db, "tok-2", "?tag=crime");
    expect(cards.map((c) => c.listId)).toEqual(["A"]);
  });

  it("hides a list from someone the author blocked", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");

    expect(await browseAs(db, "tok-2")).toHaveLength(1);

    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(1), uid(2))
      .run();
    expect(await browseAs(db, "tok-2")).toHaveLength(0);
  });

  // The other direction: the VIEWER did the blocking. Both directions are checked in
  // the query's NOT EXISTS clause, and each needs its own row — one proves the
  // other's OR arm did nothing by accident.
  it("hides a list from an author the viewer blocked", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");

    expect(await browseAs(db, "tok-2")).toHaveLength(1);

    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(2), uid(1))
      .run();
    expect(await browseAs(db, "tok-2")).toHaveLength(0);
  });

  it("omits hidden lists", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await db.prepare(`UPDATE public_lists SET hidden_at = 1 WHERE list_id = 'A'`).run();
    await withViewer(db, uid(2), "tok-2");
    expect(await browseAs(db, "tok-2")).toHaveLength(0);
  });

  it("counts come from the rows, and reflect the viewer's own state", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");
    await withViewer(db, uid(3), "tok-3");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x/follow", "POST"), testEnv(db), ctx);
    await handleFollow(uid(1), "A", asUser("tok-3", "/x/follow", "POST"), testEnv(db), ctx);
    await handleLike(uid(1), "A", asUser("tok-3", "/x/like", "POST"), testEnv(db), ctx);

    const [card] = await browseAs(db, "tok-2");
    expect(card.saves).toBe(2);
    expect(card.likes).toBe(1);
    expect(card.saved).toBe(true);   // uid(2) followed
    expect(card.liked).toBe(false);  // uid(2) did not like
  });

  // Positions are append-only and sparse: `list_items.position` is assigned as
  // COALESCE(MAX(position), -1) + 1 and a removal is a plain delete with no
  // renumbering (Android Daos.kt:1753, CustomListsRepository.kt:300). A list whose
  // first four items were removed has every surviving position >= 4, and posters
  // must still be the top four BY RANK, not the rows whose absolute position happens
  // to be under CARD_POSTERS.
  it("returns posters ranked by position even when every surviving item has position >= 4", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 6, "A"); // positions 0..5, tmdb_id 500..505
    await db
      .prepare(`DELETE FROM list_items WHERE user_id = ?1 AND list_id = 'A' AND position < 4`)
      .bind(uid(1))
      .run();
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");

    const [card] = await browseAs(db, "tok-2");
    expect(card.posters.map((p) => p.tmdbId)).toEqual([504, 505]);
  });

  it("searches name and description", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");  // named "Neo-Noir Essentials"
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");
    expect(await browseAs(db, "tok-2", "?q=noir")).toHaveLength(1);
    expect(await browseAs(db, "tok-2", "?q=zzzz")).toHaveLength(0);
  });

  // `q` is interpolated into a LIKE pattern as `%${q}%`. Unescaped, `%` and `_` are
  // themselves LIKE wildcards — `?q=%` becomes the pattern `%%%`, which matches
  // every list regardless of its actual name, not just ones containing a literal `%`.
  it("does not let a bare % in the search term match every list", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A"); // named "Neo-Noir Essentials" — no literal %
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");
    expect(await browseAs(db, "tok-2", "?q=%25")).toHaveLength(0);
  });
});

/** Adds one `list_items` row with an explicit tmdb_id/type, independent of `withList`'s
 *  fixed 500+i/MOVIE items — the containment tests below need to pick exact ids/types. */
async function addItem(
  db: TestD1,
  owner: string,
  listId: string,
  tmdbId: number,
  type: string,
  position = 0,
) {
  const t = Date.now();
  await db
    .prepare(
      `INSERT INTO list_items (user_id, list_id, tmdb_id, type, position, added_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
    )
    .bind(owner, listId, tmdbId, type, position, t)
    .run();
}

// "Find public lists that CONTAIN a given title." The client resolves a typed query to
// a TMDB id via its own catalogue search and sends the id — the server never matches on
// titles. `tmdbId`/`type` are additive: absent, browse must behave exactly as before;
// present, a list also matches if `list_items` contains that (tmdb_id, type) pair, ORed
// with the existing name/description/author text match. `matchedTitle` on every card
// says which arm produced the match, so the client can section "named this" from
// "contains this".
describe("browse: find public lists containing a title", () => {
  it("a list containing the title but whose name does NOT match is returned, with matchedTitle true", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 0, "A"); // named "Neo-Noir Essentials"
    await addItem(db, uid(1), "A", 950, "MOVIE");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");

    const cards = await browseAs(db, "tok-2", "?q=totally-unrelated-text&tmdbId=950&type=MOVIE");
    expect(cards.map((c) => c.listId)).toEqual(["A"]);
    expect(cards[0].matchedTitle).toBe(true);
  });

  it("a list whose NAME matches but does not contain the title is still returned (the OR), with matchedTitle false", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 0, "A"); // named "Neo-Noir Essentials"
    await addItem(db, uid(1), "A", 100, "MOVIE"); // does not contain 950
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");

    const cards = await browseAs(db, "tok-2", "?q=noir&tmdbId=950&type=MOVIE");
    expect(cards.map((c) => c.listId)).toEqual(["A"]);
    expect(cards[0].matchedTitle).toBe(false);
  });

  it("type discriminates — the same tmdb_id as a MOVIE and as a SHOW must not cross-match", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 0, "A"); // named "Neo-Noir Essentials"
    await addItem(db, uid(1), "A", 700, "MOVIE");
    await db
      .prepare(
        `INSERT INTO lists (user_id, id, name, kind, auto_updated, is_pinned_to_home,
           display_order, home_order, version, created_at, updated_at)
         VALUES (?1, 'B', 'Totally Different Title', 'MANUAL', 0, 0, 0, 0, 1, 1, 1)`,
      )
      .bind(uid(1))
      .run();
    await addItem(db, uid(1), "B", 700, "SHOW");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await publishAged(db, uid(1), "B", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");

    const movieCards = await browseAs(db, "tok-2", "?tmdbId=700&type=MOVIE");
    expect(movieCards.map((c) => c.listId)).toEqual(["A"]);

    const showCards = await browseAs(db, "tok-2", "?tmdbId=700&type=SHOW");
    expect(showCards.map((c) => c.listId)).toEqual(["B"]);
  });

  it("absent tmdbId behaves exactly as today, with matchedTitle false on every row", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A"); // items 500,501,502 MOVIE
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");

    const byText = await browseAs(db, "tok-2", "?q=noir");
    expect(byText).toHaveLength(1);
    expect(byText[0].matchedTitle).toBe(false);

    const unfiltered = await browseAs(db, "tok-2");
    expect(unfiltered).toHaveLength(1);
    expect(unfiltered[0].matchedTitle).toBe(false);
  });

  it("ignores a malformed tmdbId or type rather than erroring", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");

    const nonNumeric = await browseAs(db, "tok-2", "?tmdbId=abc&type=MOVIE");
    expect(nonNumeric).toHaveLength(1);
    expect(nonNumeric[0].matchedTitle).toBe(false);

    const notPositive = await browseAs(db, "tok-2", "?tmdbId=-5&type=MOVIE");
    expect(notPositive).toHaveLength(1);
    expect(notPositive[0].matchedTitle).toBe(false);

    const badType = await browseAs(db, "tok-2", "?tmdbId=500&type=BOOK");
    expect(badType).toHaveLength(1);
    expect(badType[0].matchedTitle).toBe(false);
  });

  // The highest-value case: containment must not defeat the privacy filters browse
  // already applies. Each guard below gets its own row, the same way the plain
  // block/hidden tests above do — each proves that ONE specific guard still wins over
  // an otherwise-matching containment probe.
  it("a list that contains the title stays out of results once hidden by moderation", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 0, "A");
    await addItem(db, uid(1), "A", 950, "MOVIE");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await db.prepare(`UPDATE public_lists SET hidden_at = 1 WHERE owner_id = ?1 AND list_id = 'A'`).bind(uid(1)).run();
    await withViewer(db, uid(2), "tok-2");

    expect(await browseAs(db, "tok-2", "?tmdbId=950&type=MOVIE")).toHaveLength(0);
  });

  it("a list that contains the title stays out of results when the author blocked the viewer", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 0, "A");
    await addItem(db, uid(1), "A", 950, "MOVIE");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");
    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(1), uid(2))
      .run();

    expect(await browseAs(db, "tok-2", "?tmdbId=950&type=MOVIE")).toHaveLength(0);
  });

  it("a list that contains the title stays out of results when the viewer blocked the author", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 0, "A");
    await addItem(db, uid(1), "A", 950, "MOVIE");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");
    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(2), uid(1))
      .run();

    expect(await browseAs(db, "tok-2", "?tmdbId=950&type=MOVIE")).toHaveLength(0);
  });

  it("a list that contains the title stays out of results once its underlying list is soft-deleted", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 0, "A");
    await addItem(db, uid(1), "A", 950, "MOVIE");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await db.prepare(`UPDATE lists SET deleted_at = 1 WHERE user_id = ?1 AND id = 'A'`).bind(uid(1)).run();
    await withViewer(db, uid(2), "tok-2");

    expect(await browseAs(db, "tok-2", "?tmdbId=950&type=MOVIE")).toHaveLength(0);
  });
});

describe("detail", () => {
  const detailUrl = (owner: string, listId: string) => `/api/public/lists/${owner}/${listId}`;

  it("404s when the list is hidden by moderation", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await db
      .prepare(`UPDATE public_lists SET hidden_at = 1 WHERE owner_id = ?1 AND list_id = 'A'`)
      .bind(uid(1))
      .run();
    await withViewer(db, uid(2), "tok-2");
    const res = await handlePublicListDetail(
      uid(1),
      "A",
      asUser("tok-2", detailUrl(uid(1), "A"), "GET"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("404s when the underlying list is deleted", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await db.prepare(`UPDATE lists SET deleted_at = 1 WHERE user_id = ?1 AND id = 'A'`).bind(uid(1)).run();
    await withViewer(db, uid(2), "tok-2");
    const res = await handlePublicListDetail(
      uid(1),
      "A",
      asUser("tok-2", detailUrl(uid(1), "A"), "GET"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("404s when the author blocked the viewer", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");
    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(1), uid(2))
      .run();
    const res = await handlePublicListDetail(
      uid(1),
      "A",
      asUser("tok-2", detailUrl(uid(1), "A"), "GET"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  // The other arm of the block check — a separate row from the one above, since each
  // side of the NOT EXISTS's OR needs its own proof it is doing something.
  it("404s when the viewer blocked the author", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A");
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");
    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(2), uid(1))
      .run();
    const res = await handlePublicListDetail(
      uid(1),
      "A",
      asUser("tok-2", detailUrl(uid(1), "A"), "GET"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  // So the 404s above are not passing for the trivial reason that detail always 404s.
  it("returns 200 with items, author name, and the viewer's own saved/liked state", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 3, "A"); // tmdb 500, 501, 502
    await publishAged(db, uid(1), "A", ["crime"], 1);
    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x/follow", "POST"), testEnv(db), ctx);
    await handleLike(uid(1), "A", asUser("tok-2", "/x/like", "POST"), testEnv(db), ctx);

    const res = await handlePublicListDetail(
      uid(1),
      "A",
      asUser("tok-2", detailUrl(uid(1), "A"), "GET"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authorName: string;
      saved: boolean;
      liked: boolean;
      items: { tmdbId: number }[];
    };
    expect(body.items.map((i) => i.tmdbId)).toEqual([500, 501, 502]);
    expect(body.authorName).toBe(`User ${uid(1).slice(0, 4)}`);
    expect(body.saved).toBe(true);
    expect(body.liked).toBe(true);
  });
});

interface Follow {
  ownerId: string;
  listId: string;
  status: string;
  name: string;
  description: string;
  authorName: string;
  authorPictureUrl: string;
  tags: string[];
  items: { tmdbId: number; type: string }[];
}

const followsFor = async (db: TestD1, token: string): Promise<Follow[]> => {
  const res = await handleMyFollows(asUser(token, "/api/me/follows", "GET"), testEnv(db), ctx);
  expect(res.status).toBe(200);
  return ((await res.json()) as { follows: Follow[] }).follows;
};

describe("my follows", () => {
  it("returns the author's CURRENT items, not a copy taken at follow time", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A");
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x", "POST"), testEnv(db), ctx);

    expect((await followsFor(db, "tok-2"))[0].items).toHaveLength(2);

    // The author adds a title AFTER the follow.
    await db
      .prepare(
        `INSERT INTO list_items (user_id, list_id, tmdb_id, type, position, added_at, updated_at)
         VALUES (?1, 'A', 777, 'MOVIE', 9, 1, 1)`,
      )
      .bind(uid(1))
      .run();

    const items = (await followsFor(db, "tok-2"))[0].items;
    expect(items).toHaveLength(3);
    expect(items.some((i) => i.tmdbId === 777)).toBe(true);
  });

  it("reports an unpublished list as unpublished, keeping the follow", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A");
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x", "POST"), testEnv(db), ctx);
    await handleUnpublishList("A", authed("/api/me/lists/A/publish", "DELETE"), testEnv(db), ctx);

    const [f] = await followsFor(db, "tok-2");
    expect(f.status).toBe("unpublished");
    expect(f.name).toBe("Neo-Noir Essentials");
  });

  // A follower must not be able to tell a takedown from an unpublish.
  it("reports a HIDDEN list as unpublished, not as hidden", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A");
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x", "POST"), testEnv(db), ctx);
    await db.prepare(`UPDATE public_lists SET hidden_at = 1 WHERE list_id = 'A'`).run();

    const [f] = await followsFor(db, "tok-2");
    expect(f.status).toBe("unpublished");
  });

  it("reports a deleted list as gone", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A");
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x", "POST"), testEnv(db), ctx);
    await db.prepare(`UPDATE lists SET deleted_at = 1 WHERE user_id = ?1 AND id = 'A'`).bind(uid(1)).run();

    const [f] = await followsFor(db, "tok-2");
    expect(f.status).toBe("gone");
  });

  // The bug: keying "gone" on `!name` rather than the LEFT JOIN failing. `lists.name`
  // is NOT NULL but not constrained non-empty, so a real, undeleted list with an empty
  // name would falsely report gone and drop its items under the old key.
  it("does not report gone for a list with an empty name", async () => {
    const db = new TestD1();
    seedUser(db, { id: uid(1) });
    seedSession(db, uid(1), await sha256Hex(TOKEN));
    const t = Date.now();
    await db
      .prepare(
        `INSERT INTO lists (user_id, id, name, kind, auto_updated, is_pinned_to_home,
           display_order, home_order, version, created_at, updated_at)
         VALUES (?1, 'A', '', 'MANUAL', 0, 0, 0, 0, 1, ?2, ?2)`,
      )
      .bind(uid(1), t)
      .run();
    await db
      .prepare(
        `INSERT INTO list_items (user_id, list_id, tmdb_id, type, position, added_at, updated_at)
         VALUES (?1, 'A', 500, 'MOVIE', 0, ?2, ?2)`,
      )
      .bind(uid(1), t)
      .run();
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x/follow", "POST"), testEnv(db), ctx);

    const [f] = await followsFor(db, "tok-2");
    expect(f.status).not.toBe("gone");
    expect(f.items).toHaveLength(1);
  });

  // The join-miss path itself, not just the deleted_at path: a hard-deleted `lists`
  // row (no row for the LEFT JOIN to match) must still be reported gone.
  it("reports gone when the list row itself is missing", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A");
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x/follow", "POST"), testEnv(db), ctx);
    await db.prepare(`DELETE FROM lists WHERE user_id = ?1 AND id = 'A'`).bind(uid(1)).run();

    const [f] = await followsFor(db, "tok-2");
    expect(f.status).toBe("gone");
    expect(f.items).toHaveLength(0);
  });

  // The other half of the privacy leak: an existing follow, when a block is later
  // created between the two, must stop materialising items AND report "gone" — the
  // same shape a genuinely deleted list produces, name/description/authorName/
  // authorPictureUrl/tags all blank — rather than "unpublished" with the list's
  // CURRENT (re-read-on-every-poll) name, description and author details still
  // attached. "unpublished" is deliberately NOT used here even blanked: a real
  // unpublish or takedown never leaves those fields empty (see the "unpublished"
  // test above), so an unpublished-but-blank row would itself be a shape that only a
  // block could produce — which is exactly the kind of tell this must not create.
  // "gone" already legitimately happens for reasons that have nothing to do with a
  // block, so reusing it keeps a block indistinguishable from a deletion.
  it("reports a follow as gone, with no name, description, author details, tags or items, once the author blocks the follower", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A");
    await db
      .prepare(`UPDATE lists SET description = 'A tight little collection' WHERE user_id = ?1 AND id = 'A'`)
      .bind(uid(1))
      .run();
    await db
      .prepare(`UPDATE profiles SET picture_url = 'https://flickto.app/api/profile/x/picture' WHERE user_id = ?1`)
      .bind(uid(1))
      .run();
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x/follow", "POST"), testEnv(db), ctx);
    const before = (await followsFor(db, "tok-2"))[0];
    expect(before.items).toHaveLength(2);
    expect(before.name).toBe("Neo-Noir Essentials");
    expect(before.description).toBe("A tight little collection");
    expect(before.authorPictureUrl).toBe("https://flickto.app/api/profile/x/picture");

    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(1), uid(2))
      .run();

    const [f] = await followsFor(db, "tok-2");
    expect(f.status).toBe("gone");
    expect(f.name).toBe("");
    expect(f.description).toBe("");
    expect(f.authorName).toBe("");
    expect(f.authorPictureUrl).toBe("");
    expect(f.tags).toEqual([]);
    expect(f.items).toHaveLength(0);
    expect(f.updatedAt).toBe(0);
  });

  // The other direction: the follower is the one who did the blocking.
  it("reports a follow as gone, with no name, description, author details, tags or items, once the follower blocks the author", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A");
    await db
      .prepare(`UPDATE lists SET description = 'A tight little collection' WHERE user_id = ?1 AND id = 'A'`)
      .bind(uid(1))
      .run();
    await db
      .prepare(`UPDATE profiles SET picture_url = 'https://flickto.app/api/profile/x/picture' WHERE user_id = ?1`)
      .bind(uid(1))
      .run();
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x/follow", "POST"), testEnv(db), ctx);
    const before = (await followsFor(db, "tok-2"))[0];
    expect(before.items).toHaveLength(2);
    expect(before.authorName).not.toBe("");

    await db
      .prepare(`INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, 1)`)
      .bind(uid(2), uid(1))
      .run();

    const [f] = await followsFor(db, "tok-2");
    expect(f.status).toBe("gone");
    expect(f.name).toBe("");
    expect(f.description).toBe("");
    expect(f.authorName).toBe("");
    expect(f.authorPictureUrl).toBe("");
    expect(f.tags).toEqual([]);
    expect(f.items).toHaveLength(0);
    expect(f.updatedAt).toBe(0);
  });

  // The N+1 fix's specific failure mode: a batched query that isn't correctly
  // partitioned per (owner_id, list_id) could return the right COUNT of items while
  // mixing which items belong to which list.
  it("batches items for two followed lists without cross-contaminating them", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A"); // tmdb 500, 501
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await db
      .prepare(
        `INSERT INTO lists (user_id, id, name, kind, auto_updated, is_pinned_to_home,
           display_order, home_order, version, created_at, updated_at)
         VALUES (?1, 'B', 'Second List', 'MANUAL', 0, 0, 0, 0, 1, 1, 1)`,
      )
      .bind(uid(1))
      .run();
    for (const [i, tmdbId] of [700, 701, 702].entries()) {
      await db
        .prepare(
          `INSERT INTO list_items (user_id, list_id, tmdb_id, type, position, added_at, updated_at)
           VALUES (?1, 'B', ?2, 'MOVIE', ?3, 1, 1)`,
        )
        .bind(uid(1), tmdbId, i)
        .run();
    }
    await handlePublishList(
      "B",
      authed("/api/me/lists/B/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );

    await withViewer(db, uid(2), "tok-2");
    await handleFollow(uid(1), "A", asUser("tok-2", "/x/follow", "POST"), testEnv(db), ctx);
    await handleFollow(uid(1), "B", asUser("tok-2", "/x/follow", "POST"), testEnv(db), ctx);

    const follows = await followsFor(db, "tok-2");
    const a = follows.find((f) => f.listId === "A")!;
    const b = follows.find((f) => f.listId === "B")!;
    expect(a.items.map((i) => i.tmdbId)).toEqual([500, 501]);
    expect(b.items.map((i) => i.tmdbId)).toEqual([700, 701, 702]);
  });
});

describe("deleting the underlying list", () => {
  // handleDeleteList (userLists.ts) soft-deletes `lists` and cleans `list_items` /
  // `list_filters`, but left `public_lists` / `public_list_tags` behind. Browse and
  // detail both hide the orphan via `l.deleted_at IS NULL`, so it is not a content
  // leak — but the publish cap (`handlePublishList`) counts every row in
  // `public_lists` regardless of `lists.deleted_at`, so the orphan permanently ate
  // one slot of the user's MAX_PUBLISHED_PER_USER quota.
  it("removes the directory row and tags, freeing the publish cap", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    expect(db.count("public_lists", "owner_id = ?", uid(1))).toBe(1);
    expect(db.count("public_list_tags", "owner_id = ?", uid(1))).toBe(1);

    const res = await handleDeleteList(
      "L1",
      authed("/api/me/lists/L1", "DELETE"),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(200);

    expect(db.count("public_lists", "owner_id = ?", uid(1))).toBe(0);
    expect(db.count("public_list_tags", "owner_id = ?", uid(1))).toBe(0);

    // A second list, without re-seeding the user (already seeded above) — just the
    // `lists` row and one item, the minimum `handlePublishList` requires.
    const addList = async (id: string) => {
      const t = Date.now();
      await db
        .prepare(
          `INSERT INTO lists (user_id, id, name, kind, auto_updated, is_pinned_to_home,
             display_order, home_order, version, created_at, updated_at)
           VALUES (?1, ?2, 'Filler', 'MANUAL', 0, 0, 0, 0, 1, ?3, ?3)`,
        )
        .bind(uid(1), id, t)
        .run();
      await db
        .prepare(
          `INSERT INTO list_items (user_id, list_id, tmdb_id, type, position, added_at, updated_at)
           VALUES (?1, ?2, 900, 'MOVIE', 0, ?3, ?3)`,
        )
        .bind(uid(1), id, t)
        .run();
    };

    // The cap is freed: publishing MAX_PUBLISHED_PER_USER - 1 more lists (49 more,
    // since none were published before L1) plus a new one must not 409.
    for (let i = 0; i < MAX_PUBLISHED_PER_USER - 1; i++) {
      const id = `filler-${i}`;
      await addList(id);
      const pub = await handlePublishList(
        id,
        authed(`/api/me/lists/${id}/publish`, "POST", { tags: ["crime"] }),
        testEnv(db),
        ctx,
      );
      expect(pub.status).toBe(200);
    }
    // The orphan from the deleted L1 must not still be occupying a slot: this is the
    // MAX_PUBLISHED_PER_USER'th list published on this account.
    await addList("final");
    const final = await handlePublishList(
      "final",
      authed("/api/me/lists/final/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    expect(final.status).toBe(200);
  });
});

describe("reporting", () => {
  it("files into the shared reports table under kind public_list", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A");
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    const res = await handleReportPublicList(
      uid(1),
      "A",
      new Request(`https://flickto.app/api/public/lists/${uid(1)}/A/report`, {
        method: "POST",
        headers: { Authorization: "Bearer tok-2", "Content-Type": "application/json" },
        body: JSON.stringify({ context: "spam" }),
      }),
      testEnv(db),
      ctx,
    );
    expect(res.status).toBe(200);
    const row = await db
      .prepare(`SELECT kind, target_id, state FROM reports WHERE reporter_id = ?1`)
      .bind(uid(2))
      .first<{ kind: string; target_id: string; state: string }>();
    expect(row!.kind).toBe("public_list");
    expect(row!.target_id).toBe(`${uid(1)}:A`);
    expect(row!.state).toBe("open");
  });

  it("hides the list once the distinct-reporter threshold is reached", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A");
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    const env = testEnv(db, { REPORT_AUTOHIDE: "2" });
    for (const n of [2, 3]) {
      await withViewer(db, uid(n), `tok-${n}`);
      await handleReportPublicList(
        uid(1),
        "A",
        new Request(`https://flickto.app/x`, {
          method: "POST",
          headers: { Authorization: `Bearer tok-${n}`, "Content-Type": "application/json" },
          body: JSON.stringify({ context: "spam" }),
        }),
        env,
        ctx,
      );
    }
    const row = await db
      .prepare(`SELECT hidden_at FROM public_lists WHERE owner_id = ?1 AND list_id = 'A'`)
      .bind(uid(1))
      .first<{ hidden_at: number | null }>();
    expect(row!.hidden_at).not.toBeNull();
  });

  it("one reporter cannot trip the threshold alone", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL", 2, "A");
    await handlePublishList(
      "A",
      authed("/api/me/lists/A/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    const env = testEnv(db, { REPORT_AUTOHIDE: "2" });
    await withViewer(db, uid(2), "tok-2");
    for (let i = 0; i < 4; i++) {
      await handleReportPublicList(
        uid(1),
        "A",
        new Request(`https://flickto.app/x`, {
          method: "POST",
          headers: { Authorization: "Bearer tok-2", "Content-Type": "application/json" },
          body: JSON.stringify({ context: "spam" }),
        }),
        env,
        ctx,
      );
    }
    const row = await db
      .prepare(`SELECT hidden_at FROM public_lists WHERE owner_id = ?1 AND list_id = 'A'`)
      .bind(uid(1))
      .first<{ hidden_at: number | null }>();
    expect(row!.hidden_at).toBeNull();

    // Proves the duplicate suppression itself, not just its side effect: deleting the
    // handler's `WHERE NOT EXISTS` clause entirely would still leave hidden_at null
    // (COUNT(DISTINCT reporter_id) is still 1) but would leave 4 rows here, not 1.
    const reportCount = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?1 AND target_id = ?2 AND kind = 'public_list'`,
      )
      .bind(uid(2), `${uid(1)}:A`)
      .first<{ n: number }>();
    expect(reportCount!.n).toBe(1);
  });
});

describe("account erasure", () => {
  /**
   * A table missing from `eraseAccount`'s batch is a silent compliance gap: the delete
   * returns 204 and the rows simply stay. This is what makes the claim "your published
   * lists, follows and likes are removed" true instead of aspirational.
   *
   * `list_follows` and `public_list_likes` are keyed on TWO different people —
   * `user_id`, the one who followed/liked, and `owner_id`, whose list it points at — so
   * erasing one account has to clear both directions. Leaving the `owner_id` half behind
   * would keep a surviving user subscribed to a list whose owner no longer exists.
   */
  it("erases published lists, tags, follows and likes in both directions", async () => {
    const db = new TestD1();
    // uid(1): the account about to be erased. Publishes L1 with a tag.
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    // uid(3): a bystander who owns a different published list, so uid(1) has something
    // of someone else's to follow and like.
    seedUser(db, { id: uid(3) });
    db.exec(
      `INSERT INTO public_lists (owner_id, list_id, tags, engagement, published_at, hidden_at)
       VALUES ('${uid(3)}', 'L3', '[]', 0, 1, NULL)`,
    );
    const l3Url = `/api/public/lists/${uid(3)}/L3`;
    await handleFollow(uid(3), "L3", asUser("tok-owner", `${l3Url}/follow`, "POST"), testEnv(db), ctx);
    await handleLike(uid(3), "L3", asUser("tok-owner", `${l3Url}/like`, "POST"), testEnv(db), ctx);
    // uid(2): a bystander who follows and likes uid(1)'s list L1 — a subscription that
    // must not survive uid(1)'s erasure either.
    await withViewer(db, uid(2), "tok-2");
    const l1Url = `/api/public/lists/${uid(1)}/L1`;
    await handleFollow(uid(1), "L1", asUser("tok-2", `${l1Url}/follow`, "POST"), testEnv(db), ctx);
    await handleLike(uid(1), "L1", asUser("tok-2", `${l1Url}/like`, "POST"), testEnv(db), ctx);

    // Sanity: everything is seeded before erasure runs.
    expect(db.count("public_lists", "owner_id = ?", uid(1))).toBe(1);
    expect(db.count("public_list_tags", "owner_id = ?", uid(1))).toBe(1);
    expect(db.count("list_follows", "user_id = ?", uid(1))).toBe(1);
    expect(db.count("public_list_likes", "user_id = ?", uid(1))).toBe(1);
    expect(db.count("list_follows", "owner_id = ?", uid(1))).toBe(1);
    expect(db.count("public_list_likes", "owner_id = ?", uid(1))).toBe(1);

    await eraseAccount(testEnv(db), uid(1));

    // uid(1)'s own list, its tags, and its own follow/like of someone else's list.
    expect(db.count("public_lists", "owner_id = ?", uid(1))).toBe(0);
    expect(db.count("public_list_tags", "owner_id = ?", uid(1))).toBe(0);
    expect(db.count("list_follows", "user_id = ?", uid(1))).toBe(0);
    expect(db.count("public_list_likes", "user_id = ?", uid(1))).toBe(0);
    // Other people's follow/like of uid(1)'s now-gone list.
    expect(db.count("list_follows", "owner_id = ?", uid(1))).toBe(0);
    expect(db.count("public_list_likes", "owner_id = ?", uid(1))).toBe(0);

    // Untouched: uid(3)'s own list and uid(1)'s follow/like of it were on uid(1)'s side
    // (already asserted above), but uid(3)'s list itself must survive uid(1)'s erasure.
    expect(db.count("public_lists", "owner_id = ?", uid(3))).toBe(1);
  });

  // The erasure batch above correctly deletes uid(1)'s follow/like rows in BOTH
  // directions — including uid(1)'s OWN follow/like of someone else's list. But
  // deleting those rows makes `public_lists.engagement` wrong for the OTHER owner's
  // list: nothing in this worker recomputes it on a schedule, so uid(3)'s cached
  // ranking would stay inflated by uid(1)'s vanished follow forever.
  it("recomputes a followed list's engagement after the follower is erased", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    seedUser(db, { id: uid(3) });
    db.exec(
      `INSERT INTO public_lists (owner_id, list_id, tags, engagement, published_at, hidden_at)
       VALUES ('${uid(3)}', 'L3', '[]', 0, 1, NULL)`,
    );
    const l3Url = `/api/public/lists/${uid(3)}/L3`;
    // uid(1) follows AND likes uid(3)'s list: engagement should read 3 + 1 = 4.
    await handleFollow(uid(3), "L3", asUser("tok-owner", `${l3Url}/follow`, "POST"), testEnv(db), ctx);
    await handleLike(uid(3), "L3", asUser("tok-owner", `${l3Url}/like`, "POST"), testEnv(db), ctx);
    expect(
      (
        await db
          .prepare(`SELECT engagement FROM public_lists WHERE owner_id = ? AND list_id = 'L3'`)
          .bind(uid(3))
          .first<{ engagement: number }>()
      )?.engagement,
    ).toBe(4);

    await eraseAccount(testEnv(db), uid(1));

    const row = await db
      .prepare(`SELECT engagement FROM public_lists WHERE owner_id = ? AND list_id = 'L3'`)
      .bind(uid(3))
      .first<{ engagement: number }>();
    expect(row!.engagement).toBe(0);
  });

  // `public_list_likes` has no follow-style cap, so without a LIMIT the snapshot the
  // recompute above reads from could grow unbounded and turn one erasure into a
  // batch of thousands of UPDATEs. Seeds five more owners than the cap allows and
  // checks the boundary directly: everything within MAX_ERASURE_RECOMPUTE gets its
  // stale engagement corrected, the ones beyond it are left exactly as they were —
  // proving the LIMIT is actually applied, not just present in the SQL.
  it("caps the erasure engagement recompute so it cannot become an unbounded batch", async () => {
    const db = new TestD1();
    seedUser(db, { id: uid(1) });
    const total = MAX_ERASURE_RECOMPUTE + 5;
    for (let i = 0; i < total; i++) {
      const owner = uid(100 + i);
      seedUser(db, { id: owner });
      db.exec(
        `INSERT INTO public_lists (owner_id, list_id, tags, engagement, published_at, hidden_at)
         VALUES ('${owner}', 'L', '[]', 3, 1, NULL)`,
      );
      db.exec(
        `INSERT INTO list_follows (user_id, owner_id, list_id, created_at)
         VALUES ('${uid(1)}', '${owner}', 'L', 1)`,
      );
    }

    await eraseAccount(testEnv(db), uid(1));

    // Recomputed pairs land at 0 (the erased user's follow was the only one); pairs
    // past the cap were never snapshotted, so their stale pre-erasure value survives.
    expect(db.count("public_lists", "engagement = 0")).toBe(MAX_ERASURE_RECOMPUTE);
    expect(db.count("public_lists", "engagement = 3")).toBe(5);
    // The compliance promise — the erased user's own follows are gone — does not
    // depend on the cache and holds regardless of the cap.
    expect(db.count("list_follows", "user_id = ?", uid(1))).toBe(0);
  });

  // If the recompute below fails, the delete batch above has already committed —
  // erasure has already succeeded. A rejection here must not propagate and turn a
  // completed erasure into a thrown error (a 500 the client retries, whose own
  // retry finds nothing left to snapshot and recompute) — the same shape as the
  // HISTORY_STATS_KV `.catch(() => {})` a few lines below it in eraseAccount.
  //
  // Real SQLite has no way to fail a well-formed statement on demand, so this
  // simulates a D1 failure with a call-count proxy: the erasure batch is always
  // `env.DB.batch`'s FIRST call, and the recompute is every call after it.
  it("does not fail the erasure when the engagement recompute batch fails", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    seedUser(db, { id: uid(3) });
    db.exec(
      `INSERT INTO public_lists (owner_id, list_id, tags, engagement, published_at, hidden_at)
       VALUES ('${uid(3)}', 'L3', '[]', 0, 1, NULL)`,
    );
    const l3Url = `/api/public/lists/${uid(3)}/L3`;
    await handleFollow(uid(3), "L3", asUser("tok-owner", `${l3Url}/follow`, "POST"), testEnv(db), ctx);

    let calls = 0;
    const failingEnv = {
      DB: {
        prepare: (sql: string) => db.prepare(sql),
        batch: async (stmts: unknown[]) => {
          calls++;
          if (calls > 1) throw new Error("simulated D1 failure");
          return db.batch(stmts as never);
        },
      },
    } as never;

    await expect(eraseAccount(failingEnv, uid(1))).resolves.toBeUndefined();
    // The delete batch (the first `batch()` call) still ran to completion despite
    // the second (recompute) call throwing.
    expect(db.count("users", "id = ?", uid(1))).toBe(0);
    expect(db.count("list_follows", "user_id = ?", uid(1))).toBe(0);
  });
});

interface Published {
  listId: string;
  tags: string[];
  saves: number;
  likes: number;
  hidden: boolean;
  publishedAt: number;
}

async function myPublished(db: TestD1, token = TOKEN): Promise<Published[]> {
  const res = await handleMyPublishedLists(
    asUser(token, "/api/me/lists/published", "GET"),
    testEnv(db),
    ctx,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { published: Published[] }).published;
}

describe("GET /api/me/lists/published", () => {
  it("a published list appears with its tags and true saves/likes counts", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime", "neo-noir"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    await withViewer(db, uid(3), "tok-3");
    const url = `/api/public/lists/${uid(1)}/L1`;
    await handleFollow(uid(1), "L1", asUser("tok-2", `${url}/follow`, "POST"), testEnv(db), ctx);
    await handleLike(uid(1), "L1", asUser("tok-2", `${url}/like`, "POST"), testEnv(db), ctx);
    await handleLike(uid(1), "L1", asUser("tok-3", `${url}/like`, "POST"), testEnv(db), ctx);

    const [p] = await myPublished(db);
    expect(p).toMatchObject({ listId: "L1", tags: ["crime", "neo-noir"], saves: 1, likes: 2, hidden: false });
    expect(p.publishedAt).toBeGreaterThan(0);
  });

  it("an unpublished list does not appear", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    expect(await myPublished(db)).toEqual([]);
  });

  it("another user's published list does not appear", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    expect(await myPublished(db, "tok-2")).toEqual([]);
  });

  it("a hidden list still appears, flagged hidden: true — this endpoint is owner-only", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await db
      .prepare(`UPDATE public_lists SET hidden_at = ?2 WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1), Date.now())
      .run();

    const [p] = await myPublished(db);
    expect(p.listId).toBe("L1");
    expect(p.hidden).toBe(true);
  });

  it("a soft-deleted list does not appear", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await db.prepare(`UPDATE lists SET deleted_at = ?2 WHERE user_id = ?1 AND id = 'L1'`)
      .bind(uid(1), Date.now())
      .run();

    expect(await myPublished(db)).toEqual([]);
  });

  // The one that matters most: `public_lists.engagement` is a decay-weighted ranking
  // cache (3x per follow, 1x per like — see `recomputeEngagement`), not a count, and
  // is explicitly off-limits as a source for `saves`/`likes`. Setting it to a value
  // that could not possibly be a real count proves the handler never reads it — if
  // someone later "optimises" this to `SELECT engagement`, this test catches it.
  it("saves/likes come from list_follows/public_list_likes rows, never from the engagement cache", async () => {
    const db = new TestD1();
    await withList(db, uid(1), "MANUAL");
    await handlePublishList(
      "L1",
      authed("/api/me/lists/L1/publish", "POST", { tags: ["crime"] }),
      testEnv(db),
      ctx,
    );
    await withViewer(db, uid(2), "tok-2");
    const url = `/api/public/lists/${uid(1)}/L1`;
    await handleFollow(uid(1), "L1", asUser("tok-2", `${url}/follow`, "POST"), testEnv(db), ctx);
    await handleLike(uid(1), "L1", asUser("tok-2", `${url}/like`, "POST"), testEnv(db), ctx);

    await db
      .prepare(`UPDATE public_lists SET engagement = 999 WHERE owner_id = ?1 AND list_id = 'L1'`)
      .bind(uid(1))
      .run();

    const [p] = await myPublished(db);
    expect(p.saves).toBe(1);
    expect(p.likes).toBe(1);
  });
});
