import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CONTENT = join(ROOT, "content");
const TEMPLATES = join(ROOT, "templates");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");

export function listTemplates() {
  return readdirSync(TEMPLATES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(TEMPLATES, f)));
}

export function listSeasons() {
  const dir = join(CONTENT, "awards");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => {
      const s = readJson(join(dir, f));
      const total = s.categories.reduce((n, c) => n + (c.nominees?.length ?? 0), 0);
      const winners = s.categories.reduce(
        (n, c) => n + (c.nominees?.filter((x) => x.isWinner).length ?? 0),
        0,
      );
      return {
        slug: s.id,
        eventName: s.eventName,
        year: s.year,
        ceremonyDate: s.ceremonyDate ?? null,
        startDate: s.startDate,
        endDate: s.endDate,
        nomineeCount: total,
        winnerCount: winners,
      };
    })
    .sort((a, b) => b.year - a.year || a.slug.localeCompare(b.slug));
}

export function readSeason(slug) {
  const p = join(CONTENT, "awards", `${slug}.json`);
  return existsSync(p) ? readJson(p) : null;
}

export function writeSeason(slug, payload) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("invalid slug");
  if (payload.id !== slug) throw new Error("slug/id mismatch");
  writeJson(join(CONTENT, "awards", `${slug}.json`), payload);
}

export function rebuildManifest() {
  execSync("node scripts/build-manifest.mjs", { cwd: ROOT, stdio: "inherit" });
}
