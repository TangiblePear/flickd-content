import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import TmdbSearch from "../components/TmdbSearch";
import type { AwardSeason, Nominee } from "../types";

export default function EditAward() {
  const { slug = "" } = useParams();
  const [season, setSeason] = useState<AwardSeason | null>(null);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [personDraft, setPersonDraft] = useState<Record<number, string>>({});

  useEffect(() => {
    api.season(slug).then(setSeason).catch((e) => setBanner({ text: String(e), kind: "err" }));
  }, [slug]);

  if (!season) return <div className="banner">loading…</div>;

  const addNominee = (categoryIndex: number, nominee: Nominee) => {
    const next = structuredClone(season);
    const existing = next.categories[categoryIndex].nominees;
    if (!existing.some((n) => n.tmdbId === nominee.tmdbId && n.personName === nominee.personName)) {
      existing.push(nominee);
      setSeason(next);
    }
  };

  const removeNominee = (categoryIndex: number, nIndex: number) => {
    const next = structuredClone(season);
    next.categories[categoryIndex].nominees.splice(nIndex, 1);
    setSeason(next);
  };

  const save = async () => {
    setSaving(true);
    setBanner(null);
    try {
      await api.saveSeason(slug, season);
      setBanner({ text: "saved and committed", kind: "ok" });
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
          <h2 style={{ marginBottom: 4 }}>{season.eventName} {season.year}</h2>
          <div className="banner" style={{ display: "inline-block", marginBottom: 16 }}>
            {season.startDate} → {season.endDate} · ceremony {season.ceremonyDate ?? "—"}
          </div>
        </div>
        <div className="row">
          <Link to={`/awards/${slug}/winners`}>
            <button className="ghost">Mark winners →</button>
          </Link>
          <button onClick={save} disabled={saving}>{saving ? "saving…" : "Save & push"}</button>
        </div>
      </div>
      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

      {season.categories.map((cat, ci) => (
        <div key={cat.name} className="category">
          <header>
            <div>
              <h3>{cat.name}</h3>
              <span className="kind">{cat.kind} · {cat.nominees.length} nominees</span>
            </div>
          </header>
          <div className="body stack">
            <div className="nominees">
              {cat.nominees.map((n, ni) => (
                <div key={`${n.tmdbId}-${ni}`} className="nominee">
                  {n.posterUrl ? <img src={n.posterUrl} alt="" /> : null}
                  <div>
                    {n.personName && <div className="winner">{n.personName}</div>}
                    <div>{n.title}</div>
                  </div>
                  <button className="remove" onClick={() => removeNominee(ci, ni)}>×</button>
                </div>
              ))}
            </div>
            {cat.kind === "PEOPLE" ? (
              <div className="stack">
                <input
                  type="text"
                  placeholder="Person name (e.g. Cillian Murphy)"
                  value={personDraft[ci] ?? ""}
                  onChange={(e) => setPersonDraft({ ...personDraft, [ci]: e.target.value })}
                />
                <TmdbSearch
                  placeholder="…then pick the film/show this nomination is for"
                  onPick={(hit) => {
                    const name = (personDraft[ci] ?? "").trim();
                    if (!name) return;
                    addNominee(ci, {
                      tmdbId: hit.tmdbId,
                      title: hit.title,
                      type: hit.type,
                      posterUrl: hit.posterUrl,
                      personName: name,
                    });
                    setPersonDraft({ ...personDraft, [ci]: "" });
                  }}
                />
              </div>
            ) : (
              <TmdbSearch
                onPick={(hit) =>
                  addNominee(ci, {
                    tmdbId: hit.tmdbId,
                    title: hit.title,
                    type: hit.type,
                    posterUrl: hit.posterUrl,
                  })
                }
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
