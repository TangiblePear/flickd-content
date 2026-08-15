import { describe, it, expect } from "vitest";
import { PUBLIC_LIST_TAGS, isValidTag, normaliseTags } from "./publicListTags";

describe("the tag vocabulary", () => {
  it("is all lowercase kebab, because the slug is the wire format and a key", () => {
    for (const t of PUBLIC_LIST_TAGS) expect(t).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("has no duplicates", () => {
    expect(new Set(PUBLIC_LIST_TAGS).size).toBe(PUBLIC_LIST_TAGS.length);
  });

  it("rejects anything outside the vocabulary", () => {
    expect(isValidTag("horror")).toBe(true);
    expect(isValidTag("Horror")).toBe(false);
    expect(isValidTag("my-own-tag")).toBe(false);
  });
});

describe("normaliseTags", () => {
  it("drops invalid entries rather than failing the whole publish", () => {
    expect(normaliseTags(["horror", "not-a-real-tag", "crime"])).toEqual(["crime", "horror"]);
  });

  it("dedupes", () => {
    expect(normaliseTags(["horror", "horror"])).toEqual(["horror"]);
  });

  it("caps at five", () => {
    const six = PUBLIC_LIST_TAGS.slice(0, 6);
    expect(normaliseTags(six)).toHaveLength(5);
  });

  it("returns [] for junk, so the caller's 'at least one tag' check is the only gate", () => {
    expect(normaliseTags(null)).toEqual([]);
    expect(normaliseTags("horror")).toEqual([]);
    expect(normaliseTags([1, 2, 3])).toEqual([]);
  });
});
