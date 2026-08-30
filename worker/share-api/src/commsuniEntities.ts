/**
 * commsuni.tv entity addressing — TVDB references, and the `(tmdbId, mediaType) → tvdbId`
 * cache behind them.
 *
 * The archive addresses one conversation per title/season/episode by **TVDB** reference.
 * Flickto is TMDB-native everywhere else, so this module is the whole of the translation
 * between the two id spaces.
 *
 * ⚠️ **A TVDB reference costs the same one `read_unit` as an entity id**, so never call
 * `GET /v1/entities/{type}` to "resolve" a reference before a read. That would double the
 * cost of every open to learn something the reference already encodes.
 *
 * ⚠️ Nothing here calls upstream. Reference building is pure string work and the map is a
 * local D1 cache — which is what makes Phase 0 shippable before the API key exists.
 */

export interface EntitiesEnv {
  DB: D1Database;
}

/** `movie` | `show`, matching `comments.media_type` rather than the archive's vocabulary. */
export type MediaType = "movie" | "show";

/**
 * Build the archive's reference for a subject.
 *
 * The four shapes, copied from the partner guide:
 *   show     → `tvdb-{id}`
 *   season   → `tvdb-{id}-s{n}`
 *   episode  → `tvdb-{id}-s{n}e{m}`
 *   movie    → `movie/tvdb-{id}`
 *
 * ⚠️ `season`/`episode` are the **-1 sentinels** the rest of the comment stack uses, never
 * null — see `comments.ts`. -1 means "this level does not apply", so a title-level show
 * reference is `tvdb-{id}` with no suffix, and a movie can never carry one at all.
 */
export function entityReference(mediaType: MediaType, tvdbId: number, season = -1, episode = -1): string | null {
  if (!Number.isInteger(tvdbId) || tvdbId <= 0) return null;

  if (mediaType === "movie") {
    // ⚠️ Movies are namespaced. A bare `tvdb-{id}` is a SERIES reference, and TheTVDB's
    // series and movie id spaces overlap numerically — so dropping the prefix silently
    // addresses an unrelated show's conversation rather than failing.
    return `movie/tvdb-${tvdbId}`;
  }

  if (season < 0) return `tvdb-${tvdbId}`;
  if (episode < 0) return `tvdb-${tvdbId}-s${season}`;
  return `tvdb-${tvdbId}-s${season}e${episode}`;
}

/**
 * The cached TVDB id for a TMDB title, or null.
 *
 * Null is the normal answer for most of the catalogue and is not an error: the title has
 * simply never been opened by a client that could resolve it.
 */
export async function lookupTvdbId(
  env: EntitiesEnv,
  mediaType: MediaType,
  tmdbId: number,
): Promise<number | null> {
  const row = await env.DB.prepare("SELECT tvdb_id FROM tvdb_map WHERE media_type = ? AND tmdb_id = ?")
    .bind(mediaType, tmdbId)
    .first<{ tvdb_id: number }>();
  return row?.tvdb_id ?? null;
}

/**
 * Record a pair the client resolved.
 *
 * ⚠️ **`INSERT OR IGNORE`, deliberately — the first value wins and is never overwritten.**
 * The mapping is immutable, so a second, *different* id for the same title means one of
 * the two is wrong; overwriting would silently move every future comment to a different
 * conversation and orphan everything already published under the old reference. Keeping
 * the first value at least keeps the product self-consistent.
 *
 * Invalid input is dropped rather than stored: a zero or negative id would build a
 * reference that addresses nothing.
 */
export async function rememberTvdbId(
  env: EntitiesEnv,
  mediaType: MediaType,
  tmdbId: number,
  tvdbId: number,
): Promise<void> {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return;
  if (!Number.isInteger(tvdbId) || tvdbId <= 0) return;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tvdb_map (media_type, tmdb_id, tvdb_id, created_at) VALUES (?,?,?,?)",
  )
    .bind(mediaType, tmdbId, tvdbId, Date.now())
    .run();
}

/**
 * Resolve a subject to its reference, preferring a client-supplied id and falling back to
 * the cache.
 *
 * A client that sends one also teaches the map, which is what lets the outbox drain and
 * the admin panel address an entity with no client present.
 */
export async function resolveReference(
  env: EntitiesEnv,
  mediaType: MediaType,
  tmdbId: number,
  season: number,
  episode: number,
  clientTvdbId?: number | null,
): Promise<string | null> {
  let tvdbId = clientTvdbId ?? null;
  if (tvdbId != null && Number.isInteger(tvdbId) && tvdbId > 0) {
    await rememberTvdbId(env, mediaType, tmdbId, tvdbId);
  } else {
    tvdbId = await lookupTvdbId(env, mediaType, tmdbId);
  }
  if (tvdbId == null) return null;
  return entityReference(mediaType, tvdbId, season, episode);
}
