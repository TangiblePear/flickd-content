// Replace TODAY's published puzzle with a hand-picked title.
//
// One-off operator tool, not part of the cron. It exists because the generator picks
// deterministically from a seed and refuses to touch a day it has already published, so
// there is no supported way to say "make today X" -- and the two files that describe a
// day must agree exactly or every correct guess is rejected on submission.
//
// ⚠️ It imports the WORKER'S OWN modules rather than reimplementing them. The obfuscation,
// the clue builder and the cast hashing all have to be byte-identical to what the cron
// writes; a second implementation that merely round-trips against itself would agree with
// nobody, which is the failure the fixture's known vectors exist to catch.
//
// Writes two files and uploads NOTHING. Review them, then push them with wrangler.
//
//   node --experimental-strip-types scripts/override-today.mjs <tmdbId> [YYYY-MM-DD]
//
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { POOL } from "../src/game/pool.ts";
import { buildClues } from "../src/game/clues.ts";
import { obfuscateTitle, obfuscatePayload, KEY_VERSION } from "../src/game/obfuscate.ts";

const tmdbId = Number(process.argv[2]);
const iso = process.argv[3] ?? new Date().toISOString().slice(0, 10);

if (!Number.isInteger(tmdbId)) {
  console.error("usage: node --experimental-strip-types scripts/override-today.mjs <tmdbId> [YYYY-MM-DD]");
  process.exit(1);
}

// ⚠️ Must match generate.ts. The number is DERIVED from the epoch, not counted, so it is
// read from the same place rather than typed in again.
const EPOCH_DATE = "2026-08-12";
const TITLE_INDEX = "titles.v2.json";
const daysBetween = (a, b) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

const entry = POOL.find((p) => p.tmdbId === tmdbId);
if (!entry) {
  console.error(`tmdbId ${tmdbId} is not in the pool. Only pool titles carry the genreMask`);
  console.error("and ratingTenths the grader compares against, so an off-pool answer would");
  console.error("grade against numbers no client agrees with.");
  process.exit(1);
}

console.log(`${entry.title} (${entry.year})  tmdb ${entry.tmdbId}  band ${entry.band}`);

const built = await buildClues({
  tmdbId: entry.tmdbId,
  type: entry.type,
  title: entry.title,
  year: entry.year,
  genres: entry.genres,
  runtime: entry.runtime,
});

if (!built) {
  console.error("buildClues returned null -- the detail feed rejected this title (usually");
  console.error("no usable character clue). The cron would have skipped it too.");
  process.exit(1);
}

// The reveal focus point. The cron derives it from a seeded RNG; a fixed, slightly
// off-centre point is fine for a one-off and keeps the first zoom off the bottom third,
// where a burnt-in logo or title would give the answer away at 12x.
const reveal = { focusX: 0.5, focusY: 0.42 };

const puzzle = {
  schemaVersion: 2,
  keyVersion: KEY_VERSION,
  puzzleNumber: daysBetween(EPOCH_DATE, iso) + 1,
  date: iso,
  titleIndex: TITLE_INDEX,
  answer: {
    t: obfuscateTitle(entry.title),
    year: entry.year,
    type: entry.type,
    genreMask: entry.genreMask,
    ratingTenths: entry.ratingTenths,
    tmdbId: entry.tmdbId,
    posterUrl: entry.posterUrl,
    backdropUrl: entry.backdropUrl,
  },
  reveal,
  clues: built.clues,
  castHashes: built.castHashes,
};

// The PRIVATE half. share-api verifies every submission against this, so a mismatch here
// rejects correct guesses rather than failing loudly.
const answer = {
  date: iso,
  puzzleNumber: puzzle.puzzleNumber,
  tmdbId: entry.tmdbId,
  title: entry.title,
};

// Published shape: three routing fields and one blob. Obfuscating only the title left
// `tmdbId` in the clear beside it, which IS the answer to anyone who pastes it into TMDB.
const { schemaVersion, keyVersion, ...secret } = puzzle;
const published = { schemaVersion, keyVersion, date: iso, p: obfuscatePayload(secret) };

// ⚠️ The no-repeat memory. The cron filters candidates on this list, so a title published
// by hand that never lands in it can be picked again by the cron a few weeks later. Reads
// an existing recent.json from the working directory when there is one -- download the
// live copy first for a mid-life override; after a reset, starting fresh is correct.
const RECENT_LIMIT = 365;
const priorRecent = existsSync("recent.json")
  ? (JSON.parse(readFileSync("recent.json", "utf8")).tmdbIds ?? [])
  : [];
const tmdbIds = [entry.tmdbId, ...priorRecent.filter((id) => id !== entry.tmdbId)]
  .slice(0, RECENT_LIMIT);

writeFileSync("latest.json", JSON.stringify(published));
writeFileSync(`answer-${iso}.json`, JSON.stringify(answer));
writeFileSync("recent.json", JSON.stringify({ tmdbIds, updatedAt: Date.now() }));

console.log(`puzzle #${puzzle.puzzleNumber}  ${iso}`);
console.log(`clues: ${puzzle.clues.length}  castHashes: ${puzzle.castHashes.length}`);
console.log(
  priorRecent.length
    ? `recent.json: ${entry.tmdbId} prepended to ${priorRecent.length} existing`
    : `recent.json: started fresh with ${entry.tmdbId} (no prior file found)`,
);
console.log("wrote latest.json, answer-" + iso + ".json and recent.json");
