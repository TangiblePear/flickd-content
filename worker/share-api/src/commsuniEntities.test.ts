// Entity addressing for commsuni.tv.
//
// The properties pinned here are the ones that fail SILENTLY: a reference that is
// well-formed but points at the wrong conversation, and a map that overwrites an
// immutable pair. Both publish a user's words somewhere they do not belong, and
// neither produces an error anywhere.

import { describe, it, expect } from "vitest";
import { entityReference, lookupTvdbId, refPath, rememberTvdbId, resolveReference } from "./commsuniEntities";

/** Minimal `tvdb_map` stand-in. Throws on SQL it does not recognise, like the others. */
class FakeD1 {
  rows: any[] = [];
  prepare(sql: string) {
    return new FakeStmt(this, sql.replace(/\s+/g, " ").trim());
  }
}

class FakeStmt {
  private args: any[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...a: unknown[]) {
    this.args = a as any[];
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.startsWith("SELECT tvdb_id FROM tvdb_map")) {
      const r = this.db.rows.find((x) => x.media_type === this.args[0] && x.tmdb_id === this.args[1]);
      return r ? ({ tvdb_id: r.tvdb_id } as T) : null;
    }
    throw new Error("unhandled SQL: " + this.sql);
  }
  async run() {
    if (this.sql.startsWith("INSERT OR IGNORE INTO tvdb_map")) {
      const [media_type, tmdb_id, tvdb_id, created_at] = this.args;
      // OR IGNORE: the primary key is (media_type, tmdb_id), so an existing pair stands.
      const exists = this.db.rows.some((x) => x.media_type === media_type && x.tmdb_id === tmdb_id);
      if (!exists) this.db.rows.push({ media_type, tmdb_id, tvdb_id, created_at });
      return { success: true, meta: { changes: exists ? 0 : 1 } };
    }
    throw new Error("unhandled SQL: " + this.sql);
  }
}

const env = () => ({ DB: new FakeD1() }) as any;

describe("entityReference", () => {
  it("builds the four TYPE + ID pairs the archive uses", () => {
    expect(entityReference("show", 121361)).toEqual({ type: "show", id: "tvdb-121361" });
    expect(entityReference("show", 121361, 2)).toEqual({ type: "season", id: "tvdb-121361-s2" });
    expect(entityReference("show", 121361, 2, 5)).toEqual({ type: "episode", id: "tvdb-121361-s2e5" });
    expect(entityReference("movie", 12345)).toEqual({ type: "movie", id: "tvdb-12345" });
  });

  it("⚠️ carries the TYPE separately — it is a path segment, not part of the id", () => {
    // `/v1/entities/{entityType}/{entityId}/comments`. Omitting the type answers
    // 404 not_archived, which is indistinguishable from "this title has no
    // conversation" — four of the biggest shows on television came back empty
    // before the missing segment was spotted, and the negative cache remembered
    // every one of them. A movie's id is a plain `tvdb-{n}`, same as a show's; the
    // type is the only thing separating two overlapping TheTVDB id spaces.
    expect(refPath(entityReference("movie", 12345)!)).toBe("movie/tvdb-12345");
    expect(refPath(entityReference("show", 12345)!)).toBe("show/tvdb-12345");
    expect(entityReference("movie", 12345)!.id).toBe(entityReference("show", 12345)!.id);
  });

  it("treats the -1 sentinels as 'level does not apply', never as a real season", () => {
    // -1 is the sentinel the whole comment stack uses; season/episode are never null.
    expect(entityReference("show", 99, -1, -1)).toEqual({ type: "show", id: "tvdb-99" });
    expect(entityReference("show", 99, 3, -1)).toEqual({ type: "season", id: "tvdb-99-s3" });
    // A movie can never carry a level, even if one is somehow passed.
    expect(entityReference("movie", 99, 3, 4)).toEqual({ type: "movie", id: "tvdb-99" });
  });

  it("refuses an id that would address nothing", () => {
    expect(entityReference("show", 0)).toBeNull();
    expect(entityReference("show", -1)).toBeNull();
    expect(entityReference("movie", Number.NaN)).toBeNull();
  });
});

describe("tvdb_map", () => {
  it("remembers a pair and reads it back", async () => {
    const e = env();
    await rememberTvdbId(e, "show", 1399, 121361);
    expect(await lookupTvdbId(e, "show", 1399)).toBe(121361);
  });

  it("keeps media types in separate id spaces", async () => {
    const e = env();
    await rememberTvdbId(e, "show", 550, 111);
    await rememberTvdbId(e, "movie", 550, 222);
    expect(await lookupTvdbId(e, "show", 550)).toBe(111);
    expect(await lookupTvdbId(e, "movie", 550)).toBe(222);
  });

  it("⚠️ never overwrites an existing pair — the mapping is immutable", async () => {
    const e = env();
    await rememberTvdbId(e, "show", 1399, 121361);
    await rememberTvdbId(e, "show", 1399, 999999);
    // Overwriting would move every future comment to a different conversation and
    // orphan everything already published under the old reference.
    expect(await lookupTvdbId(e, "show", 1399)).toBe(121361);
    expect(e.DB.rows).toHaveLength(1);
  });

  it("drops invalid ids rather than storing a reference to nothing", async () => {
    const e = env();
    await rememberTvdbId(e, "show", 1399, 0);
    await rememberTvdbId(e, "show", 0, 121361);
    expect(e.DB.rows).toHaveLength(0);
  });

  it("returns null for a title nobody has resolved — normal, not an error", async () => {
    expect(await lookupTvdbId(env(), "show", 424242)).toBeNull();
  });
});

describe("resolveReference", () => {
  it("prefers the client's id AND teaches the map, so the server can address it later", async () => {
    const e = env();
    const ref = await resolveReference(e, "show", 1399, 2, 5, 121361);
    expect(ref).toEqual({ type: "episode", id: "tvdb-121361-s2e5" });
    // The teaching half is what lets the outbox drain and the admin panel resolve an
    // entity with no client present.
    expect(await lookupTvdbId(e, "show", 1399)).toBe(121361);
  });

  it("falls back to the cache when the client sends nothing", async () => {
    const e = env();
    await rememberTvdbId(e, "movie", 550, 777);
    expect(await resolveReference(e, "movie", 550, -1, -1, null)).toEqual({
      type: "movie",
      id: "tvdb-777",
    });
  });

  it("returns null when neither side has an id — the archive section is simply absent", async () => {
    expect(await resolveReference(env(), "show", 424242, -1, -1, null)).toBeNull();
  });
});
