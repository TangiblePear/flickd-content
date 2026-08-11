/**
 * Builds the five clues for a puzzle from the unified detail payload.
 *
 * ## Clues are structured, never prose
 *
 * The app ships in 24 languages, so a baked English string like "Directed by David
 * Fincher" could never be translated. Every clue travels as data — a decade as a number,
 * genres as slugs the client already has localised names for, a runtime in minutes — and
 * each client renders and translates it. Only proper nouns (a character, a person) cross
 * the wire as text, because those are not translated anywhere.
 */

import { castHash } from "./castHash";

const DETAIL_BASE = "https://data.flickto.app";

export type Clue =
  | { kind: "decade"; decade: number }
  | { kind: "genres"; genres: string[] }
  | { kind: "runtime"; runtime: number; certification: string | null }
  | { kind: "character"; character: string }
  | { kind: "creator"; person: string; role: "director" | "creator" };

/** Only the fields used here; the real payload is far larger. */
type TraktPerson = { name?: string; ids?: { trakt?: number } };
type CastMember = { character?: string; characters?: string[]; person?: TraktPerson };
type CrewMember = { job?: string; jobs?: string[]; person?: TraktPerson };
type Crew = { directing?: CrewMember[]; "created by"?: CrewMember[] };
type DetailPayload = {
  trakt?: { certification?: string | null };
  trakt_people?: { cast?: CastMember[]; crew?: Crew };
};

/**
 * Character names that identify nobody. "Himself" on a documentary is the common one,
 * and it would make a clue that reads as a bug.
 */
const GENERIC_CHARACTERS = new Set([
  "himself", "herself", "themselves", "self", "narrator", "host", "presenter",
  "guest", "various", "unknown", "n/a", "extra", "additional voices",
]);

/**
 * Combining diacritical marks, built from an escaped string rather than written as a
 * literal character class. Literal combining marks are invisible in a diff, attach
 * themselves to whatever precedes them in an editor, and do not survive every tool that
 * touches the file. This stays pure ASCII in source.
 */
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/** Lowercase, strip accents and punctuation — so "Wall-E" and "WALL-E" compare equal. */
function normalise(text: string): string {
  return text
    .normalize("NFD")
    // Order matters: strip the marks BEFORE the alphanumeric filter. NFD has already
    // split "Amelie" into a base letter plus an accent, and the filter below turns
    // anything non-alphanumeric into a SPACE -- so leaving the accent in place would
    // split one word into "ame lie" and defeat the title-leak check.
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Function words, excluded from the overlap check.
 *
 * Without these the guard is far too eager: "the" clears the three-character floor, so
 * "The Dude" would be rejected for "The Big Lebowski" and every other title beginning
 * with an article. That direction fails safe — it rejects a usable clue rather than
 * leaking one — which is exactly why it would have gone unnoticed while quietly burning
 * good characters and, on a thin band, exhausting the candidate list.
 *
 * Deliberately only articles, conjunctions, prepositions, pronouns and auxiliaries.
 * Nouns and numerals stay in: "King" genuinely identifies "The Lion King".
 */
const STOPWORDS = new Set([
  "the", "and", "for", "but", "nor", "yet", "its", "his", "her", "hers", "our", "ours",
  "your", "yours", "their", "theirs", "from", "with", "that", "this", "these", "those",
  "into", "onto", "over", "under", "out", "off", "not", "are", "was", "were", "been",
  "being", "has", "have", "had", "does", "did", "you", "she", "him", "they", "them",
  "who", "whom", "what", "when", "where", "why", "how", "all", "about", "after",
  "before", "between", "through", "during", "against", "among", "upon", "than", "then",
  "there", "here", "just", "only", "very", "also", "such", "each", "both", "more",
  "most", "other", "some", "any",
]);

function tokens(text: string): string[] {
  return normalise(text)
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Rejects a character whose name would give the title away.
 *
 * This is the clue most likely to leak. Films are named after their protagonists all the
 * time — Forrest Gump, Michael Clayton, Amélie, Rocky — and revealing "Forrest Gump" as
 * clue four would simply end the puzzle three clues early. Any shared word of three or
 * more letters is enough to reject; there are plenty of other cast members.
 */
export function leaksTitle(character: string, title: string): boolean {
  const c = normalise(character);
  const t = normalise(title);
  if (!c) return true;
  if (c.length >= 3 && (t.includes(c) || c.includes(t))) return true;
  const titleTokens = new Set(tokens(title));
  return tokens(character).some((token) => titleTokens.has(token));
}

/**
 * The best usable character name, or null.
 *
 * Walks billing order, so it prefers a lead — a recognisable character is a better clue
 * than a bit part, right up until it gives the answer away.
 */
export function pickCharacter(cast: CastMember[], title: string): string | null {
  for (const member of cast) {
    const candidates = [member.character, ...(member.characters ?? [])];
    for (const raw of candidates) {
      const name = (raw ?? "").trim();
      if (!name) continue;
      if (GENERIC_CHARACTERS.has(normalise(name))) continue;
      if (leaksTitle(name, title)) continue;
      return name;
    }
  }
  return null;
}

/**
 * A show is credited to its creator, a film to its director. Shows fall back to directing
 * because an episodic director is still a fair clue when "created by" is missing.
 */
function pickCreator(
  crew: Crew,
  isShow: boolean,
): { person: string; role: "director" | "creator" } | null {
  if (isShow) {
    const createdBy = crew["created by"] ?? [];
    const name = createdBy.find((c) => c.person?.name)?.person?.name;
    if (name) return { person: name, role: "creator" };
  }
  const directing = crew.directing ?? [];
  const director = directing.find(
    (c) => c.job === "Director" || (c.jobs ?? []).includes("Director"),
  ) ?? directing[0];
  const name = director?.person?.name;
  return name ? { person: name, role: "director" } : null;
}

export type ClueSource = {
  tmdbId: number;
  /** 0 = movie, 1 = show */
  type: number;
  title: string;
  year: number;
  genres: string[];
  runtime: number;
};

/**
 * Fetches the detail payload and assembles the clue ladder.
 *
 * Returns null when the title cannot carry a full ladder — a missing payload, no usable
 * character, no director. The caller moves to the next candidate rather than publishing a
 * puzzle with a hole in it: only ~10,200 of the 31k titles have a cached detail payload,
 * and some of those are partial, so this rejects more often than it looks like it should.
 */
/** The clue ladder plus the answer's cast, hashed. */
export type ClueBundle = { clues: Clue[]; castHashes: string[] };

/**
 * Every person credited on the answer, hashed.
 *
 * Cast AND crew: a shared director is as good a reveal as a shared actor, and the client
 * shows whichever it finds. Deduplicated, and capped -- a long-running show can credit
 * hundreds of people, and the payload is downloaded by every player every day.
 */
function castHashesFrom(payload: DetailPayload): string[] {
  const people: Array<{ person?: TraktPerson }> = [
    ...(payload.trakt_people?.cast ?? []),
    ...Object.values(payload.trakt_people?.crew ?? {}).flat(),
  ];
  const ids = new Set<number>();
  for (const p of people) {
    const id = p.person?.ids?.trakt;
    if (typeof id === "number" && id > 0) ids.add(id);
  }
  return [...ids].slice(0, MAX_CAST_HASHES).map(castHash);
}

/** Bounds the payload. Enough for a full principal cast and the main crew. */
const MAX_CAST_HASHES = 60;

export async function buildClues(source: ClueSource): Promise<ClueBundle | null> {
  const isShow = source.type === 1;
  const url = `${DETAIL_BASE}/${isShow ? "shows" : "movies"}/${source.tmdbId}.json`;

  let payload: DetailPayload;
  try {
    const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) return null;
    payload = (await res.json()) as DetailPayload;
  } catch {
    return null;
  }

  const cast = payload.trakt_people?.cast ?? [];
  const crew = payload.trakt_people?.crew ?? {};

  const character = pickCharacter(cast, source.title);
  if (!character) return null;

  const creator = pickCreator(crew, isShow);
  if (!creator) return null;

  const certification = payload.trakt?.certification?.trim() || null;

  const clues: Clue[] = [
    { kind: "decade", decade: Math.floor(source.year / 10) * 10 },
    { kind: "genres", genres: source.genres },
    { kind: "runtime", runtime: source.runtime, certification },
    { kind: "character", character },
    { kind: "creator", person: creator.person, role: creator.role },
  ];

  return { clues, castHashes: castHashesFrom(payload) };
}
