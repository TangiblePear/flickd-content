const SLUG = /^[a-z0-9-]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(["MEDIA", "PEOPLE"]);

export function validateDraft(draft) {
  const errs = [];
  if (!draft || typeof draft !== "object") return ["draft is not an object"];

  if (typeof draft.id !== "string" || !SLUG.test(draft.id))
    errs.push("id must be a lowercase-kebab slug");
  if (typeof draft.eventName !== "string" || !draft.eventName.trim())
    errs.push("eventName missing");
  if (typeof draft.year !== "number" || draft.year < 1900 || draft.year > 2100)
    errs.push("year out of range");
  if (typeof draft.startDate !== "string" || !ISO_DATE.test(draft.startDate))
    errs.push("startDate must be YYYY-MM-DD");
  if (typeof draft.endDate !== "string" || !ISO_DATE.test(draft.endDate))
    errs.push("endDate must be YYYY-MM-DD");
  if (
    draft.ceremonyDate != null &&
    (typeof draft.ceremonyDate !== "string" || !ISO_DATE.test(draft.ceremonyDate))
  )
    errs.push("ceremonyDate must be YYYY-MM-DD or null");

  if (!Array.isArray(draft.categories) || draft.categories.length === 0) {
    errs.push("categories must be a non-empty array");
    return errs;
  }

  draft.categories.forEach((c, ci) => {
    const where = `categories[${ci}]`;
    if (typeof c.name !== "string" || !c.name.trim()) errs.push(`${where}.name missing`);
    if (!KINDS.has(c.kind)) errs.push(`${where}.kind must be MEDIA or PEOPLE`);
    if (!Array.isArray(c.nominees)) {
      errs.push(`${where}.nominees must be an array`);
      return;
    }
    c.nominees.forEach((n, ni) => {
      const w2 = `${where}.nominees[${ni}]`;
      if (typeof n.title !== "string" || !n.title.trim()) errs.push(`${w2}.title missing`);
      if (n.tmdbId != null && typeof n.tmdbId !== "number")
        errs.push(`${w2}.tmdbId must be number or null`);
      if (n.type != null && n.type !== "MOVIE" && n.type !== "TV")
        errs.push(`${w2}.type must be MOVIE or TV when set`);
      if (n.isWinner != null && typeof n.isWinner !== "boolean")
        errs.push(`${w2}.isWinner must be boolean when set`);
    });
  });

  return errs;
}

export function emptySeason(draft) {
  return {
    id: draft.id,
    eventName: draft.eventName,
    year: draft.year,
    startDate: draft.startDate,
    endDate: draft.endDate,
    ceremonyDate: draft.ceremonyDate ?? null,
    categories: draft.categories.map((c) => ({
      name: c.name,
      kind: c.kind,
      nominees: [],
    })),
  };
}
