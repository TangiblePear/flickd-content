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
