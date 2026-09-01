// The commsuni.tv upstream client and read path.
//
// The properties pinned here are the ones that cost money or leak identity rather
// than the ones that throw: a retry that burns quota on a request that can never
// succeed, a fetch that happens when the negative cache should have prevented it, an
// unfiltered read that renders our own comments twice, and an actor ID derived from
// anything other than our own user id.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  actorId,
  commsuniCall,
  commsuniEnabled,
  foreignSlugs,
  loadSources,
  __resetBreaker,
  __resetSources,
} from "./commsuni";
import { clearMiss, loadArchiveReplies, loadArchivePage, platformSources } from "./commsuniComments";

const KEY = "tvta_live_abc_secret";

/** Minimal D1 for tvdb_map + archive_misses. Throws on SQL it does not know. */
class FakeD1 {
  map: any[] = [];
  misses: any[] = [];
  /** Archive ids hidden product-wide. Plain strings; see archive_suppressed. */
  suppressed: string[] = [];
  /** Rows of archive_blocks for the one reader these tests use. */
  blocks: any[] = [];
  /** archive_comment_refs: archive ids WE published, i.e. our own mirrored rows. */
  refs: string[] = [];
  prepare(sql: string) {
    return new FakeStmt(this, sql.replace(/\s+/g, " ").trim());
  }
}
class FakeStmt {
  private a: any[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.a = args as any[];
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.startsWith("SELECT tvdb_id FROM tvdb_map")) {
      const r = this.db.map.find((x) => x.media_type === this.a[0] && x.tmdb_id === this.a[1]);
      return r ? ({ tvdb_id: r.tvdb_id } as T) : null;
    }
    if (this.sql.startsWith("SELECT expires_at FROM archive_misses")) {
      const r = this.db.misses.find((x) => x.entity_ref === this.a[0]);
      return r ? ({ expires_at: r.expires_at } as T) : null;
    }
    throw new Error("unhandled SQL: " + this.sql);
  }
  async all<T>(): Promise<{ results: T[] }> {
    // Product-wide hides. Empty by default: suppression is the exception.
    if (this.sql.startsWith("SELECT source_slug, author_id, display_name")) {
      return { results: this.db.blocks.filter((b: any) => b.blocker_id === this.a[0]) as T[] };
    }
    if (this.sql.startsWith("SELECT archive_id FROM archive_comment_refs")) {
      const ids = new Set(this.a);
      return { results: this.db.refs.filter((x: any) => ids.has(x)).map((archive_id: any) => ({ archive_id })) as T[] };
    }
    if (this.sql.startsWith("SELECT archive_id FROM archive_suppressed")) {
      const ids = new Set(this.a);
      return { results: this.db.suppressed.filter((x: any) => ids.has(x)).map((archive_id: any) => ({ archive_id })) as T[] };
    }
    throw new Error("unhandled SQL: " + this.sql);
  }
  async run() {
    if (this.sql.startsWith("INSERT OR IGNORE INTO tvdb_map")) {
      if (!this.db.map.some((x) => x.media_type === this.a[0] && x.tmdb_id === this.a[1])) {
        this.db.map.push({ media_type: this.a[0], tmdb_id: this.a[1], tvdb_id: this.a[2] });
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT OR REPLACE INTO archive_misses")) {
      this.db.misses = this.db.misses.filter((x) => x.entity_ref !== this.a[0]);
      this.db.misses.push({ entity_ref: this.a[0], checked_at: this.a[1], expires_at: this.a[2] });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM archive_misses")) {
      this.db.misses = this.db.misses.filter((x) => x.entity_ref !== this.a[0]);
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error("unhandled SQL: " + this.sql);
  }
}

const env = (over: Record<string, unknown> = {}) =>
  ({
    DB: new FakeD1(),
    COMMSUNI_KEY: KEY,
    COMMSUNI_ACTOR_SECRET: "actor-secret",
    COMMSUNI_SLUG: "flickto",
    ...over,
  }) as any;

const ok = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ data }), { status: 200, headers });
const err = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code } }), { status });

let calls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  __resetBreaker();
  __resetSources();
  calls = [];
});

/** Install a fetch that records every call and replays queued responses. */
function stubFetch(...responses: Response[]) {
  let i = 0;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(responses[Math.min(i++, responses.length - 1)]);
  });
}

describe("actor id", () => {
  it("is a stable hex HMAC of OUR user id, in the format the header demands", async () => {
    const e = env();
    const a = await actorId(e, "C3VXH73X7P55T48R4CFHDED9CW");
    const b = await actorId(e, "C3VXH73X7P55T48R4CFHDED9CW");
    expect(a).toBe(b);
    // §2: ASCII, [A-Za-z0-9][A-Za-z0-9._:@/-]*, at most 128 bytes.
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs per user, and is absent without the secret", async () => {
    const e = env();
    expect(await actorId(e, "USER-A")).not.toBe(await actorId(e, "USER-B"));
    expect(await actorId(env({ COMMSUNI_ACTOR_SECRET: undefined }), "USER-A")).toBeNull();
  });
});

describe("request contract", () => {
  it("sends only allowlisted headers — never Origin", async () => {
    stubFetch(ok({}));
    await commsuniCall(env(), "/sources", { actor: "abc" });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${KEY}`);
    expect(h["X-TVTA-Actor-ID"]).toBe("abc");
    // Forwarding Origin makes a server-to-server call look like a browser's.
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("origin");
  });

  it("⚠️ trims the key, because a pasted credential carries a trailing newline", async () => {
    stubFetch(ok({}));
    await commsuniCall(env({ COMMSUNI_KEY: KEY + "\n" }), "/sources");
    expect((calls[0].init.headers as any).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("⚠️ does NOT retry a 4xx — quota is charged on the request, not the outcome", async () => {
    stubFetch(err(400, "invalid_parameter"));
    const res = await commsuniCall(env(), "/sources");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_parameter");
    // A retried 400 costs real money to be told exactly the same thing.
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 and a 5xx, and succeeds on a later attempt", async () => {
    stubFetch(err(429, "rate_limited"), ok({ hello: true }));
    const res = await commsuniCall<any>(env(), "/sources");
    expect(res.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("surfaces Idempotency-Replayed and Report-Duplicate, which a bare 2xx hides", async () => {
    stubFetch(ok({}, { "Idempotency-Replayed": "true", "Report-Duplicate": "true" }));
    const res = await commsuniCall(env(), "/comments/x/reports", { method: "POST", body: {} });
    // A bare 202 is not proof a report landed.
    expect(res.replayed).toBe(true);
    expect(res.reportDuplicate).toBe(true);
  });

  it("falls back to the NEXT key on 401, which is what makes rotation zero-downtime", async () => {
    stubFetch(err(401, "unauthorized"), ok({ hello: true }));
    const res = await commsuniCall<any>(env({ COMMSUNI_KEY_NEXT: "tvta_live_next_secret" }), "/sources");
    expect(res.ok).toBe(true);
    expect((calls[1].init.headers as any).Authorization).toBe("Bearer tvta_live_next_secret");
  });

  it("is inert with no key configured — nothing is fetched", async () => {
    stubFetch(ok({}));
    expect(commsuniEnabled(env({ COMMSUNI_KEY: undefined }))).toBe(false);
    const res = await commsuniCall(env({ COMMSUNI_KEY: undefined }), "/sources");
    expect(res.code).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });

  // Generous timeout: each failing call burns its full retry budget with jittered
  // backoff (up to ~6s), which is the behaviour under test, not something to shorten.
  it("opens the circuit breaker after repeated failures and stops calling", async () => {
    stubFetch(err(500, "server_error"));
    // Each call records one failure per attempt, so two calls cross the threshold.
    await commsuniCall(env(), "/sources");
    await commsuniCall(env(), "/sources");
    const before = calls.length;
    const res = await commsuniCall(env(), "/sources");
    expect(res.code).toBe("breaker_open");
    // Breaker open means no network at all, not a failed call.
    expect(calls.length).toBe(before);
  }, 30_000);
});

describe("source filter — the primary dedup", () => {
  it("passes every active slug EXCEPT ours", () => {
    const slugs = foreignSlugs(env(), [
      { slug: "tvtime", status: "active" },
      { slug: "flickto", status: "active" },
      { slug: "other", status: "active" },
    ]);
    // Ours is dropped server-side rather than fetched and discarded.
    expect(slugs).toEqual(["tvtime", "other"]);
  });

  it("drops inactive partners", () => {
    expect(foreignSlugs(env(), [
      { slug: "tvtime", status: "retired" },
      { slug: "other", status: "active" },
    ])).toEqual(["other"]);
  });

  it("⚠️ returns null rather than an empty filter when the catalog is unavailable", () => {
    // An empty `?source=` is UNFILTERED, which reads our own mirrored comments back
    // and renders them twice beside the native rows they duplicate.
    expect(foreignSlugs(env(), [])).toBeNull();
    expect(foreignSlugs(env({ COMMSUNI_SLUG: undefined }), [{ slug: "tvtime" }])).toBeNull();
  });

  it("caches the catalog in memory, so most requests never re-read it", async () => {
    stubFetch(ok([{ slug: "tvtime", status: "active" }]));
    const e = env();
    await loadSources(e);
    await loadSources(e);
    expect(calls).toHaveLength(1);
  });
});

describe("archive replies — the dedup the page read gets for free", () => {
  /**
   * ⚠️ The replies endpoint takes NO source filter, unlike the entity read which
   * excludes our slug upstream. That was harmless while only top-level comments were
   * mirrored — we never had a row in anyone's reply list. The first mirrored REPLY made
   * it visible: the author saw their own words twice, once as the native row they can
   * edit and delete and once as a foreign row under the partner's badge that they could
   * only report. Device-found 2026-09-01.
   */
  it("strips replies we published ourselves", async () => {
    const e = env();
    e.DB.refs.push("OURS-1111");
    stubFetch(ok({ replies: [{ id: "THEIRS-1" }, { id: "OURS-1111" }, { id: "THEIRS-2" }] }));

    const page = await loadArchiveReplies(e, "PARENT-1", "USER-A", null);

    expect((page!.comments as Array<{ id: string }>).map((c) => c.id)).toEqual(["THEIRS-1", "THEIRS-2"]);
  });

  it("leaves a thread alone when nothing in it is ours", async () => {
    const e = env();
    stubFetch(ok({ replies: [{ id: "THEIRS-1" }, { id: "THEIRS-2" }] }));

    const page = await loadArchiveReplies(e, "PARENT-1", "USER-A", null);

    expect((page!.comments as Array<{ id: string }>).map((c) => c.id)).toEqual(["THEIRS-1", "THEIRS-2"]);
  });
});

describe("negative cache — the biggest cost lever", () => {
  const load = (e: any, cursor: string | null = null) =>
    loadArchivePage(e, "show", 1399, 2, 5, "USER-A", 121361, cursor);

  it("caches a 404 not_archived as an empty state rather than a failure", async () => {
    stubFetch(ok([{ slug: "tvtime", status: "active" }]), err(404, "not_archived"));
    const e = env();
    expect(await load(e)).toBeNull();
    expect(e.DB.misses.map((m: any) => m.entity_ref)).toEqual(["episode/tvdb-121361-s2e5"]);
  });

  it("⚠️ a cached miss SKIPS the upstream call entirely, not merely renders empty", async () => {
    const e = env();
    e.DB.misses.push({ entity_ref: "episode/tvdb-121361-s2e5", expires_at: Date.now() + 60_000 });
    stubFetch(ok([{ slug: "tvtime", status: "active" }]));

    expect(await load(e)).toBeNull();
    // Rendering empty after fetching produces the same screen and pays the read_unit
    // anyway — which is the entire cost this table exists to avoid.
    expect(calls).toHaveLength(0);
  });

  it("an EXPIRED miss does not suppress the read", async () => {
    const e = env();
    e.DB.misses.push({ entity_ref: "episode/tvdb-121361-s2e5", expires_at: Date.now() - 1 });
    stubFetch(ok([{ slug: "tvtime", status: "active" }]), ok({ comments: [{ id: "x" }] }));
    const page = await load(e);
    expect(page?.comments).toHaveLength(1);
  });

  it("clearMiss reopens a reference, for the moment one of our users writes there", async () => {
    const e = env();
    e.DB.misses.push({ entity_ref: "episode/tvdb-121361-s2e5", expires_at: Date.now() + 60_000 });
    await clearMiss(e, "episode/tvdb-121361-s2e5");
    expect(e.DB.misses).toHaveLength(0);
  });

  it("never calls upstream when we hold no TVDB id for the subject", async () => {
    stubFetch(ok([{ slug: "tvtime", status: "active" }]));
    // No client id and nothing cached: there is no reference to ask about.
    expect(await loadArchivePage(env(), "show", 1399, 2, 5, "USER-A", null, null)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("⚠️ reads the next cursor from `nextCursor`, not `cursor`", async () => {
    // The REQUEST parameter is `cursor`; the RESPONSE field is `nextCursor`. Reading
    // the wrong one is silent — the cursor is simply always undefined, so hasMore is
    // always false and "load more" never appears. Measured on House of the Dragon,
    // which returned a full page of 20 with no way to reach page two.
    stubFetch(
      ok([{ slug: "tvtime", status: "active" }]),
      ok({ comments: [{ id: "a" }], nextCursor: "eyJjMi...", complete: false }),
    );
    const page = await load(env());
    expect(page?.cursor).toBe("eyJjMi...");
    expect(page?.complete).toBe(false);
  });

  it("reports no next page when upstream sends no cursor", async () => {
    stubFetch(
      ok([{ slug: "tvtime", status: "active" }]),
      ok({ comments: [{ id: "a" }], complete: true }),
    );
    const page = await load(env());
    expect(page?.cursor).toBeNull();
  });

  it("⚠️ drops a suppressed row, and does NOT top the page back up", async () => {
    const e = env();
    e.DB.suppressed.push("bad");
    stubFetch(
      ok([{ slug: "tvtime", status: "active" }]),
      ok({ comments: [{ id: "good" }, { id: "bad" }, { id: "alsogood" }], nextCursor: "c2" }),
    );
    const page = await load(e);
    // Applied after the fetch — the archive has no concept of our moderation.
    expect((page!.comments as any[]).map((c) => c.id)).toEqual(["good", "alsogood"]);
    // ⚠️ A filtered page comes back SHORT and stays short. Topping it up would spend
    // quota and produce a misleading list; the cursor survives, so the next page
    // arrives on demand.
    expect(page!.cursor).toBe("c2");
    // One sources call + one comments call. No second fetch to backfill.
    expect(calls).toHaveLength(2);
  });

  it("carries the actor header, so the page comes back viewer-aware", async () => {
    stubFetch(ok([{ slug: "tvtime", status: "active" }]), ok({ comments: [] }));
    await load(env());
    const read = calls[calls.length - 1];
    expect((read.init.headers as any)["X-TVTA-Actor-ID"]).toMatch(/^[0-9a-f]{64}$/);
    // ⚠️ BOTH path segments. `/entities/tvdb-…/comments` — with the type omitted —
    // answers 404 not_archived, which reads exactly like an unarchived title.
    expect(read.url).toContain("/entities/episode/tvdb-121361-s2e5/comments");
    // …and the source filter excludes us.
    expect(read.url).toContain("source=tvtime");
    expect(read.url).not.toContain("flickto");
  });
});

describe("cross-app blocking", () => {
  const load = (e: any) => loadArchivePage(e, "show", 1399, 2, 5, "USER-A", 121361, null);
  const withBlock = (e: any, slug: string, authorId: string) =>
    e.DB.blocks.push({ blocker_id: "USER-A", source_slug: slug, author_id: authorId });

  it("drops a blocked author's comments", async () => {
    const e = env();
    withBlock(e, "tvtime", "author-1");
    stubFetch(
      ok([{ slug: "tvtime", status: "active" }]),
      ok({
        comments: [
          { id: "a", origin: { slug: "tvtime" }, userId: "author-1" },
          { id: "b", origin: { slug: "tvtime" }, userId: "author-2" },
        ],
      }),
    );
    expect((await load(e))!.comments.map((c: any) => c.id)).toEqual(["b"]);
  });

  it("⚠️ scopes the block to its SOURCE — the same id elsewhere is a different person", async () => {
    const e = env();
    withBlock(e, "tvtime", "author-1");
    stubFetch(
      ok([{ slug: "tvtime", status: "active" }, { slug: "seenr", status: "active" }]),
      ok({
        comments: [
          { id: "a", origin: { slug: "tvtime" }, userId: "author-1" },
          // Archive author ids are opaque and scoped to their source. Matching on the
          // id alone would block a stranger in another app.
          { id: "b", origin: { slug: "seenr" }, userId: "author-1" },
        ],
      }),
    );
    expect((await load(e))!.comments.map((c: any) => c.id)).toEqual(["b"]);
  });

  it("⚠️ filters blocked authors out of REPLIES too", async () => {
    const e = env();
    withBlock(e, "tvtime", "author-1");
    stubFetch(
      ok([{ slug: "tvtime", status: "active" }]),
      ok({
        comments: [
          {
            id: "parent",
            origin: { slug: "tvtime" },
            userId: "author-2",
            replies: [
              { id: "r1", origin: { slug: "tvtime" }, userId: "author-1" },
              { id: "r2", origin: { slug: "tvtime" }, userId: "author-3" },
            ],
          },
        ],
      }),
    );
    // A blocked author still visible under someone else's comment is exactly the
    // "I blocked them and they are still here" failure this exists to prevent.
    const page = await load(e);
    expect((page!.comments[0] as any).replies.map((r: any) => r.id)).toEqual(["r2"]);
  });

  it("leaves the page untouched when nothing is blocked", async () => {
    const e = env();
    stubFetch(
      ok([{ slug: "tvtime", status: "active" }]),
      ok({ comments: [{ id: "a", origin: { slug: "tvtime" }, userId: "author-1" }] }),
    );
    expect((await load(e))!.comments).toHaveLength(1);
  });
});

describe("platformSources", () => {
  const row = (slug: string) => ({ slug, displayName: slug, kind: "app", status: "active" }) as any;

  it("takes the first two catalog rows, which §9 fixes as the platform entries", () => {
    const out = platformSources([row("tvtime"), row("commsunitv"), row("flickto"), row("other")]);
    expect(out.map((s: any) => s.slug)).toEqual(["tvtime", "commsunitv"]);
  });

  it("⚠️ yields nothing when commsunitv is not among them, rather than the wrong brand", () => {
    // Position alone is not identity. If the catalog is ever reordered, a banner built
    // on slice(0,2) would attribute the archive to whichever partner sorted first —
    // showing someone else's mark under "Comments by commsuni.tv".
    expect(platformSources([row("flickto"), row("tvtime"), row("commsunitv")])).toEqual([]);
  });

  it("yields nothing when the catalog is unavailable", () => {
    // A half-built banner reads as broken; no banner waits for the next request.
    expect(platformSources([])).toEqual([]);
  });
});
