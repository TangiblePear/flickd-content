import type {
  AwardSeason,
  DraftSeason,
  ResolveResult,
  SeasonSummary,
  Template,
  TmdbResult,
} from "./types";

export type ImportSource = "text" | "url" | "prompt";

export interface ExtractRequest {
  source: ImportSource;
  text?: string;
  url?: string;
  prompt?: string;
  templateId?: string;
  year?: number;
  eventName?: string;
}

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
  deleteSeason: (slug: string) =>
    fetch(`/api/awards/${slug}`, { method: "DELETE" }).then(
      json<{ ok: boolean; git: unknown }>,
    ),
  tmdbSearch: (q: string) =>
    fetch(`/api/tmdb/search?q=${encodeURIComponent(q)}`).then(
      json<{ results: TmdbResult[] }>,
    ),
  importStatus: () =>
    fetch("/api/import/status").then(json<{ llmAvailable: boolean }>),
  importJson: (raw: string) =>
    fetch("/api/import/json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: raw }),
    }).then(json<{ draft: DraftSeason }>),
  importExtract: (body: ExtractRequest) =>
    fetch("/api/import/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ draft: DraftSeason; extractor: string }>),
  importResolve: (draft: DraftSeason) =>
    fetch("/api/import/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft }),
    }).then(json<ResolveResult>),
};
