import { useEffect, useState } from "react";
import { api } from "../api";
import type { TmdbResult } from "../types";

interface Props {
  placeholder?: string;
  onPick: (hit: TmdbResult) => void;
}

export default function TmdbSearch({ placeholder, onPick }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<TmdbResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api.tmdbSearch(q);
        setResults(r.results);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [q]);

  return (
    <div className="tmdb-search">
      <input
        type="text"
        placeholder={placeholder ?? "Search TMDB…"}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {results.length > 0 && (
        <div className="tmdb-results">
          {results.map((r) => (
            <div
              key={r.tmdbId}
              className="hit"
              onClick={() => {
                onPick(r);
                setQ("");
                setResults([]);
              }}
            >
              {r.posterUrl ? <img src={r.posterUrl} alt="" /> : <div style={{ width: 40 }} />}
              <div>
                <div className="title">
                  {r.title}{" "}
                  <span className="meta">· {r.type} {r.year ?? ""}</span>
                </div>
                <div className="meta">{r.overview.slice(0, 140)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {loading && <div className="banner">searching…</div>}
    </div>
  );
}
