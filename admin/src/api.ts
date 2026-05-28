import type {
  AwardSeason,
  SeasonSummary,
  Template,
  TmdbResult,
} from "./types";

const json = async <T,>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

export const api = {
  templates: () => fetch("/api/templates").then(json<Template[]>),
  seasons: () => fetch("/api/awards").then(json<SeasonSummary[]>),
  season: (slug: string) => fetch(`/api/awards/${slug}`).then(json<AwardSeason>),
  saveSeason: (slug: string, payload: AwardSeason) =>
    fetch(`/api/awards/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json<{ ok: boolean; git: unknown }>),
  tmdbSearch: (q: string) =>
    fetch(`/api/tmdb/search?q=${encodeURIComponent(q)}`).then(
      json<{ results: TmdbResult[] }>,
    ),
};
