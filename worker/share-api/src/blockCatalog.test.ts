import { describe, it, expect } from "vitest";
import { metaFor } from "./blockCatalog";

describe("metaFor", () => {
  it("mirrors ProfileBlockCatalog.kt for the curated half", () => {
    expect(metaFor("bio")).toEqual({
      friendVisible: true,
      ownerOnly: false,
      publicVisible: true,
      sensitive: false,
    });
    expect(metaFor("fav_shows").publicVisible).toBe(true);
    expect(metaFor("personality").publicVisible).toBe(true);
  });

  it("marks the behavioural half friend-visible but not public", () => {
    expect(metaFor("stat_mosaic")).toEqual({
      friendVisible: true,
      ownerOnly: false,
      publicVisible: false,
      sensitive: false,
    });
    expect(metaFor("wrapped").publicVisible).toBe(false);
    expect(metaFor("genre_dna").publicVisible).toBe(false);
    expect(metaFor("streak").publicVisible).toBe(false);
  });

  it("marks the per-title blocks sensitive", () => {
    for (const t of ["currently_watching", "top_rated", "recent_activity"]) {
      expect(metaFor(t).sensitive).toBe(true);
      expect(metaFor(t).publicVisible).toBe(false);
    }
  });

  /**
   * The single most important line in the file. A type the server has never
   * heard of must not reach anyone — Android's `metaFor` defaults the same way,
   * and a newer app introducing a block must not be able to publish it here by
   * simply naming it.
   */
  it("defaults an unknown type to owner-only", () => {
    expect(metaFor("trophy_case")).toEqual({
      friendVisible: false,
      ownerOnly: true,
      publicVisible: false,
      sensitive: false,
    });
    expect(metaFor("persona_badges").ownerOnly).toBe(true);
    expect(metaFor("something_a_newer_app_invented").ownerOnly).toBe(true);
    expect(metaFor("").ownerOnly).toBe(true);
  });
});
