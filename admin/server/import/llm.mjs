import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "prompts");

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const OPENAI_MODEL = "gpt-4o-mini";

const loadPrompt = (file) => readFileSync(join(PROMPTS_DIR, file), "utf8");

export function llmAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}

function hintsBlock(hints) {
  if (!hints) return "";
  const lines = [];
  if (hints.templateId) lines.push(`templateId: ${hints.templateId}`);
  if (hints.eventName) lines.push(`eventName: ${hints.eventName}`);
  if (hints.year) lines.push(`year: ${hints.year}`);
  if (hints.slugPrefix) lines.push(`slugPrefix: ${hints.slugPrefix}`);
  if (Array.isArray(hints.categories) && hints.categories.length) {
    lines.push("expected categories:");
    for (const c of hints.categories) lines.push(`  - ${c.name} (${c.kind})`);
  }
  return lines.length ? `\n\n# Hints\n${lines.join("\n")}` : "";
}

async function callAnthropic(system, user) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);
  const json = await r.json();
  const text = (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return text;
}

async function callOpenAI(system, user) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${await r.text()}`);
  const json = await r.json();
  return json.choices?.[0]?.message?.content ?? "";
}

async function callLLM(system, user) {
  if (process.env.ANTHROPIC_API_KEY) return callAnthropic(system, user);
  if (process.env.OPENAI_API_KEY) return callOpenAI(system, user);
  throw new Error("No LLM key configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)");
}

function extractJson(raw) {
  const trimmed = raw.trim();
  // Strip ```json fences if a model added them despite instructions
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("LLM returned no JSON object");
  return JSON.parse(candidate.slice(first, last + 1));
}

export async function extractDraftFromText(text, hints) {
  const system = loadPrompt("extract.md") + hintsBlock(hints);
  const user = `# Source text\n\n${text}`;
  const raw = await callLLM(system, user);
  return extractJson(raw);
}

export async function generateDraftFromPrompt(prompt, hints) {
  const system = loadPrompt("generate.md") + hintsBlock(hints);
  const user = `# Request\n\n${prompt}`;
  const raw = await callLLM(system, user);
  return extractJson(raw);
}
