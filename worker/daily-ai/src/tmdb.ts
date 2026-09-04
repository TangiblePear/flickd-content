const TMDB_BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w500";

export interface ResolvedTitle {
  tmdbId: number;
  title: string;
  type: "MOVIE" | "TV";
  posterUrl: string | null;
}

export async function resolveTmdb(
  apiKey: string,
  query: string,
  preferredType: "movie" | "tv",
  year?: number,
): Promise<ResolvedTitle | null> {
  const endpoint = preferredType === "tv" ? "search/tv" : "search/movie";
  const yearParam =
    year !== undefined
      ? preferredType === "tv"
        ? `&first_air_date_year=${year}`
        : `&year=${year}`
      : "";
  const url = `${TMDB_BASE}/${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(query)}${yearParam}&include_adult=false`;

  const r = await fetch(url);
  if (!r.ok) return null;
  const json = (await r.json()) as {
    results?: Array<{
      id: number;
      title?: string;
      name?: string;
      poster_path?: string | null;
    }>;
  };
  const hit = json.results?.[0];
  if (!hit) return null;
  return {
    tmdbId: hit.id,
    title: hit.title ?? hit.name ?? query,
    type: preferredType === "tv" ? "TV" : "MOVIE",
    posterUrl: hit.poster_path ? `${POSTER_BASE}${hit.poster_path}` : null,
  };
}

/**
 * One number about one title, fetched only for the titles a puzzle has already shortlisted.
 *
 * Flickology's episode-count and box-office axes need a figure that is not in the pool,
 * and the pool is 1,600 titles. Enriching all of them would be 1,600 calls a day forever
 * to feed two axes that come round once every five days and use five titles each. So the
 * generator picks its candidates first and asks about those — a few dozen calls, on the
 * days it actually needs them.
 *
 * ⚠️ Returns null on anything but a clean answer, INCLUDING a zero. TMDB stores 0 for
 * revenue it has no figure for, which is most older, foreign and streaming-first films —
 * not a small box office, an absent one. Ordering those would be a coin toss dressed as a
 * fact, so a title without a real number is dropped from the candidate set rather than
 * ranked at the bottom.
 */
export async function fetchTitleFigure(
  apiKey: string,
  tmdbId: number,
  field: "episodes" | "revenue",
): Promise<number | null> {
  const path = field === "episodes" ? `tv/${tmdbId}` : `movie/${tmdbId}`;
  try {
    const r = await fetch(`${TMDB_BASE}/${path}?api_key=${apiKey}`);
    if (!r.ok) return null;
    const json = (await r.json()) as { number_of_episodes?: number; revenue?: number };
    const value = field === "episodes" ? json.number_of_episodes : json.revenue;
    return typeof value === "number" && value > 0 ? value : null;
  } catch {
    return null;
  }
}
