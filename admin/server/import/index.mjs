import { listTemplates, readSeason } from "../content.mjs";
import { validateDraft } from "./types.mjs";
import { resolveDraft } from "./resolver.mjs";
import {
  extractDraftFromText,
  generateDraftFromPrompt,
  llmAvailable,
} from "./llm.mjs";
import {
  isWikipediaUrl,
  parseWikipediaCeremony,
} from "./wikipedia.mjs";
import { sanitizeDraft } from "./filters.mjs";

const URL_TIMEOUT_MS = 10_000;
const URL_BYTE_CAP = 2 * 1024 * 1024;

async function fetchUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("only http(s) URLs are supported");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "FlickdAdmin/1.0 (+local)" },
    });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const len = Number(r.headers.get("content-length") ?? 0);
    if (len > URL_BYTE_CAP) throw new Error(`response too large (${len} bytes)`);
    const buf = await r.arrayBuffer();
    if (buf.byteLength > URL_BYTE_CAP)
      throw new Error("response exceeds 2 MB cap");
    return Buffer.from(buf).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function templateHints(templateId) {
  if (!templateId) return null;
  const all = listTemplates();
  const t = all.find((x) => x.templateId === templateId);
  if (!t) return null;
  return {
    templateId: t.templateId,
    eventName: t.eventName,
    slugPrefix: t.slugPrefix,
    categories: t.categories,
  };
}

function withHints(draft, hints) {
  if (!hints) return draft;
  const merged = { ...draft };
  if (hints.eventName && !merged.eventName) merged.eventName = hints.eventName;
  if (hints.year && !merged.year) merged.year = hints.year;
  if (hints.slugPrefix && (!merged.id || !merged.id.includes("-")))
    merged.id = `${hints.slugPrefix}-${merged.year ?? hints.year}`;
  return merged;
}

export function mountImportRoutes(app) {
  app.get("/api/import/status", (_req, res) => {
    res.json({ llmAvailable: llmAvailable() });
  });

  app.post("/api/import/json", (req, res) => {
    try {
      const raw = req.body?.json;
      if (typeof raw !== "string" || !raw.trim())
        return res.status(400).json({ error: "json string missing" });
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return res.status(400).json({ error: `invalid JSON: ${e.message}` });
      }
      const errs = validateDraft(parsed);
      if (errs.length) return res.status(400).json({ error: errs.join("; ") });
      res.json({ draft: sanitizeDraft(parsed) });
    } catch (err) {
      res.status(500).json({ error: String(err.message ?? err) });
    }
  });

  app.post("/api/import/extract", async (req, res) => {
    try {
      const { source, text, url, prompt, templateId, year, eventName } =
        req.body ?? {};
      const hints = {
        ...(templateHints(templateId) ?? {}),
        ...(year ? { year: Number(year) } : {}),
        ...(eventName ? { eventName } : {}),
      };

      let draft = null;
      let extractor = null;

      if (source === "url") {
        if (typeof url !== "string" || !url.trim())
          return res.status(400).json({ error: "url missing" });
        const html = await fetchUrl(url);
        if (isWikipediaUrl(url)) {
          draft = parseWikipediaCeremony(html, url, hints);
          if (draft) extractor = "wikipedia";
        }
        if (!draft) {
          if (!llmAvailable())
            return res.status(400).json({
              error:
                "Wikipedia parser bailed and no LLM key is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in admin/.env.local.",
            });
          draft = await extractDraftFromText(htmlToText(html).slice(0, 12000), hints);
          extractor = "llm";
        }
      } else if (source === "text") {
        if (typeof text !== "string" || !text.trim())
          return res.status(400).json({ error: "text missing" });
        if (!llmAvailable())
          return res.status(400).json({ error: "no LLM key configured" });
        draft = await extractDraftFromText(text.slice(0, 16000), hints);
        extractor = "llm";
      } else if (source === "prompt") {
        if (typeof prompt !== "string" || !prompt.trim())
          return res.status(400).json({ error: "prompt missing" });
        if (!llmAvailable())
          return res.status(400).json({ error: "no LLM key configured" });
        draft = await generateDraftFromPrompt(prompt, hints);
        extractor = "llm";
      } else {
        return res
          .status(400)
          .json({ error: "source must be one of: text, url, prompt" });
      }

      draft = sanitizeDraft(withHints(draft, hints));
      const errs = validateDraft(draft);
      if (errs.length)
        return res.status(422).json({
          error: `extractor produced invalid draft: ${errs.join("; ")}`,
          extractor,
          draft,
        });

      res.json({ draft, extractor });
    } catch (err) {
      res.status(500).json({ error: String(err.message ?? err) });
    }
  });

  app.post("/api/import/resolve", async (req, res) => {
    try {
      const draft = req.body?.draft;
      const errs = validateDraft(draft);
      if (errs.length) return res.status(400).json({ error: errs.join("; ") });

      if (readSeason(draft.id)) {
        return res.status(409).json({
          error: `slug "${draft.id}" already exists — pick a different slug or delete the existing season first`,
        });
      }

      const result = await resolveDraft(draft);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err.message ?? err) });
    }
  });
}
