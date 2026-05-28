import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { AwardSeason } from "../types";

export default function Winners() {
  const { slug = "" } = useParams();
  const [season, setSeason] = useState<AwardSeason | null>(null);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ text: string; kind: "ok" | "err" } | null>(null);

  useEffect(() => {
    api.season(slug).then(setSeason).catch((e) => setBanner({ text: String(e), kind: "err" }));
  }, [slug]);

  if (!season) return <div className="banner">loading…</div>;

  const pickWinner = (ci: number, ni: number) => {
    const next = structuredClone(season);
    next.categories[ci].nominees = next.categories[ci].nominees.map((n, i) => ({
      ...n,
      isWinner: i === ni ? !n.isWinner : false,
    }));
    setSeason(next);
  };

  const save = async () => {
    setSaving(true);
    setBanner(null);
    try {
      await api.saveSeason(slug, season);
      setBanner({ text: "winners saved and pushed", kind: "ok" });
    } catch (e) {
      setBanner({ text: String(e), kind: "err" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="row between">
        <div>
          <h2 style={{ marginBottom: 4 }}>Winners · {season.eventName} {season.year}</h2>
          <Link to={`/awards/${slug}`}><button className="ghost">← back to edit</button></Link>
        </div>
        <button onClick={save} disabled={saving}>{saving ? "saving…" : "Save & push"}</button>
      </div>
      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

      {season.categories.map((cat, ci) => (
        <div key={cat.name} className="category">
          <header><h3>{cat.name}</h3></header>
          <div className="body">
            <div className="stack">
              {cat.nominees.length === 0 && <div className="banner">no nominees yet</div>}
              {cat.nominees.map((n, ni) => (
                <label
                  key={`${n.tmdbId}-${ni}`}
                  className="nominee"
                  style={{
                    cursor: "pointer",
                    borderColor: n.isWinner ? "var(--accent)" : undefined,
                  }}
                  onClick={() => pickWinner(ci, ni)}
                >
                  {n.posterUrl ? <img src={n.posterUrl} alt="" /> : null}
                  <div style={{ flex: 1 }}>
                    {n.personName && <div className="winner">{n.personName}</div>}
                    <div>{n.title}</div>
                  </div>
                  {n.isWinner && <span className="winner">★ WINNER</span>}
                </label>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
