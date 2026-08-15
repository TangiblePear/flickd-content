// The curated tag vocabulary for public lists.
//
// ── Why a fixed vocabulary and not free text ─────────────────────────────────
//
// Free tags are user-generated content visible to strangers, so each one would need
// moderating; they normalise badly ("scifi" / "sci-fi" / "Sci Fi" are three tags for
// one idea); and the browse page's filter rail would have nothing stable to show.
//
// ── Why slugs here and labels on the client ──────────────────────────────────
//
// A tag label is user-facing text, and CLAUDE.md §7 requires user-facing text in all
// 25 locales. A label sent from here could only ever be English. So the SLUG is the
// wire format and the client owns the localised label (`public_tag_<slug>` in
// strings_public_lists.xml). An older client that does not know a slug title-cases it
// rather than breaking.
//
// The cost, accepted deliberately: adding a tag needs an app release to get a
// localised label.
export const PUBLIC_LIST_TAGS: readonly string[] = [
  "80s",
  "90s",
  "a24",
  "action",
  "animation",
  "anime",
  "arthouse",
  "based-on-a-book",
  "biopic",
  "British",
  "classics",
  "comedy",
  "comfort-watch",
  "coming-of-age",
  "crime",
  "cult",
  "date-night",
  "documentary",
  "drama",
  "family",
  "fantasy",
  "feel-good",
  "foreign-language",
  "halloween",
  "heist",
  "hidden-gems",
  "historical",
  "horror",
  "indie",
  "korean",
  "limited-series",
  "musical",
  "mystery",
  "neo-noir",
  "psychological",
  "road-trip",
  "romance",
  "sci-fi",
  "short-films",
  "sitcom",
  "sports",
  "spy",
  "stand-up",
  "supernatural",
  "thriller",
  "true-crime",
  "underrated",
  "war",
  "western",
  "whodunnit",
].map((t) => t.toLowerCase()).sort();

const VOCAB = new Set(PUBLIC_LIST_TAGS);

export const MAX_TAGS_PER_LIST = 5;

export function isValidTag(slug: string): boolean {
  return VOCAB.has(slug);
}

/**
 * Deduped, valid, vocabulary-ordered, capped. Invalid entries are DROPPED rather
 * than rejected: a newer client sending one unknown slug should still publish with
 * the four it got right. The caller enforces "at least one".
 */
export function normaliseTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const kept = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    if (isValidTag(raw)) kept.add(raw);
  }
  return PUBLIC_LIST_TAGS.filter((t) => kept.has(t)).slice(0, MAX_TAGS_PER_LIST);
}
