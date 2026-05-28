import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import express from "express";
import { searchTmdb } from "./tmdb.mjs";
import {
  listTemplates,
  listSeasons,
  readSeason,
  writeSeason,
  deleteSeason,
  rebuildManifest,
} from "./content.mjs";
import { commitAndMaybePush } from "./git.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = join(__dirname, "..");
loadEnv(join(ADMIN_ROOT, ".env.local"));

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/templates", (_req, res) => res.json(listTemplates()));

app.get("/api/awards", (_req, res) => res.json(listSeasons()));

app.get("/api/awards/:slug", (req, res) => {
  const data = readSeason(req.params.slug);
  if (!data) return res.status(404).json({ error: "not_found" });
  res.json(data);
});

app.put("/api/awards/:slug", async (req, res) => {
  try {
    writeSeason(req.params.slug, req.body);
    rebuildManifest();
    const result = await commitAndMaybePush(`admin: update ${req.params.slug}`);
    res.json({ ok: true, git: result });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.delete("/api/awards/:slug", async (req, res) => {
  try {
    deleteSeason(req.params.slug);
    rebuildManifest();
    const result = await commitAndMaybePush(`admin: delete ${req.params.slug}`);
    res.json({ ok: true, git: result });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.get("/api/tmdb/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json({ results: [] });
  try {
    const results = await searchTmdb(q);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

const PORT = 5174;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`[admin api] listening on http://127.0.0.1:${PORT}`);
});

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
