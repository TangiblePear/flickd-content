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
 * Build the archive's reference for a subject: **an entity TYPE and an entity ID**.
 *
 * ⚠️ These are two separate path segments — `/v1/entities/{entityType}/{entityId}/…` —
 * not one string. Getting this wrong is silent: a request to
 * `/v1/entities/tvdb-121361/comments` answers **404 not_archived**, which is
 * indistinguishable from "this title genuinely has no conversation". Four of the
 * biggest shows on television came back empty before the missing segment was spotted,
 * and the negative cache dutifully remembered every one of them.
 *
 *   show    → `show`    + `tvdb-{id}`
 *   season  → `season`  + `tvdb-{id}-s{n}`
 *   episode → `episode` + `tvdb-{id}-s{n}e{m}`
 *   movie   → `movie`   + `tvdb-{id}`
 *
 * The type is what disambiguates: `season/tvdb-X-s1e1` and `episode/tvdb-X-s1` are both
 * errors rather than being silently coerced, so the pair has to be built together.
 *
 * ⚠️ `season`/`episode` are the **-1 sentinels** the rest of the comment stack uses,
 * never null — see `comments.ts`. -1 means "this level does not apply".
 */
export interface EntityRef {
  type: "show" | "season" | "episode" | "movie";
  id: string;
}

export function entityReference(
  mediaType: MediaType,
  tvdbId: number,
  season = -1,
  episode = -1,
): EntityRef | null {
  if (!Number.isInteger(tvdbId) || tvdbId <= 0) return null;

  // A movie's ID is a plain `tvdb-{n}`, exactly like a show's — the `movie` TYPE is
  // what separates them. TheTVDB's series and movie id spaces overlap numerically, so
  // sending the wrong type addresses an unrelated title rather than failing.
  if (mediaType === "movie") return { type: "movie", id: `tvdb-${tvdbId}` };

  if (season < 0) return { type: "show", id: `tvdb-${tvdbId}` };
  if (episode < 0) return { type: "season", id: `tvdb-${tvdbId}-s${season}` };
  return { type: "episode", id: `tvdb-${tvdbId}-s${season}e${episode}` };
}

/** `show/tvdb-121361` — the path fragment, and the negative cache's key. */
export const refPath = (ref: EntityRef): string => `${ref.type}/${ref.id}`;

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
): Promise<EntityRef | null> {
  let tvdbId = clientTvdbId ?? null;
  if (tvdbId != null && Number.isInteger(tvdbId) && tvdbId > 0) {
    await rememberTvdbId(env, mediaType, tmdbId, tvdbId);
  } else {
    tvdbId = await lookupTvdbId(env, mediaType, tmdbId);
  }
  if (tvdbId == null) return null;
  return entityReference(mediaType, tvdbId, season, episode);
}
