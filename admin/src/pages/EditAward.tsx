import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import TmdbSearch from "../components/TmdbSearch";
import type { AwardSeason, Nominee } from "../types";

export default function EditAward() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [season, setSeason] = useState<AwardSeason | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

  const remove = async () => {
    if (!confirm(`Delete ${season.eventName} ${season.year}? This cannot be undone.`)) return;
    setDeleting(true);
    setBanner(null);
    try {
      await api.deleteSeason(slug);
      navigate("/awards");
    } catch (e) {
      setBanner({ text: String(e), kind: "err" });
      setDeleting(false);
    }
  };

  const updateDate = (field: "startDate" | "endDate" | "ceremonyDate", value: string) => {
    setSeason({ ...season, [field]: field === "ceremonyDate" ? (value || null) : value });
  };

  return (
    <div>
      <div className="row between">
        <div>
          <h2 style={{ marginBottom: 4 }}>{season.eventName} {season.year}</h2>
        </div>
        <div className="row">
          <Link to={`/awards/${slug}/winners`}>
            <button className="ghost">Mark winners →</button>
          </Link>
          <button onClick={save} disabled={saving || deleting}>{saving ? "saving…" : "Save & push"}</button>
          <button className="danger" onClick={remove} disabled={saving || deleting}>
            {deleting ? "deleting…" : "Delete"}
          </button>
        </div>
      </div>
      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

      <div className="card">
        <div className="row" style={{ gap: 24 }}>
          <div style={{ flex: 1 }}>
            <label>Nominations announced (startDate)</label>
            <input
              type="date"
              value={season.startDate}
              onChange={(e) => updateDate("startDate", e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Ceremony date</label>
            <input
              type="date"
              value={season.ceremonyDate ?? ""}
              onChange={(e) => updateDate("ceremonyDate", e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Archive cutoff (endDate)</label>
            <input
              type="date"
              value={season.endDate}
              onChange={(e) => updateDate("endDate", e.target.value)}
            />
          </div>
        </div>
        <p className="banner" style={{ marginTop: 12, marginBottom: 0 }}>
          Active window: <code>startDate</code> ≤ today ≤ <code>endDate</code>. After <code>endDate</code> the season moves to Past Seasons.
        </p>
      </div>

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
