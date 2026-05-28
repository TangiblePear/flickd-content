const TMDB_BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w500";

const key = () => {
  const k = process.env.TMDB_API_KEY;
  if (!k) throw new Error("TMDB_API_KEY missing in admin/.env.local");
  return k;
};

export async function searchTmdb(query) {
  const url = `${TMDB_BASE}/search/multi?api_key=${key()}&query=${encodeURIComponent(query)}&include_adult=false`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`tmdb ${r.status}`);
  const json = await r.json();
  return (json.results ?? [])
    .filter((x) => x.media_type === "movie" || x.media_type === "tv")
    .slice(0, 12)
    .map((x) => ({
      tmdbId: x.id,
      title: x.title ?? x.name ?? "(untitled)",
      type: x.media_type === "tv" ? "TV" : "MOVIE",
      year: (x.release_date ?? x.first_air_date ?? "").slice(0, 4) || null,
      posterUrl: x.poster_path ? `${POSTER_BASE}${x.poster_path}` : null,
      overview: x.overview ?? "",
    }));
}

