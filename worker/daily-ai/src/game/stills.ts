/**
 * Six stills from one title, ordered easiest-last.
 *
 * ## Why TMDB here and not the Trakt payload
 *
 * Reel needs SIX different frames from the same title. The pool carries one backdrop
 * each -- enough for Flickdl, which zooms into a single frame -- and data.flickto.app's
 * payload is credits and metadata, not an image library. TMDB's images endpoint is the
 * only source of a set, and this worker already holds TMDB_API_KEY for the daily list.
 *
 * ⚠️ That key is a WORKER secret and these URLs are published into public content, which
 * is fine and is how the daily list already works. It does mean Reel is a WEB game: the
 * Android app is deliberately off TMDB for artwork, so if Reel is ever ported, its stills
 * have to be re-sourced rather than read from this payload.
 *
 * ## The order is the difficulty curve
 *
 * TMDB scores its images by community vote, and the highly-voted ones are the recognisable
 * frames -- the poster shot, the famous two-hander. So the set is sorted ASCENDING and the
 * most iconic image is the one you get last, which is exactly the ramp Framed has. It costs
 * nothing and it beats a random shuffle, which regularly opens on the money shot.
 *
 * ## ⚠️ Spread across that order, never the first six of it
 *
 * Sorting ascending and taking the head looks right and is not: the bottom of a TMDB
 * gallery is where NEAR-DUPLICATES live. Uploads arrive in batches from a single scene --
 * six frames of the same close-up, seconds apart -- and every one of them carries zero
 * votes, so they sort together and land as the first six. A round then spends three
 * guesses showing what is effectively one picture, which reads as a broken game rather
 * than a hard one, and dedupe cannot catch it because the file paths genuinely differ.
 *
 * Picking evenly across the whole ordered set steps over those clusters, because a
 * cluster is by definition adjacent. The ramp survives: the last pick is still the
 * highest-voted image the title has.
 *
 * Textless frames only. A backdrop with a language tag usually carries burnt-in titling,
 * and handing over the title on frame one is not a puzzle.
 */

const TMDB_BASE = "https://api.themoviedb.org/3";
const STILL_BASE = "https://image.tmdb.org/t/p/w780";

export const STILLS_PER_PUZZLE = 6;

type TmdbImage = {
  file_path?: string;
  iso_639_1?: string | null;
  vote_average?: number;
  vote_count?: number;
  width?: number;
};

/** Wide enough that the frame is a frame and not a thumbnail. */
const MIN_WIDTH = 780;

/**
 * How many usable stills a title needs before it can be the answer.
 *
 * Six would be enough to fill the reel, and that is what it used to ask for -- but six
 * from a gallery of exactly six is six ADJACENT frames, which is the duplicate problem
 * with no room to step over it. Twice the reel gives the spread something to work with.
 * The generator tries twelve candidates a day, so a title turned down here costs nothing.
 */
const MIN_USABLE = STILLS_PER_PUZZLE * 2;

/** `count` items taken evenly across `items`, both ends included. */
export function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items.slice(0, count);
  const span = items.length - 1;
  return Array.from({ length: count }, (_, i) => items[Math.round((i * span) / (count - 1))]);
}

/**
 * Six frames from a gallery: which ones, and in what order.
 *
 * ⚠️ Chosen across TMDB's OWN order, then ramped. That sequence matters and the obvious
 * one is wrong.
 *
 * Sorting by vote first and taking the head looks like the difficulty ramp doing its job.
 * It is not: near-duplicates arrive as batch uploads from a single scene, they all carry
 * zero votes, so they sort TOGETHER and land as the first six. Three of the six frames
 * are then one close-up, which reads as a broken game rather than a hard one — and
 * dedupe cannot see it, because the file paths genuinely differ.
 *
 * Those batches are ADJACENT in the gallery as TMDB returns it. So the six are sampled
 * across that original order, which steps over a batch instead of landing inside it, and
 * only then sorted ascending by vote so the most recognisable of the six comes last. The
 * ramp is preserved among the frames actually shown, which is the only place it matters.
 *
 * This makes a repeat much less likely; it cannot make one impossible. Two frames from
 * opposite ends of a gallery can still be the same shot, and nothing short of comparing
 * the images themselves would know. MIN_USABLE is the other half of the defence: a
 * gallery has to be at least twice the reel before a title can be the answer at all.
 */
export function pickStills<T extends TmdbImage>(usable: T[], count: number): T[] {
  return spread(usable, count).sort((a, b) => {
    const byVote = (a.vote_average ?? 0) - (b.vote_average ?? 0);
    if (byVote !== 0) return byVote;
    // Ties break on vote_count for determinism: TMDB's own order is not stable across
    // calls, and a puzzle that regenerates differently for a date disagrees with its
    // own shares.
    return (a.vote_count ?? 0) - (b.vote_count ?? 0);
  });
}

export async function stillsFor(
  apiKey: string,
  tmdbId: number,
  type: number,
): Promise<string[] | null> {
  const kind = type === 1 ? "tv" : "movie";
  // `include_image_language=null` is TMDB's spelling for "textless only". Without it the
  // response leads with localised art, which is where the burnt-in titles live.
  const url = `${TMDB_BASE}/${kind}/${tmdbId}/images?api_key=${apiKey}&include_image_language=null`;

  let backdrops: TmdbImage[];
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { backdrops?: TmdbImage[] };
    backdrops = body.backdrops ?? [];
  } catch {
    return null;
  }

  // Deduplicated on file_path. TMDB does occasionally list the same image twice, and a
  // reel with a repeat is a turn that costs a guess and shows the player nothing new --
  // which reads as a broken game rather than as a hard one.
  const seen = new Set<string>();
  const usable = backdrops.filter((b) => {
    if (typeof b.file_path !== "string" || b.iso_639_1 || (b.width ?? 0) < MIN_WIDTH) return false;
    if (seen.has(b.file_path)) return false;
    seen.add(b.file_path);
    return true;
  });
  if (usable.length < MIN_USABLE) return null;

  return pickStills(usable, STILLS_PER_PUZZLE).map((b) => `${STILL_BASE}${b.file_path}`);
}

/**
 * Every still must actually load.
 *
 * `backdropLoads` in generate.ts does this for Flickdl's single frame, and the reason is
 * sharper here: Flickdl degrades to a blurry rectangle, while a Reel frame that 404s is a
 * turn where the player is shown nothing at all and asked to guess anyway.
 */
export async function allLoad(urls: string[]): Promise<boolean> {
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (!res.ok) return false;
    } catch {
      return false;
    }
  }
  return true;
}
