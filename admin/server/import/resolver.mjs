import { searchTmdb } from "../tmdb.mjs";

const CONCURRENCY = 5;

// Strips editorial annotations like "[1]" (citations) or "[de; es]"
// (Wikipedia inter-language link markers) that leak in from non-parser
// sources (LLM extracts, pasted JSON). The Wikipedia parser already cleans
// these, but the resolver runs on every input mode.
const stripAnnotations = (s) =>
  String(s ?? "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const normalize = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Award eligibility window: the ceremony year and the year before (which
// covers the typical "films released in the prior calendar year" pattern
// used by the Oscars and most televised film awards).
function inAwardWindow(r, awardYear) {
  if (!awardYear || !r.year) return false;
  const y = Number(r.year);
  return y === awardYear || y === awardYear - 1;
}

// Sort candidates so the most likely matches appear first in the review
// dropdown: exact-title + in-window, then exact-title elsewhere, then by
// recency.
function rankCandidates(results, draftTitle, awardYear) {
  const t = normalize(draftTitle);
  return [...results].sort((a, b) => {
    const aExact = normalize(a.title) === t ? 1 : 0;
    const bExact = normalize(b.title) === t ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;

    if (awardYear) {
      const aIn = inAwardWindow(a, awardYear) ? 1 : 0;
      const bIn = inAwardWindow(b, awardYear) ? 1 : 0;
      if (aIn !== bIn) return bIn - aIn;
    }

    const ay = a.year ? Number(a.year) : 0;
    const by = b.year ? Number(b.year) : 0;
    return by - ay;
  });
}

function classify(draftNominee, results, awardYear) {
  if (results.length === 0) return { status: "missing", pick: null };

  const draftTitle = normalize(draftNominee.title);
  const draftYear = draftNominee.year ?? null;
  const exact = results.filter((r) => normalize(r.title) === draftTitle);

  // 1. If the source supplied an explicit per-nominee year, honor it.
  if (draftYear) {
    const yearMatch = exact.find((r) => r.year === draftYear);
    if (yearMatch) return { status: "confident", pick: yearMatch };
  }

  // 2. Auto-pick only when title matches AND year is in the award window.
  //    Anything else (no match in window, or multiple matches in window)
  //    goes to manual review so the curator can confirm.
  if (awardYear) {
    const inWindow = exact.filter((r) => inAwardWindow(r, awardYear));
    if (inWindow.length === 1) return { status: "confident", pick: inWindow[0] };
    return { status: "ambiguous", pick: null };
  }

  // 3. No award-year context (rare): fall back to title-only heuristics.
  if (results.length === 1) return { status: "confident", pick: results[0] };
  if (exact.length === 1) return { status: "confident", pick: exact[0] };
  return { status: "ambiguous", pick: null };
}

// Resolves a single unique title against TMDB. The representative nominee
// is whichever instance was encountered first within the draft — it carries
// the optional `tmdbId` override (rare, but supported), the optional
// per-nominee `year` hint, and the optional `type` hint. Per-instance
// metadata (personName, isWinner) is intentionally NOT touched here; it gets
// re-attached during the fan-out step so each output nominee keeps its own
// category-specific context.
async function resolveGroup(cleanTitle, representative, awardYear) {
  if (representative.tmdbId != null) {
    return {
      status: "confident",
      pick: {
        tmdbId: representative.tmdbId,
        title: cleanTitle,
        type: representative.type ?? "MOVIE",
        posterUrl: null,
      },
      candidates: [],
    };
  }

  let results = [];
  try {
    results = await searchTmdb(cleanTitle);
  } catch {
    return { status: "missing", pick: null, candidates: [] };
  }

  const cleanedRep = { ...representative, title: cleanTitle };
  const { status, pick } = classify(cleanedRep, results, awardYear);
  const ranked = rankCandidates(results, cleanTitle, awardYear);
  return { status, pick: status === "confident" ? pick : null, candidates: ranked };
}

// Resolves a draft season into a review-ready shape.
//
// Two-phase pipeline:
//   1. Group nominees by normalised title. The same film appearing in Best
//      Picture, Best Director, and Best Cinematography is one group with
//      three instances. Each group hits TMDB exactly once (CONCURRENCY-batched).
//   2. Fan out the resolution into the season. Each group writes its result
//      into every instance's reserved (categoryIndex, nomineeIndex) slot.
//      Per-instance metadata (personName, isWinner) is re-attached during
//      fan-out so a film nominated for both Best Picture (no person) and
//      Best Director (Christopher Nolan) keeps its category-specific context.
//
// The review queue carries ONE entry per unique title that needs a curator
// pick, with `references` pointing back at every slot that should receive
// the chosen TMDB result. UI calls a single `pickForReviewItem` and the
// pick fans out across all categories the title appears in.
export async function resolveDraft(draft) {
  const season = {
    id: draft.id,
    eventName: draft.eventName,
    year: draft.year,
    startDate: draft.startDate,
    endDate: draft.endDate,
    ceremonyDate: draft.ceremonyDate ?? null,
    // Pre-size each category's nominees array so fan-out can write into a
    // stable (ci, ni) slot in any order — preserves source ordering within
    // each category regardless of group-resolution order.
    categories: draft.categories.map((c) => ({
      name: c.name,
      kind: c.kind,
      nominees: new Array(c.nominees.length),
    })),
  };

  // 1) Group by normalised cleanTitle.
  const groups = new Map();
  draft.categories.forEach((c, ci) => {
    c.nominees.forEach((n, ni) => {
      const cleanTitle = stripAnnotations(n.title);
      const key = normalize(cleanTitle);
      let g = groups.get(key);
      if (!g) {
        g = {
          cleanTitle,
          representative: n,
          instances: [],
          categoryNames: [],
          seenCategoryNames: new Set(),
        };
        groups.set(key, g);
      }
      g.instances.push({ ci, ni, c, n });
      if (!g.seenCategoryNames.has(c.name)) {
        g.seenCategoryNames.add(c.name);
        g.categoryNames.push(c.name);
      }
    });
  });

  // 2) Resolve each unique title once (CONCURRENCY-batched).
  const groupList = [...groups.values()];
  const resolutions = new Array(groupList.length);
  for (let i = 0; i < groupList.length; i += CONCURRENCY) {
    const slice = groupList.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      slice.map((g) => resolveGroup(g.cleanTitle, g.representative, draft.year)),
    );
    settled.forEach((res, idx) => {
      resolutions[i + idx] = res;
    });
  }

  // 3) Fan out into the season + build the review queue.
  const reviewQueue = [];
  const stats = { total: 0, confident: 0, ambiguous: 0, missing: 0 };
  groupList.forEach((g, gi) => {
    const res = resolutions[gi];
    g.instances.forEach((inst) => {
      stats.total += 1;
      stats[res.status] += 1;
      const winnerProps = inst.n.isWinner === true ? { isWinner: true } : {};
      const personProps =
        inst.c.kind === "PEOPLE" && inst.n.personName
          ? { personName: inst.n.personName }
          : {};
      const slot = season.categories[inst.ci].nominees;
      if (res.status === "confident" && res.pick) {
        slot[inst.ni] = {
          tmdbId: res.pick.tmdbId,
          title: res.pick.title,
          type: res.pick.type,
          posterUrl: res.pick.posterUrl,
          ...personProps,
          ...winnerProps,
        };
      } else {
        slot[inst.ni] = {
          tmdbId: 0,
          title: g.cleanTitle,
          type: inst.n.type ?? "MOVIE",
          posterUrl: null,
          ...personProps,
          ...winnerProps,
        };
      }
    });
    if (res.status !== "confident") {
      reviewQueue.push({
        title: g.cleanTitle,
        categoryNames: g.categoryNames,
        status: res.status,
        candidates: res.candidates,
        references: g.instances.map((inst) => ({
          categoryIndex: inst.ci,
          nomineeIndex: inst.ni,
        })),
      });
    }
  });

  return { season, reviewQueue, stats };
}
