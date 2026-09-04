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
// ⚠️ It PUBLISHES. The files land in R2 and the day is live when it finishes.
// Pass --dry-run to write them for review and print the upload commands instead.
//
//   npm run regen -- <flickreel|flickgrid|flickology|link> [YYYY-MM-DD] [--dry-run]
//
// ⚠️ Through npm, not by hand. `--import ./scripts/resolve-ts.mjs` is an ARGUMENT to
// node, and a shell that mistakes it for a command hands the .mjs to Windows, which
// answers with "select an app to open this file". Writing it with a backslash
// continuation guarantees that, because that is bash syntax and PowerShell runs the
// second line as its own command.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync }
  from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const BUCKET = "flickto-content";

/**
 * Wrangler, run as JAVASCRIPT rather than through its shell shim.
 *
 * ⚠️ Not `npx`, and not `npx.cmd`. Since the CVE-2024-27980 hardening, Node on Windows
 * REFUSES to spawn a .cmd or .bat without a shell and fails with EINVAL -- and turning the
 * shell on is worse here, because the arguments are then concatenated unescaped and this
 * repo lives under a path with a space in it ("Media Remote"), so --file would arrive
 * split in half.
 *
 * Resolving the package and running its bin with the CURRENT node binary sidesteps both:
 * no shell, no shim, and execFile keeps every argument intact however it is spelled.
 */
const wranglerJs = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin", "wrangler.js",
);

/** Runs wrangler and returns nothing; throws with `status` set when wrangler itself failed. */
function wrangler(args, cwd) {
  return execFileSync(process.execPath, [wranglerJs, ...args], { cwd, stdio: "pipe" });
}

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

// Publishing is the DEFAULT; --dry-run is the way to look first.
const dryRun = process.argv.includes("--dry-run");
const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
const game = args[0];
const iso = args[1] ?? new Date().toISOString().slice(0, 10);
const spec = GAMES[game];

if (!spec || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
  console.error("usage: npm run regen -- <" + Object.keys(GAMES).join("|") + "> [YYYY-MM-DD] [--dry-run]");
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
    wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--file", path], root);
    console.log(`  pulled  ${key}`);
  } catch (err) {
    if (existsSync(path)) rmSync(path);
    /*
     * ⚠️ A missing OBJECT and a wrangler that never ran are not the same thing, and this
     * catch used to report both as "absent". When the spawn itself was failing, every pull
     * silently reported absent and the generator ran with no no-repeat memory at all --
     * which looks exactly like a normal first run.
     *
     * `status` is set only when wrangler ran and exited non-zero. Anything else never
     * started, and guessing past that would publish a day built on state we could not read.
     */
    if (err.status === undefined) {
      console.error(`  ERROR   could not run wrangler: ${err.code ?? err.message}`);
      process.exit(1);
    }
    // Absent is normal: latest.json is what you just deleted, and a recent list may never
    // have been written. The generator treats both as "nothing published yet".
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

// ── publish ─────────────────────────────────────────────────────

console.log(`\nwrote ${keys.length} file(s) under regen/${game}/${iso}/\n`);
for (const key of keys) console.log(`  ${key}`);

/**
 * The order these go up in, and it is not cosmetic.
 *
 * ⚠️ share-api grades a submission against game-state/answers/<game>/<date>.json.
 * Putting latest.json up while that file is missing publishes a live puzzle whose CORRECT
 * answers are all rejected -- the same reason every generator writes the answer before the
 * payload. So the answer goes first, latest.json goes last, and if anything before it
 * fails the publish STOPS rather than leaving a day nobody can win.
 */
const rank = (key) =>
  key.startsWith("game-state/answers/") ? 0 : key.endsWith("/latest.json") ? 2 : 1;
const ordered = [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

if (dryRun) {
  console.log("\n--dry-run: nothing uploaded. To publish these by hand:\n");
  for (const key of ordered) {
    const rel = join("regen", game, iso, ...key.split("/")).split(/[\\/]/).join("/");
    console.log(`npx wrangler r2 object put ${BUCKET}/${key} --file ${rel} --content-type application/json`);
  }
  console.log("\n⚠️  In that order. The answer file must land before latest.json.");
  process.exit(0);
}

console.log(`\npublishing to ${BUCKET}...\n`);
const done = [];
for (const key of ordered) {
  try {
    wrangler(["r2", "object", "put", `${BUCKET}/${key}`,
              "--file", pathFor(key), "--content-type", "application/json"], root);
    done.push(key);
    console.log(`  put     ${key}`);
  } catch (err) {
    console.error(`  FAILED  ${key}`);
    console.error(String(err.stderr ?? err.message ?? err).trim());

    // Everything ordered after this is the payload or waits behind it, so carrying on
    // would publish a day the players cannot complete.
    console.error(`\nStopped after ${done.length} of ${ordered.length} file(s).`);
    if (!done.some((k) => k.endsWith("/latest.json"))) {
      console.error("latest.json was NOT published, so the day is unchanged and still shows");
      console.error("whatever was there before -- nothing is half-live.");
    }
    console.error("\nFix the cause and run the same command again; it starts from scratch.");
    process.exit(1);
  }
}

console.log(`\npublished ${game} for ${iso}. It is live.`);
