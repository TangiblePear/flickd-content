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
import { refPath, resolveReference, type MediaType } from "./commsuniEntities";

/** How long a "nothing archived here" answer is trusted. */
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

/** Matches PAGE_LIMIT so the merged list is not lopsided against the native half. */
const ARCHIVE_PAGE_LIMIT = 20;

/**
 * One page of archive replies.
 *
 * Larger than the native REPLY_PAGE_LIMIT of 10 because archive replies are **not
 * translated** (see Phase 1), so a page costs no AI calls — only the single subrequest
 * it takes to fetch. The native limit is small precisely because a fully untranslated
 * page there spends one model call per reply.
 */
const ARCHIVE_REPLY_LIMIT = 25;

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

/**
 * One page of replies under an archive comment.
 *
 * ⚠️ **A separate route from the native one, not a widened one.** Archive ids are
 * UUIDs and match neither `COMMENT_ID_RE` (`[0-9A-Z:]{8,80}`) nor anything in our
 * `comments` table, so `/api/comments/{id}/replies` cannot serve them — it looks the
 * parent up locally and finds nothing. That is exactly what made expanding an archive
 * thread do nothing at all.
 *
 * Session-gated like every other archive read (§1), which is also what makes the actor
 * header available so the page comes back viewer-aware.
 */
export async function loadArchiveReplies(
  env: CommsuniEnv,
  commentId: string,
  userId: string,
  cursor?: string | null,
): Promise<{ comments: unknown[]; cursor: string | null; complete: boolean } | null> {
  if (!commsuniEnabled(env)) return null;

  const actor = await actorId(env, userId);
  const params = new URLSearchParams({ limit: String(ARCHIVE_REPLY_LIMIT) });
  if (cursor) params.set("cursor", cursor);

  const res = await commsuniCall<{
    replies?: unknown[];
    nextCursor?: string | null;
    complete?: boolean;
  }>(env, `/comments/${encodeURIComponent(commentId)}/replies?${params.toString()}`, { actor });

  console.log(
    JSON.stringify({
      msg: "commsuni archive replies",
      id: commentId,
      ok: res.ok,
      status: res.status ?? null,
      code: res.code ?? null,
      replies: Array.isArray(res.data?.replies) ? res.data!.replies!.length : null,
    }),
  );

  if (!res.ok) return null;
  const replies = Array.isArray(res.data?.replies) ? res.data!.replies! : [];
  return {
    comments: replies,
    // ⚠️ `nextCursor`, not `cursor` — the reply payload names it differently from the
    // comment list, and reading the wrong field silently ends pagination at page one.
    cursor: res.data?.nextCursor ?? null,
    complete: res.data?.complete ?? true,
  };
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
  // `show/tvdb-121361` — both segments. The type is not optional; omitting it 404s.
  const path = refPath(ref);

  if (await isKnownMiss(env, path)) return null;

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

  const res = await commsuniCall<{ comments?: unknown[]; nextCursor?: string | null; complete?: boolean }>(
    env,
    // ⚠️ Both segments, each encoded separately — encoding the joined path would turn
    // the `/` between type and id into `%2F` and 404 just as surely as omitting it.
    `/entities/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}/comments?${params.toString()}`,
    { actor },
  );

  // ⚠️ Log EVERY outcome, not just the ones carrying RateLimit headers.
  //
  // A 404 has no such header, so the original logging was silent on exactly the case
  // that matters — and "no log line" was indistinguishable from "the read never ran".
  // That ambiguity cost a full debugging cycle: an empty archive, a malformed request
  // and a scope error all present as a blank section.
  console.log(
    JSON.stringify({
      msg: "commsuni archive read",
      ref: path,
      ok: res.ok,
      status: res.status ?? null,
      code: res.code ?? null,
      comments: Array.isArray(res.data?.comments) ? res.data!.comments!.length : null,
      // Whether a next page exists — the question a bare count cannot answer.
      hasCursor: !!res.data?.nextCursor,
    }),
  );

  if (!res.ok) {
    // 404 not_archived / not_found is an EMPTY STATE, not a failure: nothing was ever
    // captured for this entity. Cache it so the long tail stops costing anything.
    if (res.status === 404 || res.code === "not_archived" || res.code === "not_found") {
      await rememberMiss(env, path);
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
    // ⚠️ **`nextCursor`, not `cursor`.** The request parameter is called `cursor` and
    // the RESPONSE field is called `nextCursor` — the spec spells this out ("`cursor`:
    // from the previous page's `nextCursor`"), and reading the wrong one is silent:
    // the cursor is simply always undefined, so `hasMore` is always false and the
    // "load more" control never appears. Measured on House of the Dragon, which
    // returned a full page of 20 with no way to reach page two.
    //
    // The identical trap is annotated in `loadArchiveReplies`; it was written there
    // first and not applied back to here.
    cursor: res.data?.nextCursor ?? null,
    complete: res.data?.complete ?? comments.length < ARCHIVE_PAGE_LIMIT,
    sources: sources.filter((s) => present.has(s.slug)),
  };
}
