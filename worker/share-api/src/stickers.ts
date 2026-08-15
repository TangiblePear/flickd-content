// ── Sticker cut-outs ─────────────────────────────────────────────────────────
//
// Users cut characters out of promotional scenes on their own device (ML Kit subject
// segmentation) and upload the finished transparent PNG here. **No image processing
// happens in this Worker** — segmentation is what would cost money per image, and it
// has already happened by the time these bytes arrive.
//
// Object layout, in the social bucket:
//
//   stickers/{id}.png                the image bytes
//   stickers/{id}.json               { ownerId, tmdbId, mediaType, sha256, createdAt }
//   stickers/by-user/{ownerId}/{id}  zero-byte marker, used only to count a shelf
//   stickers/by-title/{type}/{tmdbId}/{id}  zero-byte marker; presence == publicly listed
//   _moderation/s/{id}.json          takedown tombstone -> GET answers 410
//
// ── Taking a sticker down (no route; operator action) ──
//
// There is deliberately no report/auto-hide path: a cut-out can only come from catalogue
// artwork we serve (`StickerRepository.sceneCandidates` offers nothing else), so the
// content is a crop of a licensed promotional still rather than anything a user supplied.
// SafeSearch at upload is the control. Should one ever need removing:
//
//   wrangler r2 object put  flickto-social/_moderation/s/{id}.json --file tombstone.json
//   wrangler r2 delete      flickto-social/stickers/by-title/{type}/{tmdbId}/{id}
//
// Both, not just the first: the tombstone makes the URL answer 410, and the second line
// is what stops it still occupying a tile in every community listing.
//
// ⚠️ **Flat, and not keyed on the uploader — this is load-bearing.** A sticker is cut
// from a public promotional image and published for everyone to use, so it is community
// content that OUTLIVES the account that made it (`eraseAccount` deliberately skips it).
// If the key or the public URL carried a `users.id`, every surviving sticker would keep
// a deleted account's identifier resolvable forever. The owner lives in the meta object
// instead, where it authorises deletion and nothing else.
//
// ⚠️ **No SafeSearch scan here, unlike the profile-picture upload — and that is a
// deliberate difference, not an oversight.** A picture is a photo the user chose off
// their own device; a cut-out can only come from catalogue artwork the app itself offers
// (`StickerRepository.sceneCandidates` exposes nothing else), so the content is a crop of
// a licensed promotional still. There is no user-supplied imagery to classify, and
// scanning one anyway is a paid Vision call per upload for an answer that is always the
// same. The size cap, magic-byte sniff and suspension check all still apply.
//
// ⚠️ **This reasoning depends entirely on there being no custom-image path.** The moment
// a photo picker, a URL field or any other user-supplied source reaches this endpoint,
// the scan has to come back — see `moderateImage` in src/moderation.ts.

import { resolveSession } from "./auth";
import { postingSuspendedUntil, suspendedBody } from "./suspension";

export interface StickerEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

/**
 * A cut-out is a full-alpha PNG, which compresses far worse than the photo a profile
 * picture is — but it is also a cropped subject rather than a whole frame. 1 MB is the
 * client's own cap (`StickerRepository.MAX_STICKER_BYTES`); the two are duplicated
 * deliberately so an oversized cut-out fails on the device instead of after an upload.
 */
export const MAX_STICKER_BYTES = 1024 * 1024;

/** Nobody needs an unbounded shelf, and an unbounded one is a free R2 quota to burn. */
export const MAX_STICKERS_PER_USER = 200;

/** `{id}` in every sticker path: lowercase hex, generated here and never client-supplied. */
export const STICKER_ID = "[a-f0-9]{32}";

/** One definition of the public URL; three call sites used to spell it out. */
const stickerUrl = (id: string) => `https://flickto.app/api/stickers/${id}`;

/** Title is display-only and travels so browse needs no catalogue lookups. */
const MAX_TITLE = 120;

const stickerKey = (id: string) => `stickers/${id}.png`;
const stickerMetaKey = (id: string) => `stickers/${id}.json`;
const stickerTombstoneKey = (id: string) => `_moderation/s/${id}.json`;
/**
 * Owner index. Zero-byte markers whose KEY is the whole record.
 *
 * Exists only so an upload can count what this account has already published without a
 * D1 table, and it is under `stickers/` rather than `accounts/` so that nothing about a
 * sticker sits in the account-scoped namespace the erasure batch sweeps.
 */
const ownerIndexKey = (ownerId: string, id: string) => `stickers/by-user/${ownerId}/${id}`;
const ownerIndexPrefix = (ownerId: string) => `stickers/by-user/${ownerId}/`;

/**
 * Title index — zero-byte markers whose KEY is the whole record, so the community
 * listing is one `list` with no per-sticker reads.
 *
 * ⚠️ **Presence in this index IS "public".** A sticker only gets a marker when it is
 * publicly listable, so the listing needs no `is_public` field to filter on and cannot
 * accidentally surface something by forgetting to check one. Withdrawing a sticker from
 * the market is deleting its marker; the sticker itself is untouched and its URL keeps
 * working for whoever already has it.
 */
const titleIndexKey = (mediaType: string, tmdbId: number, id: string) =>
  `stickers/by-title/${mediaType}/${tmdbId}/${id}`;
const titleIndexPrefix = (mediaType: string, tmdbId: number) =>
  `stickers/by-title/${mediaType}/${tmdbId}/`;

/** How many community stickers one title lists. Every one is an image someone's device fetches. */
export const COMMUNITY_LIMIT = 60;

interface StickerMeta {
  /** The uploader. Authorises deletion; never appears in a URL. */
  ownerId: string;
  tmdbId: number;
  mediaType: string;
  sha256: string;
  createdAt: number;
}

/**
 * Sniff the leading bytes for PNG or WebP.
 *
 * **Narrower than the profile picture's sniff on purpose.** A sticker without an alpha
 * channel is not a cut-out, and JPEG cannot carry one — so accepting JPEG here would
 * only ever store something the feature cannot use. GIF is excluded for the same reason
 * plus a second one: animated cut-outs are a later phase with a different pipeline, and
 * quietly accepting a GIF now would create stored objects that phase has to reckon with.
 */
export function sniffStickerType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) return "image/webp";
  return null;
}

/**
 * A TMDB id from the query string, or 0 for absent/nonsense.
 *
 * 0 rather than a 400: the tag is a convenience for grouping stickers by title and
 * nothing is authorised on it, so a missing one is a sticker with no title attached
 * rather than a bad request.
 */
function parseTmdbId(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 100_000_000 ? n : 0;
}

/** Only the two values the client sends. Anything else stores as "". */
function parseMediaType(raw: string | null): string {
  return raw === "tv" || raw === "movie" ? raw : "";
}

async function sha256hexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * POST /api/me/stickers?tmdb_id=&media_type= — session-authed upload of the raw PNG.
 *
 * POST and not PUT: there is no fixed key to replace. Every upload mints a new id, so
 * the request is not idempotent and must not advertise itself as one.
 */
export async function handleUploadSticker(
  req: Request,
  env: StickerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const suspended = await postingSuspendedUntil(env.DB, session.userId);
  if (suspended > 0) {
    return new Response(JSON.stringify(suspendedBody(suspended)), {
      status: 403,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength === 0) return json({ error: "invalid_body" }, 400);
  if (buf.byteLength > MAX_STICKER_BYTES) return json({ error: "too_large" }, 413);

  // Content-Type is never trusted; the bytes decide.
  const contentType = sniffStickerType(buf);
  if (!contentType) return json({ error: "unsupported_type" }, 400);

  // ⚠️ Counted BEFORE the scan, not after. The scan is the paid call, and letting
  // someone past the shelf cap burn one on every request would make the cap a limit on
  // storage only, with the bill left uncapped.
  const existing = await env.BUCKET.list({
    prefix: ownerIndexPrefix(session.userId),
    limit: MAX_STICKERS_PER_USER + 1,
  });
  if (existing.objects.length >= MAX_STICKERS_PER_USER) return json({ error: "shelf_full" }, 409);

  // ── Dedupe on the CONTENT HASH, before the scan and before any storage ──
  //
  // Two people cutting the same character out of the same frame produce the same bytes,
  // and storing that twice is two objects, two scans and two things to take down for one
  // image. The hash is the only dedupe key that is safe here: it cannot hand someone a
  // DIFFERENT cut-out than the one they just previewed, which keying on the source scene
  // would (same scene, different character tapped).
  //
  // Best-effort by nature — a different ML Kit model version produces a slightly
  // different mask and therefore a different hash — but every hit is a true one.
  //
  // Checked before anything is stored: identical bytes are already in the bucket, so the
  // put, the meta write and the index writes would all be duplicates of what is there.
  const sha256 = await sha256hexBytes(buf);
  const dupe = await env.DB
    .prepare("SELECT id FROM stickers WHERE sha256 = ?")
    .bind(sha256)
    .first<{ id: string }>();
  if (dupe) {
    const stillThere = await env.BUCKET.head(stickerKey(dupe.id));
    const tombstoned = await env.BUCKET.head(stickerTombstoneKey(dupe.id));
    if (stillThere && !tombstoned) {
      // Wanting the same image is a use, so it counts towards popularity — and the new
      // holder gets their own shelf marker so their cap includes it.
      await env.DB.prepare("UPDATE stickers SET uses = uses + 1 WHERE id = ?").bind(dupe.id).run();
      await env.BUCKET.put(ownerIndexKey(session.userId, dupe.id), "");
      return json({ ok: true, id: dupe.id, url: stickerUrl(dupe.id), deduped: true });
    }
    // The row outlived its object (deleted or taken down). Drop the stale row so this
    // upload can take the hash rather than being handed a 404 forever.
    await env.DB.prepare("DELETE FROM stickers WHERE id = ?").bind(dupe.id).run();
  }

  // Server-generated, never client-supplied: an id from the request would let a caller
  // overwrite an existing sticker, or path-traverse out of the prefix.
  const id = crypto.randomUUID().replace(/-/g, "");
  const url = new URL(req.url);
  const title = (url.searchParams.get("title") ?? "").slice(0, MAX_TITLE);

  await env.BUCKET.put(stickerKey(id), buf, { httpMetadata: { contentType } });
  const meta: StickerMeta = {
    ownerId: session.userId,
    tmdbId: parseTmdbId(url.searchParams.get("tmdb_id")),
    mediaType: parseMediaType(url.searchParams.get("media_type")),
    sha256,
    createdAt: Date.now(),
  };
  await env.BUCKET.put(stickerMetaKey(id), JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.BUCKET.put(ownerIndexKey(session.userId, id), "");
  // The catalogue row. `INSERT OR IGNORE` because `sha256` is UNIQUE: two uploads of the
  // same bytes racing past the dedupe check above would otherwise fail the second insert
  // and lose an object that is already in R2.
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO stickers (id, owner_id, tmdb_id, media_type, title, sha256, uses, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(id, session.userId, meta.tmdbId, meta.mediaType, title, sha256, meta.createdAt)
    .run();
  // Only when we know which title it came from — an untagged sticker has no market to
  // appear in, and inventing a bucket for it would put it in front of the wrong people.
  if (meta.tmdbId > 0 && meta.mediaType) {
    await env.BUCKET.put(titleIndexKey(meta.mediaType, meta.tmdbId, id), "");
  }

  return json({ ok: true, id, url: stickerUrl(id) });
}

/**
 * GET /api/stickers/{id} — public and unauthenticated **by design**.
 *
 * Coil loads it with no custom headers, exactly as it loads a profile picture, so
 * requiring one would break every sticker in the app rather than degrade it. A takedown
 * tombstone yields 410 so a removed sticker reads as "gone", not "never existed".
 */
export async function handleGetSticker(id: string, env: StickerEnv): Promise<Response> {
  const tomb = await env.BUCKET.get(stickerTombstoneKey(id));
  if (tomb) return new Response("gone", { status: 410, headers: { ...CORS } });

  const obj = await env.BUCKET.get(stickerKey(id));
  if (!obj) return new Response("not found", { status: 404, headers: { ...CORS } });

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
      // Immutable: a given id never changes what it serves. Deletion is the only
      // transition, and that answers 410 from the tombstone check above — which a
      // cached 200 hides, so a takedown is only as fast as the edge cache on clients
      // that already fetched it.
      "Cache-Control": "public, max-age=31536000, immutable",
      ...CORS,
    },
  });
}

/**
 * DELETE /api/me/stickers/{id} — session-authed removal of one of my own.
 *
 * Ownership comes from the meta object, not the path, because the path deliberately
 * carries no user id. A sticker somebody else uploaded answers 404 rather than 403:
 * confirming that an id exists but belongs to another account is an enumeration oracle,
 * and the caller has no legitimate use for the distinction.
 */
export async function handleDeleteSticker(
  req: Request,
  id: string,
  env: StickerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const metaObj = await env.BUCKET.get(stickerMetaKey(id));
  if (!metaObj) return json({ error: "not_found" }, 404);
  const meta = (await metaObj.json()) as StickerMeta;

  // ── Not mine: take it off MY shelf and stop ──
  //
  // Reachable since adoption and dedupe: a shelf holds stickers whose bytes belong to
  // somebody else, and the only thing a non-owner can meaningfully "delete" is their own
  // claim on it. Answering 404 here (as this did) left those stickers stuck on the shelf
  // forever AND left the marker inflating the holder's cap.
  if (meta.ownerId !== session.userId) {
    await env.BUCKET.delete(ownerIndexKey(session.userId, id));
    return json({ ok: true, removed: false });
  }

  await env.BUCKET.delete(stickerKey(id));
  await env.BUCKET.delete(stickerMetaKey(id));
  await env.BUCKET.delete(ownerIndexKey(session.userId, id));
  await env.DB.prepare("DELETE FROM stickers WHERE id = ?").bind(id).run();
  if (meta.tmdbId > 0 && meta.mediaType) {
    await env.BUCKET.delete(titleIndexKey(meta.mediaType, meta.tmdbId, id));
  }
  return json({ ok: true, removed: true });
}

/**
 * `GET /api/stickers/community?tmdb_id=&media_type=` — cut-outs other people published
 * for a title.
 *
 * Public and unauthenticated, like the sticker bytes themselves: these are images already
 * being served from public URLs, so requiring a session would gate the index to something
 * anyone can already fetch.
 *
 * One R2 `list` and no per-sticker reads — the marker keys carry everything the response
 * needs, which is the whole reason the index exists.
 */
export async function handleCommunityStickers(url: URL, env: StickerEnv): Promise<Response> {
  const tmdbId = parseTmdbId(url.searchParams.get("tmdb_id"));
  const mediaType = parseMediaType(url.searchParams.get("media_type"));
  if (tmdbId === 0 || !mediaType) return json({ error: "invalid_params" }, 400);

  const listed = await env.BUCKET.list({
    prefix: titleIndexPrefix(mediaType, tmdbId),
    limit: COMMUNITY_LIMIT,
  });
  const stickers = listed.objects.map((o) => {
    const id = o.key.slice(o.key.lastIndexOf("/") + 1);
    return { id, url: stickerUrl(id) };
  });

  return new Response(JSON.stringify({ stickers }), {
    headers: {
      "Content-Type": "application/json",
      // Short and shared: the same answer for every viewer of a title, and a new sticker
      // showing up a minute late is not worth a Worker invocation per detail-page open.
      "Cache-Control": "public, max-age=60",
      ...CORS,
    },
  });
}

/**
 * `GET /api/stickers/browse?sort=popular|new&cursor=&limit=` — every published sticker.
 *
 * Public and unauthenticated, like the per-title rail: it indexes images already served
 * from public URLs.
 *
 * Cursor is an OFFSET rather than a keyset. Ordering by a mutable counter makes a keyset
 * cursor lie — a sticker's `uses` can change between pages and move it across the
 * boundary — and an offset is honest about being a snapshot. Bounded hard by
 * [MAX_BROWSE_OFFSET] so this can never become an unbounded scan of the table.
 */
export async function handleBrowseStickers(url: URL, env: StickerEnv): Promise<Response> {
  const sort = url.searchParams.get("sort") === "new" ? "new" : "popular";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, BROWSE_LIMIT) : BROWSE_LIMIT;
  const cursorRaw = Number(url.searchParams.get("cursor"));
  const offset = Number.isInteger(cursorRaw) && cursorRaw > 0 ? Math.min(cursorRaw, MAX_BROWSE_OFFSET) : 0;

  // `id` as the tie-break in both orders: without it two rows on the same count (or the
  // same timestamp) can swap between pages, so one is shown twice and another never.
  const order = sort === "new" ? "created_at DESC, id" : "uses DESC, id";
  const { results } = await env.DB
    .prepare(
      `SELECT id, tmdb_id, media_type, title, uses FROM stickers
        ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .bind(limit + 1, offset)
    .all<{ id: string; tmdb_id: number; media_type: string; title: string; uses: number }>();

  const rows = results ?? [];
  // One extra row is fetched purely to answer "is there another page" without a COUNT(*).
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return new Response(
    JSON.stringify({
      stickers: page.map((r) => ({
        id: r.id,
        url: stickerUrl(r.id),
        tmdbId: r.tmdb_id,
        mediaType: r.media_type,
        title: r.title,
        uses: r.uses,
      })),
      nextCursor: hasMore ? offset + limit : null,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        // Same answer for everyone, and a minute stale is fine for a popularity ranking.
        "Cache-Control": "public, max-age=60",
        ...CORS,
      },
    },
  );
}

/**
 * `POST /api/stickers/{id}/use` — record that someone took this sticker.
 *
 * Session-authed, because an unauthenticated counter is a counter anyone can inflate with
 * a loop. It is still only a popularity signal and not a permission, so the dedupe is
 * deliberately cheap: one row per (sticker, user) in `sticker_uses` would be the strict
 * version, and it is not worth a table — a user can inflate a count by adopting, dropping
 * and re-adopting, which changes a ranking and nothing else.
 */
export async function handleUseSticker(
  req: Request,
  id: string,
  env: StickerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  // Their shelf marker, so the cap counts what they hold rather than only what they cut.
  await env.BUCKET.put(ownerIndexKey(session.userId, id), "");

  const res = await env.DB.prepare("UPDATE stickers SET uses = uses + 1 WHERE id = ?").bind(id).run();
  // No row means the sticker predates the catalogue table or has been deleted. Neither is
  // an error worth failing an adoption over — the user still has the image.
  if (!res.meta?.changes) return json({ ok: true, counted: false });
  return json({ ok: true, counted: true });
}

/** One page of the browse listing. */
const BROWSE_LIMIT = 60;

/**
 * How deep browse will page. 3000 rows at 60 a page is 50 pages — far past where anyone
 * scrolls, and the ceiling is what stops a crafted cursor turning this into a full scan.
 */
const MAX_BROWSE_OFFSET = 3000;
