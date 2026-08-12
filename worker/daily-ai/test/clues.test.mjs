// The character clue is the one that can hand over the answer.
//
// Films are named after their protagonists constantly -- Forrest Gump, Michael Clayton,
// Rocky, Amelie -- so revealing "Forrest Gump" as clue four would end the puzzle three
// clues early. The guard is cheap to get subtly wrong (accents, punctuation, partial
// words) and its failure is invisible: the puzzle still generates, still looks correct in
// the R2 object, and is simply given away to every player that day.
//
// Run: npm test  (from worker/daily-ai)
import { leaksTitle, pickCharacter } from "../src/game/clues.ts";
import { obfuscateTitle, deobfuscateTitle, obfuscatePayload, deobfuscatePayload } from "../src/game/obfuscate.ts";

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("pass", name);
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

// ── the leak guard ──
{
  const leaks = (c, t) => ok(`rejects "${c}" for "${t}"`, leaksTitle(c, t) === true);
  const safe = (c, t) => ok(`allows "${c}" for "${t}"`, leaksTitle(c, t) === false);

  // The eponymous-protagonist case, which is the whole reason this exists.
  leaks("Forrest Gump", "Forrest Gump");
  leaks("Michael Clayton", "Michael Clayton");
  leaks("Rocky Balboa", "Rocky");
  leaks("Willy Wonka", "Willy Wonka & the Chocolate Factory");

  // Partial overlap is still a give-away: one shared word names the film.
  leaks("John Wick", "John Wick: Chapter 4");
  leaks("Jason Bourne", "The Bourne Identity");

  // Accents and punctuation must not let a leak through. "Amelie" vs "Amelie" differ by
  // a combining accent alone, and NFD + the mark strip is what makes them compare equal.
  leaks("Amélie Poulain", "Amélie");
  leaks("Amélie Poulain", "Amelie");
  leaks("WALL·E", "WALL-E");

  // Case must not matter either.
  leaks("TYLER DURDEN", "tyler durden");

  // And the ordinary case: a character that says nothing about the title.
  safe("Tyler Durden", "Fight Club");
  safe("Vito Corleone", "The Godfather");
  safe("Ellen Ripley", "Alien");
  safe("Walter White", "Breaking Bad");

  // Function words must NOT trip it. "the" is three letters, so it clears the length
  // floor -- without a stopword list this rejected every character beginning with an
  // article against every title beginning with one. Failing safe is exactly why that
  // would have gone unnoticed while quietly burning usable clues.
  safe("The Dude", "The Big Lebowski");
  safe("The Bride", "Kill Bill: The Whole Bloody Affair");
  safe("Doctor Who", "What We Do in the Shadows");

  // But a real shared noun still leaks, stopword list or not.
  leaks("The Lion King", "The Lion King");
  leaks("King Arthur", "The Sword and the King");

  // An empty or whitespace character name is unusable, so it counts as a leak (reject).
  ok("rejects an empty character", leaksTitle("", "Anything") === true);
  ok("rejects a whitespace character", leaksTitle("   ", "Anything") === true);
}

// ── picking from a cast list ──
{
  const cast = (...names) => names.map((n) => ({ character: n, person: { name: "x" } }));

  eq("takes the first usable character in billing order",
    pickCharacter(cast("Tyler Durden", "Marla Singer"), "Fight Club"), "Tyler Durden");

  eq("skips a character that leaks and takes the next",
    pickCharacter(cast("Forrest Gump", "Jenny Curran"), "Forrest Gump"), "Jenny Curran");

  eq("skips generic credits",
    pickCharacter(cast("Himself", "Narrator", "Ellen Ripley"), "Alien"), "Ellen Ripley");

  eq("skips blank entries",
    pickCharacter(cast("", "  ", "Vito Corleone"), "The Godfather"), "Vito Corleone");

  eq("falls back to the characters[] array when character is absent",
    pickCharacter([{ characters: ["Sarah Connor"], person: { name: "x" } }], "The Terminator"),
    "Sarah Connor");

  eq("returns null when nothing is usable, so the caller moves on",
    pickCharacter(cast("Himself", "Rocky Balboa"), "Rocky"), null);

  eq("returns null on an empty cast", pickCharacter([], "Anything"), null);
}

// ── obfuscation round trip ──
{
  const trip = (t) => eq(`round-trips ${JSON.stringify(t)}`, deobfuscateTitle(obfuscateTitle(t)), t);

  trip("Fight Club");
  // Non-ASCII must survive intact: a mangled answer would fail to match a correct guess.
  trip("Amélie");
  trip("千と千尋の神隠し");           // Spirited Away
  trip("The Accountant²");
  trip("WALL·E");
  trip("À bout de souffle");
  // Longer than the key, so the repeating XOR wraps.
  trip("The Lord of the Rings: The Fellowship of the Ring");
  trip("");

  ok("the encoded form is not the plaintext", obfuscateTitle("Fight Club") !== "Fight Club");
  ok("and does not contain it", !obfuscateTitle("Fight Club").includes("Fight"));
}


// ── the whole-payload envelope ──
//
// Obfuscating only the title published `tmdbId` in the clear beside it, which IS the
// answer to anyone who pastes it into TMDB. These assert the blob round-trips AND that
// nothing identifying survives in the published text.
{
  const secret = {
    puzzleNumber: 1,
    date: "2026-08-12",
    titleIndex: "titles.v2.json",
    answer: {
      tmdbId: 37165, type: 0, t: obfuscateTitle("The Truman Show"), year: 1998,
      genreMask: 72, ratingTenths: 82,
      posterUrl: "https://media.trakt.tv/images/movies/000/023/734/posters/medium/x.jpg.webp",
      backdropUrl: "https://media.trakt.tv/images/movies/000/023/734/fanarts/medium/y.jpg.webp",
    },
    reveal: { focusX: 0.5, focusY: 0.42 },
    clues: [{ kind: "creator", person: "Peter Weir", role: "director" }],
    castHashes: ["abc"],
  };

  const p = obfuscatePayload(secret);
  const published = JSON.stringify({ schemaVersion: 2, keyVersion: 1, date: secret.date, p });

  eq("payload round trips", deobfuscatePayload(p), secret);
  ok("published text hides the tmdbId", !published.includes("37165"));
  ok("published text hides the art host", !published.includes("trakt.tv"));
  ok("published text hides the director", !published.includes("Weir"));
  ok("published text hides the year", !published.includes("1998"));
  ok("date stays readable for routing", JSON.parse(published).date === "2026-08-12");
}


console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);