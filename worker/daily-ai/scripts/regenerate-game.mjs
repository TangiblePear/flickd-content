// Rebuild ONE game's published day, without running the cron.
//
// The scheduled handler is all-or-nothing: it regenerates every game AND calls Gemini for
// the daily AI list, and unlike the games that list has no "already published" guard --
// so triggering the cron to fix one puzzle silently replaces the day's list with a
// different one. This does the same work for a single game and touches nothing else.
//
// ⚠️ It runs the WORKER'S OWN generator rather than reimplementing it. A second
// implementation that merely agreed with itself would agree with nobody: the payload is
// obfuscated, the answer file has to match it exactly, and share-api rejects a correct
// submission the moment those two disagree. The R2 binding is faked with the filesystem;
// everything above it is the shipped code.
//
// Writes files and uploads NOTHING. Review them, then run the printed commands.
//
//   node --import ./scripts/resolve-ts.mjs --experimental-strip-types \
//     scripts/regenerate-game.mjs <flickreel|flickgrid|flickology|link> [YYYY-MM-DD]
//
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync }
  from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const BUCKET = "flickto-content";

const GAMES = {
  flickreel: {
    module: "../src/game/generateFlickReel.ts",
    entry: "generateFlickReelForDate",
    // What the generator READS from R2 and would otherwise find empty. The recent list is
    // the no-repeat memory: without it the generator can pick a title published last week.
    pull: ["game-state/flickreel-recent.json", "content/game/flickreel/latest.json"],
    secrets: ["TMDB_API_KEY"],
  },
  flickgrid: {
    module: "../src/game/generateFlickGrid.ts",
    entry: "generateFlickGridForDate",
    pull: ["content/game/flickgrid/latest.json"],
    secrets: [],
  },
  flickology: {
    module: "../src/game/generateFlickology.ts",
    entry: "generateFlickologyForDate",
    pull: ["game-state/flickology-recent.json", "content/game/flickology/latest.json"],
    // Only the episodes and box-office axes call TMDB, but which axis a day gets is
    // derived from its date, so the key has to be present either way.
    secrets: ["TMDB_API_KEY"],
  },
  link: {
    module: "../src/game/generateLink.ts",
    entry: "generateLinkForDate",
    // No recent list: Flicklink seeds its sample by WEEK rather than remembering what it
    // published, so there is nothing to carry over. See generateLink.ts.
    pull: ["content/game/link/latest.json"],
    secrets: ["TMDB_API_KEY"],
  },
};

const game = process.argv[2];
const iso = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const spec = GAMES[game];

if (!spec || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
  console.error("usage: npm run regen -- <" + Object.keys(GAMES).join("|") + "> [YYYY-MM-DD]");
  process.exit(1);
}

// ⚠️ fileURLToPath, never `new URL(...).pathname`. On Windows the latter keeps the
// leading slash AND leaves spaces percent-encoded, so this repo's "Media Remote" became
// "Media%20Remote" and the whole run landed in a directory nobody would think to look in.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = join(root, "regen", game, iso);

// ── secrets ─────────────────────────────────────────────────────────────────
//
// From .dev.vars, which is what `wrangler dev` reads and is already gitignored. Falling
// back to the environment so CI or a one-off export works too.

function devVars() {
  const path = join(root, ".dev.vars");
  if (!existsSync(path)) return {};
  const vars = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return vars;
}

const vars = devVars();
const env = {};
for (const name of spec.secrets) {
  const value = process.env[name] ?? vars[name];
  if (!value) {
    console.error(`missing ${name}. Put it in .dev.vars or export it before running.`);
    process.exit(1);
  }
  env[name] = value;
}

// ── the R2 binding, backed by the filesystem ────────────────────────────────
//
// Only the four methods the generators actually use. Keys become paths under `out`, so
// what lands on disk mirrors exactly what would land in the bucket.

const pathFor = (key) => join(out, ...key.split("/"));

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const written = new Set();

const bucket = {
  async get(key) {
    const path = pathFor(key);
    if (!existsSync(path)) return null;
    const body = readFileSync(path, "utf8");
    return { async json() { return JSON.parse(body); }, async text() { return body; } };
  },
  async put(key, body) {
    const path = pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    written.add(key);
  },
  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = walk(out)
      .map((p) => relative(out, p).split(/[\\/]/).join("/"))
      .filter((k) => k.startsWith(prefix))
      .slice(0, limit);
    return { objects: keys.map((key) => ({ key })), truncated: false };
  },
  async delete(key) {
    const path = pathFor(key);
    if (existsSync(path)) rmSync(path);
    written.delete(key);
  },
};

// ── pull the state the generator reads ──────────────────────────────────────

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const key of spec.pull) {
  const path = pathFor(key);
  mkdirSync(dirname(path), { recursive: true });
  try {
    // npx.cmd rather than shell:true -- Node deprecated passing args through a shell
    // because they are concatenated unescaped, and a bucket key is not something to
    // hand to a shell unquoted.
    execFileSync(process.platform === "win32" ? "npx.cmd" : "npx",
      ["wrangler", "r2", "object", "get", `${BUCKET}/${key}`, "--file", path],
      { cwd: root, stdio: "pipe" });
    console.log(`  pulled  ${key}`);
  } catch {
    // Absent is normal: latest.json is what you just deleted, and a recent list may never
    // have been written. The generator treats both as "nothing published yet".
    if (existsSync(path)) rmSync(path);
    console.log(`  absent  ${key}`);
  }
}

// Anything the pull wrote is state we did not create, so it must not be offered for
// upload unless the generator actually rewrites it.
written.clear();

// ── run the real generator ──────────────────────────────────────────────────

const mod = await import(new URL(spec.module, import.meta.url).href);
console.log(`\ngenerating ${game} for ${iso}...\n`);
await mod[spec.entry](new Date(`${iso}T00:00:00Z`), { CONTENT_BUCKET: bucket, ...env });

const keys = [...written].sort();
if (keys.length === 0) {
  console.error("\nNothing was written. The generator refused this day -- read the log above.");
  console.error("If it says \"already published\", the pulled latest.json still has this date;");
  console.error("that is the cron's own guard and it means the day is already live.");
  process.exit(1);
}

// ── what to do with it ──────────────────────────────────────────────────────

console.log(`\nwrote ${keys.length} file(s) under regen/${game}/${iso}/\n`);
for (const key of keys) console.log(`  ${key}`);

console.log("\nReview them, then upload:\n");
for (const key of keys) {
  const rel = join("regen", game, iso, ...key.split("/")).split(/[\\/]/).join("/");
  console.log(`npx wrangler r2 object put ${BUCKET}/${key} --file ${rel} --content-type application/json`);
}

/*
 * ⚠️ The answer file goes up FIRST, and the order is not cosmetic.
 *
 * share-api grades a submission against game-state/answers/<game>/<date>.json. Publishing
 * latest.json while that file is missing hands players a puzzle whose correct answers are
 * all rejected -- the same reason every generator writes the answer before the payload.
 */
const answer = keys.find((k) => k.startsWith("game-state/answers/"));
const latest = keys.find((k) => k.endsWith("/latest.json"));
if (answer && latest) {
  console.log(`\n⚠️  Upload ${answer}`);
  console.log(`    BEFORE ${latest} -- a live puzzle with no answer file rejects every`);
  console.log("    correct submission.");
}
