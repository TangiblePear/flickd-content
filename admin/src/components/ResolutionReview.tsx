import { useState } from "react";
import { api } from "../api";
import type { ReviewQueueItem, TmdbResult } from "../types";

interface Props {
  item: ReviewQueueItem;
  onPick: (hit: TmdbResult) => void;
}

export default function ResolutionReview({ item, onPick }: Props) {
  const [query, setQuery] = useState(item.title);
  const [hits, setHits] = useState<TmdbResult[]>([]);
  const [searching, setSearching] = useState(false);

  const runSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const r = await api.tmdbSearch(query);
      setHits(r.results);
    } finally {
      setSearching(false);
    }
  };

  const candidates = hits.length ? hits : item.candidates;
  const badgeColor =
    item.status === "ambiguous" ? "var(--accent)" : "var(--danger)";

  return (
    <div className="card stack">
      <div className="row between">
        <div>
          <strong>{item.title}</strong>
          {item.references.length > 1 && (
            <span style={{ color: "var(--muted)", marginLeft: 8 }}>
              · appears in {item.references.length} categories
            </span>
          )}
          <div style={{ color: "var(--muted)", fontSize: 12 }}>
            {item.categoryNames.join(" · ")}
          </div>
        </div>
        <span
          style={{
            color: badgeColor,
            fontSize: 11,
            border: `1px solid ${badgeColor}`,
            padding: "2px 8px",
            borderRadius: 999,
            textTransform: "uppercase",
          }}
        >
          {item.status}
        </span>
      </div>

      <div className="row">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search TMDB"
        />
        <button className="ghost" onClick={runSearch} disabled={searching}>
          {searching ? "…" : "Search"}
        </button>
      </div>

      {candidates.length > 0 && (
        <div className="tmdb-results" style={{ maxHeight: 260 }}>
          {candidates.map((c) => (
            <div key={c.tmdbId} className="hit" onClick={() => onPick(c)}>
              {c.posterUrl ? (
                <img src={c.posterUrl} alt="" />
              ) : (
                <div style={{ width: 40 }} />
              )}
              <div>
                <div className="title">
                  {c.title}{" "}
                  <span className="meta">
                    · {c.type} {c.year ?? ""}
                  </span>
                </div>
                <div className="meta">{c.overview.slice(0, 140)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
