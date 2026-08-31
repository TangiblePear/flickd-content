/**
 * The archive read path: fetch → dedup → render.
 *
 * Everything here is best-effort. §7: a failed archive call **hides the archive
 * section**, it does not break the screen — the native comments beside it are already
 * in Room and must render regardless.
 */

import {
  actorId,
  commsuniCall,
  commsuniEnabled,
  foreignSlugs,
  loadSources,
  type CommsuniEnv,
  type CommsuniSource,
} from "./commsuni";
import { resolveReference, type MediaType } from "./commsuniEntities";

/** How long a "nothing archived here" answer is trusted. */
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

/** Matches PAGE_LIMIT so the merged list is not lopsided against the native half. */
const ARCHIVE_PAGE_LIMIT = 20;

/**
 * The archive half of a comments response, or null.
 *
 * ⚠️ **null is a first-class answer, not an error.** It means "no archive section" —
 * the title is not archived, upstream is down, the breaker is open, or we hold no
 * TVDB id. The client renders the native half unchanged in every one of those cases,
 * so they deliberately do not need to be distinguishable.
 */
export interface ArchivePage {
  comments: unknown[];
  cursor: string | null;
  complete: boolean;
  /**
   * Branding for the slugs on this page, so the client can render a source badge.
   *
   * ⚠️ Supplied by the server because **the client has no API key** and must never
   * have one — it cannot call `GET /v1/sources` itself. Sending it per response also
   * means a partner that rebrands is reflected within our catalog TTL, which is the
   * whole reason §5 forbids hard-coding icons.
   *
   * Filtered to the slugs actually present, not the whole catalogue: 13 partners and
   * growing, and a page typically carries two or three.
   */
  sources: CommsuniSource[];
}

// ── Negative cache ──────────────────────────────────────────────────────────

/**
 * Has this reference recently answered "not archived"?
 *
 * ⚠️ A hit must return before any upstream call is made. Fetching and then rendering
 * empty produces the same screen and pays the `read_unit` anyway, which is precisely
 * the cost this exists to avoid.
 */
async function isKnownMiss(env: CommsuniEnv, ref: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT expires_at FROM archive_misses WHERE entity_ref = ?")
    .bind(ref)
    .first<{ expires_at: number }>()
    .catch(() => null);
  return !!row && row.expires_at > Date.now();
}

async function rememberMiss(env: CommsuniEnv, ref: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO archive_misses (entity_ref, checked_at, expires_at) VALUES (?,?,?)",
  )
    .bind(ref, now, now + MISS_TTL_MS)
    .run()
    .catch(() => {});
}

/**
 * Drop the miss for a reference.
 *
 * Phase 2 calls this the moment one of our users writes there: the entity now exists,
 * and leaving the miss cached would hide the user's own comment from the archive
 * section for up to [MISS_TTL_MS].
 */
export async function clearMiss(env: CommsuniEnv, ref: string): Promise<void> {
  await env.DB.prepare("DELETE FROM archive_misses WHERE entity_ref = ?").bind(ref).run().catch(() => {});
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Fetch the archive page for a subject, for one reader.
 *
 * Ordering is deliberate and each step exists to avoid a specific cost:
 *
 *  1. **Configured / enabled** — nothing else runs if the key is absent.
 *  2. **Resolve the reference** — no TVDB id, no archive section, no call.
 *  3. **Negative cache** — the long tail of the catalogue never reaches the network.
 *  4. **Source filter** — every active slug EXCEPT ours, so dedup happens server-side
 *     rather than by fetching our own rows and discarding them.
 *  5. **Fetch**, with the actor header so the response carries viewer state.
 *
 * @param userId our `users.id`. The actor ID is derived from it here and never taken
 *   from anything the device sent.
 */
export async function loadArchivePage(
  env: CommsuniEnv,
  mediaType: MediaType,
  tmdbId: number,
  season: number,
  episode: number,
  userId: string,
  clientTvdbId?: number | null,
  cursor?: string | null,
): Promise<ArchivePage | null> {
  if (!commsuniEnabled(env)) return null;

  const ref = await resolveReference(env, mediaType, tmdbId, season, episode, clientTvdbId);
  if (!ref) return null;

  if (await isKnownMiss(env, ref)) return null;

  // ⚠️ No slug list ⇒ do NOT fetch. Unfiltered means our own mirrored comments come
  // back and render twice beside the native rows they duplicate.
  const sources = await loadSources(env);
  const slugs = foreignSlugs(env, sources);
  if (!slugs) return null;

  const actor = await actorId(env, userId);
  const params = new URLSearchParams({
    source: slugs.join(","),
    limit: String(ARCHIVE_PAGE_LIMIT),
  });
  if (cursor) params.set("cursor", cursor);

  const res = await commsuniCall<{ comments?: unknown[]; cursor?: string | null; complete?: boolean }>(
    env,
    `/entities/${encodeURIComponent(ref)}/comments?${params.toString()}`,
    { actor },
  );

  if (!res.ok) {
    // 404 not_archived / not_found is an EMPTY STATE, not a failure: nothing was ever
    // captured for this entity. Cache it so the long tail stops costing anything.
    if (res.status === 404 || res.code === "not_archived" || res.code === "not_found") {
      await rememberMiss(env, ref);
    }
    return null;
  }

  const comments = Array.isArray(res.data?.comments) ? res.data!.comments! : [];

  // Only the slugs on this page. `origin` is the archive's own field name.
  const present = new Set(
    comments
      .map((c) => (c as { origin?: { slug?: string } })?.origin?.slug)
      .filter((x): x is string => !!x),
  );
  return {
    comments,
    cursor: res.data?.cursor ?? null,
    complete: res.data?.complete ?? comments.length < ARCHIVE_PAGE_LIMIT,
    sources: sources.filter((s) => present.has(s.slug)),
  };
}
