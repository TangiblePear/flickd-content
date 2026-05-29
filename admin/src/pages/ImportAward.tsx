import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ExtractRequest, ImportSource } from "../api";
import ResolutionReview from "../components/ResolutionReview";
import type {
  AwardSeason,
  DraftSeason,
  ResolveResult,
  Template,
  TmdbResult,
} from "../types";

type Tab = "json" | "text" | "url" | "prompt";

export default function ImportAward() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("json");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [eventName, setEventName] = useState<string>("");
  const [llmAvailable, setLlmAvailable] = useState<boolean | null>(null);

  const [jsonInput, setJsonInput] = useState<string>("");
  const [textInput, setTextInput] = useState<string>("");
  const [urlInput, setUrlInput] = useState<string>("");
  const [promptInput, setPromptInput] = useState<string>("");

  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ text: string; kind: "ok" | "err" } | null>(null);

  const [resolved, setResolved] = useState<ResolveResult | null>(null);

  useEffect(() => {
    api.templates().then(setTemplates).catch(() => {});
    api.importStatus().then((s) => setLlmAvailable(s.llmAvailable)).catch(() => setLlmAvailable(false));
  }, []);

  const selectedTemplate = templates.find((t) => t.templateId === templateId);

  const slugPreview = (() => {
    if (resolved?.season.id) return resolved.season.id;
    if (!selectedTemplate) return "—";
    return `${selectedTemplate.slugPrefix}-${year}`;
  })();

  const hintsBody = {
    templateId: templateId || undefined,
    year,
    eventName: eventName || selectedTemplate?.eventName,
  };

  const runImport = async () => {
    setBanner(null);
    setResolved(null);
    setBusy("parsing");
    try {
      let draft: DraftSeason;
      if (tab === "json") {
        if (!jsonInput.trim()) throw new Error("Paste JSON first");
        const r = await api.importJson(jsonInput);
        draft = r.draft;
      } else {
        const body: ExtractRequest = { source: tab as ImportSource, ...hintsBody };
        if (tab === "text") body.text = textInput;
        if (tab === "url") body.url = urlInput;
        if (tab === "prompt") body.prompt = promptInput;
        const r = await api.importExtract(body);
        draft = r.draft;
      }
      setBusy("resolving");
      const res = await api.importResolve(draft);
      setResolved(res);
      setBusy(null);
    } catch (e) {
      setBanner({ text: String(e), kind: "err" });
      setBusy(null);
    }
  };

  // Apply a single TMDB pick to every nominee slot referenced by the queue
  // item — shared-title nominations (Best Picture + Best Director + …) are
  // resolved in one click instead of N. Per-instance personName / isWinner
  // are preserved on each slot so a film keeps its actor in PEOPLE
  // categories and its winner flag wherever the source set it.
  const pickForReviewItem = (queueIndex: number, hit: TmdbResult) => {
    if (!resolved) return;
    const next = structuredClone(resolved);
    const item = next.reviewQueue[queueIndex];
    item.references.forEach(({ categoryIndex, nomineeIndex }) => {
      const cat = next.season.categories[categoryIndex];
      const existing = cat.nominees[nomineeIndex];
      cat.nominees[nomineeIndex] = {
        tmdbId: hit.tmdbId,
        title: hit.title,
        type: hit.type,
        posterUrl: hit.posterUrl,
        ...(cat.kind === "PEOPLE" && existing.personName
          ? { personName: existing.personName }
          : {}),
        ...(existing.isWinner ? { isWinner: true } : {}),
      };
    });
    next.reviewQueue.splice(queueIndex, 1);
    setResolved(next);
  };

  const save = async () => {
    if (!resolved) return;
    if (resolved.reviewQueue.length > 0) {
      setBanner({ text: "Resolve all flagged rows before saving", kind: "err" });
      return;
    }
    setBusy("saving");
    setBanner(null);
    try {
      const payload: AwardSeason = stripUnresolved(resolved.season);
      await api.saveSeason(payload.id, payload);
      navigate(`/awards/${payload.id}`);
    } catch (e) {
      setBanner({ text: String(e), kind: "err" });
      setBusy(null);
    }
  };

  return (
    <div>
      <h2>Bulk import</h2>
      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
      {llmAvailable === false && (
        <div className="banner err">
          No LLM key configured — text / URL / prompt modes will fail. Set <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> in <code>admin/.env.local</code>. JSON mode still works.
        </div>
      )}

      <div className="card stack">
        <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label>Template (optional)</label>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">— none —</option>
              {templates.map((t) => (
                <option key={t.templateId} value={t.templateId}>{t.displayName}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 120 }}>
            <label>Year</label>
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </div>
          <div style={{ flex: 2, minWidth: 220 }}>
            <label>Event name (override)</label>
            <input
              type="text"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              placeholder={selectedTemplate?.eventName ?? "Academy Awards"}
            />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label>Slug preview</label>
            <div style={{ padding: "10px 0", color: "var(--muted)" }}>{slugPreview}</div>
          </div>
        </div>
      </div>

      <div className="card stack">
        <div className="row" style={{ gap: 4 }}>
          {(["json", "text", "url", "prompt"] as Tab[]).map((t) => (
            <button
              key={t}
              className={tab === t ? "" : "ghost"}
              onClick={() => setTab(t)}
            >
              {label(t)}
            </button>
          ))}
        </div>

        {tab === "json" && (
          <div className="stack">
            <label>Paste DraftSeason / AwardSeason JSON</label>
            <textarea
              rows={14}
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              placeholder='{"id":"oscars-2026","eventName":"Academy Awards", ...}'
            />
            <div className="banner" style={{ marginBottom: 0 }}>
              If <code>tmdbId</code> is missing on nominees, TMDB resolution runs automatically.
            </div>
          </div>
        )}

        {tab === "text" && (
          <div className="stack">
            <label>Paste raw text (Wikipedia, press release, etc.)</label>
            <textarea
              rows={14}
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Best Picture
- Oppenheimer
- Barbie
- Killers of the Flower Moon
..."
            />
          </div>
        )}

        {tab === "url" && (
          <div className="stack">
            <label>URL</label>
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://en.wikipedia.org/wiki/96th_Academy_Awards"
            />
            <div className="banner" style={{ marginBottom: 0 }}>
              Wikipedia URLs use the fast parser; other sites fall back to the LLM extractor.
            </div>
          </div>
        )}

        {tab === "prompt" && (
          <div className="stack">
            <label>Prompt</label>
            <input
              type="text"
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              placeholder="Oscars 2024 nominees"
            />
            <div className="banner" style={{ marginBottom: 0 }}>
              The LLM generates from its training data — review every row before saving.
            </div>
          </div>
        )}

        <div className="row">
          <button onClick={runImport} disabled={busy != null}>
            {busy === "parsing" ? "parsing…" : busy === "resolving" ? "resolving TMDB…" : "Import & resolve"}
          </button>
        </div>
      </div>

      {resolved && (
        <>
          <div className="card stack">
            <div className="row between">
              <h3 style={{ margin: 0 }}>
                {resolved.season.eventName} {resolved.season.year} <span style={{ color: "var(--muted)", fontWeight: 400 }}>· {resolved.season.id}</span>
              </h3>
              <div className="row">
                <span className="banner" style={{ margin: 0 }}>
                  {resolved.stats.confident}/{resolved.stats.total} confident · {resolved.stats.ambiguous} ambiguous · {resolved.stats.missing} missing
                </span>
                <button
                  onClick={save}
                  disabled={busy != null || resolved.reviewQueue.length > 0}
                  title={resolved.reviewQueue.length > 0 ? "Resolve all flagged rows first" : ""}
                >
                  {busy === "saving" ? "saving…" : "Save & push"}
                </button>
              </div>
            </div>
          </div>

          {resolved.reviewQueue.length > 0 && (
            <div className="stack">
              <h3>Needs review ({resolved.reviewQueue.length})</h3>
              {resolved.reviewQueue.map((item, idx) => (
                <ResolutionReview
                  key={`${item.title}-${idx}`}
                  item={item}
                  onPick={(hit) => pickForReviewItem(idx, hit)}
                />
              ))}
            </div>
          )}

          <div className="stack" style={{ marginTop: 24 }}>
            <h3>Preview</h3>
            {resolved.season.categories.map((cat, ci) => (
              <div key={ci} className="category">
                <header>
                  <div>
                    <h3>{cat.name}</h3>
                    <span className="kind">
                      {cat.kind} · {cat.nominees.length} nominees
                      {cat.nominees.some((n) => n.isWinner) ? " · winner detected" : ""}
                    </span>
                  </div>
                </header>
                <div className="body">
                  <div className="nominees">
                    {cat.nominees.map((n, ni) => {
                      const unresolved = !n.tmdbId;
                      const borderColor = unresolved
                        ? "var(--danger)"
                        : n.isWinner
                          ? "var(--accent)"
                          : undefined;
                      return (
                        <div
                          key={`${ci}-${ni}`}
                          className="nominee"
                          style={borderColor ? { borderColor } : undefined}
                        >
                          {n.posterUrl ? <img src={n.posterUrl} alt="" /> : null}
                          <div>
                            {n.personName && <div className="winner">{n.personName}</div>}
                            <div>{n.title}</div>
                          </div>
                          {n.isWinner && (
                            <span
                              style={{
                                background: "var(--accent)",
                                color: "var(--accent-fg)",
                                padding: "2px 8px",
                                borderRadius: 999,
                                fontSize: 10,
                                fontWeight: 700,
                                letterSpacing: 0.5,
                              }}
                            >
                              WINNER
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function label(t: Tab) {
  if (t === "json") return "JSON";
  if (t === "text") return "Text";
  if (t === "url") return "URL";
  return "Prompt";
}

function stripUnresolved(season: AwardSeason): AwardSeason {
  return {
    ...season,
    categories: season.categories.map((c) => ({
      ...c,
      nominees: c.nominees.filter((n) => n.tmdbId && n.tmdbId > 0),
    })),
  };
}
