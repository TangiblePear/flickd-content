import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { AwardSeason, Template } from "../types";

export default function NewAward() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [picked, setPicked] = useState<Template | null>(null);
  const [year, setYear] = useState(new Date().getFullYear() + 1);
  const [ceremonyDate, setCeremonyDate] = useState("");
  const [nomsDate, setNomsDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.templates().then(setTemplates).catch((e) => setErr(String(e)));
  }, []);

  const create = async () => {
    if (!picked) return;
    setSaving(true);
    setErr(null);
    try {
      const slug = `${picked.slugPrefix}-${year}`;
      const endDate = ceremonyDate
        ? addDays(ceremonyDate, 30)
        : `${year}-12-31`;
      const payload: AwardSeason = {
        id: slug,
        eventName: picked.eventName,
        year,
        startDate: nomsDate || `${year}-01-01`,
        endDate,
        ceremonyDate: ceremonyDate || null,
        categories: picked.categories.map((c) => ({
          name: c.name,
          kind: c.kind,
          nominees: [],
        })),
      };
      await api.saveSeason(slug, payload);
      navigate(`/awards/${slug}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2>New ceremony</h2>
      {err && <div className="banner err">{err}</div>}
      <div className="card">
        <label>Template</label>
        <div className="template-grid">
          {templates.map((t) => (
            <div
              key={t.templateId}
              className="pick"
              style={{ borderColor: picked?.templateId === t.templateId ? "var(--accent)" : undefined }}
              onClick={() => setPicked(t)}
            >
              <h4>{t.displayName}</h4>
              <small>{t.categories.length} categories</small>
            </div>
          ))}
        </div>
      </div>
      {picked && (
        <div className="card stack">
          <div className="row" style={{ gap: 24 }}>
            <div style={{ flex: 1 }}>
              <label>Year</label>
              <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Nominations announced</label>
              <input type="date" value={nomsDate} onChange={(e) => setNomsDate(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Ceremony date</label>
              <input type="date" value={ceremonyDate} onChange={(e) => setCeremonyDate(e.target.value)} />
            </div>
          </div>
          <div className="row">
            <button onClick={create} disabled={saving}>
              {saving ? "creating…" : `Create ${picked.slugPrefix}-${year}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function addDays(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
