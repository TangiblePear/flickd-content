import { describe, it, expect } from "vitest";
import { visibleLayout, visibleStats } from "./visibility";

const L = (...types: string[]) => types.map((type) => ({ type }));
const t = (blocks: unknown[]) => blocks.map((b) => (b as { type: string }).type);
const BOTH = { friendSensitive: true, publicSensitive: true };
const NEITHER = { friendSensitive: false, publicSensitive: false };

describe("visibleLayout", () => {
  it("gives the owner their layout untouched, including owner-only blocks", () => {
    const l = L("bio", "trophy_case", "recent_activity");
    expect(visibleLayout(l, "owner", NEITHER)).toEqual(l);
  });

  it("keeps order, because the public page has to match the owner's", () => {
    expect(t(visibleLayout(L("streak", "bio", "stat_mosaic"), "friend", BOTH))).toEqual([
      "streak",
      "bio",
      "stat_mosaic",
    ]);
  });

  it("withholds sensitive blocks from friends without that consent", () => {
    const l = L("bio", "recent_activity");
    expect(t(visibleLayout(l, "friend", NEITHER))).toEqual(["bio"]);
    expect(t(visibleLayout(l, "friend", BOTH))).toEqual(["bio", "recent_activity"]);
  });

  it("gives a stranger the curated half until public activity is consented", () => {
    const l = L("bio", "stat_mosaic", "recent_activity");
    expect(t(visibleLayout(l, "public", NEITHER))).toEqual(["bio"]);
    expect(t(visibleLayout(l, "public", BOTH))).toEqual(["bio", "stat_mosaic", "recent_activity"]);
  });

  /** The two consents are separate settings and must not stand in for each other. */
  it("reads the consent belonging to the audience, not the other one", () => {
    const l = L("bio", "recent_activity");
    const friendOnly = { friendSensitive: true, publicSensitive: false };
    expect(t(visibleLayout(l, "friend", friendOnly))).toEqual(["bio", "recent_activity"]);
    expect(t(visibleLayout(l, "public", friendOnly))).toEqual(["bio"]);
  });

  it("never lets an owner-only or unknown block reach anyone else", () => {
    const l = L("trophy_case", "persona_badges", "something_new", "bio");
    expect(t(visibleLayout(l, "friend", BOTH))).toEqual(["bio"]);
    expect(t(visibleLayout(l, "public", BOTH))).toEqual(["bio"]);
  });

  /** A malformed row must not become a rendered block. */
  it("drops entries that carry no usable type", () => {
    const l = [{ type: "bio" }, {}, { type: 7 }, null];
    expect(t(visibleLayout(l as unknown[], "public", BOTH))).toEqual(["bio"]);
  });
});

describe("visibleStats", () => {
  const stats = { uniqueShows: 5, topRated: [1], recentWatches: [2], currentlyWatching: [3] };

  it("gives the owner everything", () => {
    expect(visibleStats(stats, "owner", NEITHER)).toEqual(stats);
  });

  it("strips the per-title keys when the matching consent is absent", () => {
    expect(visibleStats(stats, "friend", NEITHER)).toEqual({ uniqueShows: 5 });
    expect(visibleStats(stats, "public", NEITHER)).toEqual({ uniqueShows: 5 });
  });

  it("keeps them when it is present, per audience", () => {
    expect(visibleStats(stats, "friend", { friendSensitive: true, publicSensitive: false })).toEqual(stats);
    expect(visibleStats(stats, "public", { friendSensitive: false, publicSensitive: true })).toEqual(stats);
  });

  it("does not mutate the blob it was given", () => {
    const input = { ...stats };
    visibleStats(input, "public", NEITHER);
    expect(input).toEqual(stats);
  });

  it("passes null through", () => {
    expect(visibleStats(null, "public", BOTH)).toBeNull();
  });
});
