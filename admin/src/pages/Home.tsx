import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { SeasonSummary } from "../types";

export default function Home() {
  const [seasons, setSeasons] = useState<SeasonSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.seasons().then(setSeasons).catch((e) => setErr(String(e)));
  }, []);

  return (
    <div>
      <div className="row between">
        <h2>Awards</h2>
        <Link to="/awards/new">
          <button>+ New ceremony</button>
        </Link>
      </div>
      {err && <div className="banner err">{err}</div>}
      <div className="grid-seasons">
        {seasons.map((s) => {
          const pct = s.nomineeCount === 0 ? 0 : Math.round((s.winnerCount / s.nomineeCount) * 100);
          return (
            <Link key={s.slug} to={`/awards/${s.slug}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div className="season-card">
                <h3>{s.eventName} {s.year}</h3>
                <div className="meta">
                  {s.ceremonyDate ?? "no date"} · {s.nomineeCount} nominees · {s.winnerCount} winners
                </div>
                <div className="progress"><div style={{ width: `${pct}%` }} /></div>
              </div>
            </Link>
          );
        })}
        {seasons.length === 0 && !err && <div className="banner">No award seasons yet. Create one →</div>}
      </div>
    </div>
  );
}
