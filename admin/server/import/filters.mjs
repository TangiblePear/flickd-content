// Categories that appear on award-ceremony pages but are NOT competitive
// nominee categories. These get dropped from every import source so the
// curated season only contains real categories with nominees.
//
// Extend by adding plain phrases (case-insensitive substring match). Use the
// shortest distinctive phrase — "honorary" matches "Honorary Award",
// "Honorary Oscar", "Honorary Awards", etc.
const EXCLUDED_PHRASES = [
  "in memoriam",
  "honorary",
  "humanitarian",
  // Non-media categories — no TMDB representation, so they can't render
  // in the catalog-driven Android UI. Mirrors the client-side denylist in
  // AwardSeasonRepository.EXCLUDED_CATEGORY_PHRASES.
  "podcast",
];

// Boilerplate headings that aren't awards at all (Wikipedia structure).
const STRUCTURE_PHRASES = [
  "references",
  "see also",
  "external links",
  "notes",
  "bibliography",
];

export function isExcludedCategory(name) {
  const n = String(name ?? "").toLowerCase();
  if (!n.trim()) return true;
  for (const p of EXCLUDED_PHRASES) if (n.includes(p)) return true;
  for (const p of STRUCTURE_PHRASES) if (n.includes(p)) return true;
  return false;
}

export function sanitizeDraft(draft) {
  if (!draft || !Array.isArray(draft.categories)) return draft;
  return {
    ...draft,
    categories: draft.categories.filter((c) => !isExcludedCategory(c?.name)),
  };
}
