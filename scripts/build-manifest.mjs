#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONTENT = join(ROOT, "content");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const iso = (p) => new Date(statSync(p).mtime).toISOString();

const awardsDir = join(CONTENT, "awards");
const awards = readdirSync(awardsDir)
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .map((f) => {
    const full = join(awardsDir, f);
    const s = readJson(full);
    return {
      slug: s.id,
      eventName: s.eventName,
      year: s.year,
      ceremonyDate: s.ceremonyDate ?? null,
      lastUpdated: iso(full),
    };
  })
  .sort((a, b) => b.year - a.year || a.slug.localeCompare(b.slug));

const indexPath = join(awardsDir, "index.json");
const existingIndex = readJson(indexPath);
existingIndex.seasons = awards.map((a) => {
  const detail = readJson(join(awardsDir, `${a.slug}.json`));
  return {
    slug: a.slug,
    eventName: detail.eventName,
    year: detail.year,
    startDate: detail.startDate,
    endDate: detail.endDate,
    ceremonyDate: detail.ceremonyDate ?? null,
    lastUpdated: a.lastUpdated,
  };
});
writeJson(indexPath, existingIndex);

const featureFlagsPath = join(CONTENT, "feature-flags.json");
const featureFlags = readJson(featureFlagsPath);

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  awards,
  featureFlags: featureFlags.flags,
};

writeJson(join(CONTENT, "manifest.json"), manifest);
console.log(`manifest written: ${awards.length} season(s)`);
