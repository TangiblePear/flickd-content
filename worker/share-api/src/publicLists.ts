// ── The public list directory ────────────────────────────────────────────────
//
// ⚠️ Three neighbours share vocabulary with this module and none of them is it:
//   • `lists.ts`        — friend-to-friend list SHARING (`shared_lists`, 0002)
//   • `userLists.ts`    — the lists a user KEEPS (`/api/me/lists`, 0026)
//   • `profiles.ts`     — lists pinned to one's own profile (`shared_list_ids`, 0037)
//
// This module publishes a list into a browsable directory and serves that directory.
// It owns `/api/public/lists*` plus the two publish verbs hanging off `/api/me/lists`.
//
// Nothing is copied: a `public_lists` row points at `lists (user_id, id)`, and every
// name and title is materialised on read. See migration 0039.

import { resolveSession } from "./auth";
import { MAX_TAGS_PER_LIST, PUBLIC_LIST_TAGS, normaliseTags } from "./publicListTags";

export interface PublicListsEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
  REPORT_AUTOHIDE?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const unauthorized = () => json({ error: "unauthorized" }, 401);
const badRequest = (error: string) => json({ error }, 400);
const notFound = () => json({ error: "not_found" }, 404);

/** The only publishable kind. See 0039's header for why the others are excluded. */
const PUBLISHABLE_KIND = "MANUAL";

export const MAX_PUBLISHED_PER_USER = 50;

const now = () => Date.now();

export function handlePublicListsOptions(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

// ── POST /api/me/lists/{id}/publish ──────────────────────────────────────────
//
// Idempotent: publishing an already-published list updates its tags. That is also
// how the client's "edit tags" works, so there is one write path rather than two.
export async function handlePublishList(
  listId: string,
  req: Request,
  env: PublicListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return unauthorized();

  const body = (await req.json().catch(() => null)) as { tags?: unknown } | null;
  if (!body) return badRequest("bad_json");

  const tags = normaliseTags(body.tags);
  if (tags.length === 0) return badRequest("tags_required");
  if (tags.length > MAX_TAGS_PER_LIST) return badRequest("too_many_tags");

  // Ownership and kind in one read. `deleted_at` matters: a tombstoned list is gone
  // as far as every other reader is concerned and must not reappear in a directory.
  const list = await env.DB.prepare(
    `SELECT kind, deleted_at FROM lists WHERE user_id = ?1 AND id = ?2`,
  )
    .bind(session.userId, listId)
    .first<{ kind: string; deleted_at: number | null }>();
  if (!list || list.deleted_at) return notFound();

  // Re-checked here and not only on the client, because the client is not a
  // security boundary — a crafted request would otherwise put an awards list or a
  // watchlist into the directory.
  if (list.kind !== PUBLISHABLE_KIND) return badRequest("kind_not_publishable");

  const items = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM list_items WHERE user_id = ?1 AND list_id = ?2`,
  )
    .bind(session.userId, listId)
    .first<{ n: number }>();
  if ((items?.n ?? 0) === 0) return badRequest("list_empty");

  const already = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM public_lists WHERE owner_id = ?1 AND list_id <> ?2`,
  )
    .bind(session.userId, listId)
    .first<{ n: number }>();
  if ((already?.n ?? 0) >= MAX_PUBLISHED_PER_USER) return json({ error: "too_many_published" }, 409);

  const t = now();

  // handleUnpublishList DELETEs the public_lists row, taking `hidden_at` with it — so a
  // takedown (admin `hide`, or the auto-hide threshold) would otherwise be gone the
  // moment the author unpublishes and republishes. `hide` never touches `reports.state`
  // (only `restore`/`dismiss` do — see dismissKind in moderationQueue.ts), so an OPEN
  // report against this exact target is the only trace of a takedown that survives the
  // DELETE. Re-applying it here — rather than refusing the republish outright — keeps
  // the list out of the directory without telling the author anything a takedown notice
  // would not: ON CONFLICT below never touches `hidden_at`, and `/api/me/follows`
  // reports this identically to a plain unpublish either way.
  const takenDown = await env.DB.prepare(
    `SELECT 1 AS ok FROM reports WHERE target_id = ?1 AND kind = 'public_list' AND state = 'open' LIMIT 1`,
  )
    .bind(`${session.userId}:${listId}`)
    .first<{ ok: number }>();
  const hiddenAt = takenDown ? t : null;

  const statements = [
    env.DB.prepare(
      `INSERT INTO public_lists (owner_id, list_id, tags, engagement, published_at, hidden_at)
       VALUES (?1, ?2, ?3, 0, ?4, ?5)
       ON CONFLICT(owner_id, list_id) DO UPDATE SET tags = ?3`,
    ).bind(session.userId, listId, JSON.stringify(tags), t, hiddenAt),
    // Replaced wholesale rather than merged: the request carries the complete
    // intended set, so a removed tag must actually disappear.
    env.DB.prepare(`DELETE FROM public_list_tags WHERE owner_id = ?1 AND list_id = ?2`).bind(
      session.userId,
      listId,
    ),
    ...tags.map((tag) =>
      env.DB.prepare(
        `INSERT INTO public_list_tags (tag, owner_id, list_id) VALUES (?1, ?2, ?3)
         ON CONFLICT(tag, owner_id, list_id) DO NOTHING`,
      ).bind(tag, session.userId, listId),
    ),
  ];
  await env.DB.batch(statements);

  return json({ published: true, tags, publishedAt: t });
}

// ── DELETE /api/me/lists/{id}/publish ────────────────────────────────────────
//
// Leaves `list_follows` and `public_list_likes` alone. A follower keeps what they
// already had — `/api/me/follows` reports it as `unpublished` so the client can
// badge it and offer a copy. Deleting the follow rows here would take the list off
// someone else's shelf without warning.
export async function handleUnpublishList(
  listId: string,
  req: Request,
  env: PublicListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return unauthorized();

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM public_lists WHERE owner_id = ?1 AND list_id = ?2`).bind(
      session.userId,
      listId,
    ),
    env.DB.prepare(`DELETE FROM public_list_tags WHERE owner_id = ?1 AND list_id = ?2`).bind(
      session.userId,
      listId,
    ),
  ]);
  return json({ published: false });
}

export const MAX_FOLLOWS = 100;

/**
 * Recompute `public_lists.engagement` for ONE list from the rows that are its truth.
 *
 * Returned as a statement so the caller can put it in the SAME batch as the write it
 * accounts for — a separate round trip could be lost and leave the cache behind.
 *
 * A whole-table sweep would be the other option and there is nowhere to run one: this
 * worker has no scheduled() handler (index.ts:820). Per-list-on-write is the shape the
 * cron budget allows.
 */
export function recomputeEngagement(
  env: PublicListsEnv,
  ownerId: string,
  listId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE public_lists SET engagement =
       3 * (SELECT COUNT(*) FROM list_follows      WHERE owner_id = ?1 AND list_id = ?2)
         + 1 * (SELECT COUNT(*) FROM public_list_likes WHERE owner_id = ?1 AND list_id = ?2)
     WHERE owner_id = ?1 AND list_id = ?2`,
  ).bind(ownerId, listId);
}

/** A published, visible list — the precondition for following or liking one. */
async function liveList(
  env: PublicListsEnv,
  ownerId: string,
  listId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM public_lists
      WHERE owner_id = ?1 AND list_id = ?2 AND hidden_at IS NULL`,
  )
    .bind(ownerId, listId)
    .first<{ ok: number }>();
  return !!row;
}

/**
 * Shared body of follow and like. They differ only in the table and in the follow
 * cap, so the alternative is two near-identical functions that drift.
 */
async function toggleEngagement(
  table: "list_follows" | "public_list_likes",
  ownerId: string,
  listId: string,
  req: Request,
  env: PublicListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return unauthorized();
  if (!(await liveList(env, ownerId, listId))) return notFound();

  const removing = req.method === "DELETE";

  if (!removing && table === "list_follows") {
    // Excludes the row this write would touch: the insert below is ON CONFLICT DO
    // NOTHING, so re-following something already followed adds no row and must never
    // trip the cap — only a genuinely new follow should be able to.
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM list_follows WHERE user_id = ?1 AND NOT (owner_id = ?2 AND list_id = ?3)`,
    )
      .bind(session.userId, ownerId, listId)
      .first<{ n: number }>();
    if ((n?.n ?? 0) >= MAX_FOLLOWS) return json({ error: "too_many_follows" }, 409);
  }

  const write = removing
    ? env.DB.prepare(
        `DELETE FROM ${table} WHERE user_id = ?1 AND owner_id = ?2 AND list_id = ?3`,
      ).bind(session.userId, ownerId, listId)
    : env.DB.prepare(
        `INSERT INTO ${table} (user_id, owner_id, list_id, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, owner_id, list_id) DO NOTHING`,
      ).bind(session.userId, ownerId, listId, now());

  await env.DB.batch([write, recomputeEngagement(env, ownerId, listId)]);
  return json({ ok: true, active: !removing });
}

// ── POST / DELETE /api/public/lists/{owner}/{id}/follow ──────────────────────
export function handleFollow(
  ownerId: string,
  listId: string,
  req: Request,
  env: PublicListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  return toggleEngagement("list_follows", ownerId, listId, req, env, ctx);
}

// ── POST / DELETE /api/public/lists/{owner}/{id}/like ────────────────────────
export function handleLike(
  ownerId: string,
  listId: string,
  req: Request,
  env: PublicListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  return toggleEngagement("public_list_likes", ownerId, listId, req, env, ctx);
}

export const BROWSE_PAGE = 20;
const MAX_QUERY = 60;
/** Posters shown on a browse card. */
const CARD_POSTERS = 4;

/**
 * Age decay, expressed with arithmetic SQLite is guaranteed to have.
 *
 * `engagement / (age_in_days + 2)`. No pow() — its availability in D1's SQLite build
 * is not worth assuming for a sort key. The +2 keeps a zero-age list finite and softens
 * the first day, and a linear divisor is gentle enough that a genuinely popular list
 * survives a few weeks while nothing owns the top of the directory forever.
 */
const TRENDING_ORDER =
  `p.engagement / ((?1 - p.published_at) / 86400000.0 + 2) DESC, p.published_at DESC`;

// ── GET /api/public/lists ────────────────────────────────────────────────────
//
// One page per request. Deliberately NOT a re-aggregating endpoint that a client can
// page through cheaply — every page costs a full sort, so the page size is the guard.
export async function handleBrowse(
  req: Request,
  env: PublicListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return unauthorized();

  const url = new URL(req.url);
  const sort = url.searchParams.get("sort") ?? "trending";
  const tag = url.searchParams.get("tag");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const offset = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0);
  const t = now();

  const order =
    sort === "new"
      ? "p.published_at DESC"
      : sort === "saved"
        ? "saves DESC, p.published_at DESC"
        : TRENDING_ORDER;

  // `blocks` is checked in BOTH directions: an author who blocked the viewer should
  // not be browsable by them, and a viewer who blocked the author should not see them.
  const rows = await env.DB.prepare(
    `SELECT p.owner_id, p.list_id, p.tags, p.published_at,
            l.name, l.description,
            pr.display_name, pr.picture_url,
            (SELECT COUNT(*) FROM list_items li
               WHERE li.user_id = p.owner_id AND li.list_id = p.list_id) AS item_count,
            (SELECT COUNT(*) FROM list_follows f
               WHERE f.owner_id = p.owner_id AND f.list_id = p.list_id) AS saves,
            (SELECT COUNT(*) FROM public_list_likes k
               WHERE k.owner_id = p.owner_id AND k.list_id = p.list_id) AS likes,
            (SELECT COUNT(*) FROM list_follows f2
               WHERE f2.owner_id = p.owner_id AND f2.list_id = p.list_id
                 AND f2.user_id = ?2) AS is_saved,
            (SELECT COUNT(*) FROM public_list_likes k2
               WHERE k2.owner_id = p.owner_id AND k2.list_id = p.list_id
                 AND k2.user_id = ?2) AS is_liked
       FROM public_lists p
       JOIN lists l    ON l.user_id = p.owner_id AND l.id = p.list_id
       LEFT JOIN profiles pr ON pr.user_id = p.owner_id
      WHERE p.hidden_at IS NULL
        AND l.deleted_at IS NULL
        AND (?3 IS NULL OR EXISTS (
              SELECT 1 FROM public_list_tags pt
               WHERE pt.tag = ?3 AND pt.owner_id = p.owner_id AND pt.list_id = p.list_id))
        AND (?4 = '' OR l.name LIKE ?5 OR l.description LIKE ?5 OR pr.display_name LIKE ?5)
        AND NOT EXISTS (
              SELECT 1 FROM blocks b
               WHERE (b.blocker_id = p.owner_id AND b.blocked_id = ?2)
                  OR (b.blocker_id = ?2 AND b.blocked_id = p.owner_id))
      ORDER BY ${order}
      LIMIT ?6 OFFSET ?7`,
  )
    .bind(t, session.userId, tag, q, `%${q}%`, BROWSE_PAGE + 1, offset)
    .all<Record<string, unknown>>();

  const page = (rows.results ?? []).slice(0, BROWSE_PAGE);
  const hasMore = (rows.results ?? []).length > BROWSE_PAGE;

  // One extra indexed read for every card's posters, rather than a denormalised
  // copy on `public_lists` that would drift the moment an author reorders the list.
  //
  // Ranked per list rather than bounded by absolute position: `position` is
  // append-only and sparse (assigned as COALESCE(MAX(position), -1) + 1, and a
  // removal is a plain delete with no renumbering — Android Daos.kt:1753,
  // CustomListsRepository.kt:300). A list whose first four items were removed has
  // every surviving position >= CARD_POSTERS, so `position < CARD_POSTERS` would
  // return zero posters for a card that still has items. Ranking picks the top
  // CARD_POSTERS rows by position regardless of what the absolute values are.
  const posters = new Map<string, { tmdbId: number; type: string }[]>();
  if (page.length) {
    const keys = page.map((r) => `${r.owner_id} ${r.list_id}`);
    const placeholders = page.map((_, i) => `(?${i * 2 + 1}, ?${i * 2 + 2})`).join(",");
    const binds = page.flatMap((r) => [r.owner_id, r.list_id]);
    const items = await env.DB.prepare(
      `SELECT user_id, list_id, tmdb_id, type FROM (
         SELECT user_id, list_id, tmdb_id, type,
                ROW_NUMBER() OVER (PARTITION BY user_id, list_id ORDER BY position, added_at) AS rn
           FROM list_items
          WHERE (user_id, list_id) IN (${placeholders})
       ) AS ranked
        WHERE ranked.rn <= ${CARD_POSTERS}
        ORDER BY ranked.list_id, ranked.rn`,
    )
      .bind(...binds)
      .all<{ user_id: string; list_id: string; tmdb_id: number; type: string }>();
    for (const k of keys) posters.set(k, []);
    for (const i of items.results ?? []) {
      posters.get(`${i.user_id} ${i.list_id}`)?.push({ tmdbId: i.tmdb_id, type: i.type });
    }
  }

  return json({
    lists: page.map((r) => ({
      ownerId: r.owner_id,
      listId: r.list_id,
      name: r.name,
      description: r.description ?? "",
      itemCount: r.item_count,
      authorName: r.display_name ?? "",
      authorPictureUrl: r.picture_url ?? "",
      tags: safeTags(r.tags as string),
      saves: r.saves,
      likes: r.likes,
      saved: Number(r.is_saved) > 0,
      liked: Number(r.is_liked) > 0,
      publishedAt: r.published_at,
      posters: posters.get(`${r.owner_id} ${r.list_id}`) ?? [],
    })),
    nextCursor: hasMore ? offset + BROWSE_PAGE : null,
  });
}

export const MAX_PUBLIC_ITEMS = 500;
const MAX_REPORT_CONTEXT = 500;
const DEFAULT_REPORT_AUTOHIDE = 3;

/** Every title in a list, capped, in the author's order. */
async function itemsFor(env: PublicListsEnv, ownerId: string, listId: string) {
  const rows = await env.DB.prepare(
    `SELECT tmdb_id, type, position, ai_note FROM list_items
      WHERE user_id = ?1 AND list_id = ?2
      ORDER BY position, added_at
      LIMIT ${MAX_PUBLIC_ITEMS}`,
  )
    .bind(ownerId, listId)
    .all<{ tmdb_id: number; type: string; position: number; ai_note: string | null }>();
  return (rows.results ?? []).map((i) => ({
    tmdbId: i.tmdb_id,
    type: i.type,
    position: i.position,
    note: i.ai_note ?? "",
  }));
}

// ── GET /api/public/lists/{owner}/{id} ───────────────────────────────────────
export async function handlePublicListDetail(
  ownerId: string,
  listId: string,
  req: Request,
  env: PublicListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return unauthorized();

  const row = await env.DB.prepare(
    `SELECT p.tags, p.published_at, l.name, l.description, l.updated_at,
            pr.display_name, pr.picture_url,
            (SELECT COUNT(*) FROM list_follows f
               WHERE f.owner_id = p.owner_id AND f.list_id = p.list_id) AS saves,
            (SELECT COUNT(*) FROM public_list_likes k
               WHERE k.owner_id = p.owner_id AND k.list_id = p.list_id) AS likes,
            (SELECT COUNT(*) FROM list_follows f2
               WHERE f2.owner_id = p.owner_id AND f2.list_id = p.list_id AND f2.user_id = ?3) AS is_saved,
            (SELECT COUNT(*) FROM public_list_likes k2
               WHERE k2.owner_id = p.owner_id AND k2.list_id = p.list_id AND k2.user_id = ?3) AS is_liked
       FROM public_lists p
       JOIN lists l ON l.user_id = p.owner_id AND l.id = p.list_id
       LEFT JOIN profiles pr ON pr.user_id = p.owner_id
      WHERE p.owner_id = ?1 AND p.list_id = ?2
        AND p.hidden_at IS NULL AND l.deleted_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM blocks b
               WHERE (b.blocker_id = p.owner_id AND b.blocked_id = ?3)
                  OR (b.blocker_id = ?3 AND b.blocked_id = p.owner_id))`,
  )
    .bind(ownerId, listId, session.userId)
    .first<Record<string, unknown>>();
  if (!row) return notFound();

  return json({
    ownerId,
    listId,
    name: row.name,
    description: row.description ?? "",
    authorName: row.display_name ?? "",
    authorPictureUrl: row.picture_url ?? "",
    tags: safeTags(row.tags as string),
    saves: row.saves,
    likes: row.likes,
    saved: Number(row.is_saved) > 0,
    liked: Number(row.is_liked) > 0,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    items: await itemsFor(env, ownerId, listId),
  });
}

// ── GET /api/me/follows ──────────────────────────────────────────────────────
//
// ⚠️ Its own endpoint, NOT folded into `/api/me/lists`.
//
// That snapshot is gated on `lists_meta.version`. Reusing it would mean an author
// editing one list has to bump the meta row of every follower — 200 followers, 200
// writes, on every edit. This is a bounded read against MAX_FOLLOWS rows instead.
//
// `status` collapses three author-side outcomes into what the follower needs to know:
//   live         — still published; keep updating.
//   unpublished  — author withdrew it, OR it was hidden by moderation. Deliberately
//                  the same value: a follower must not be able to tell a takedown from
//                  a withdrawal.
//   gone         — the author deleted the list.
// The client keeps its rows for the latter two and badges them.
export async function handleMyFollows(
  req: Request,
  env: PublicListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return unauthorized();

  const rows = await env.DB.prepare(
    `SELECT f.owner_id, f.list_id, l.user_id AS list_owner, l.name, l.description,
            l.updated_at, l.deleted_at,
            p.tags, p.hidden_at,
            pr.display_name, pr.picture_url,
            CASE WHEN p.owner_id IS NULL THEN 0 ELSE 1 END AS still_published
       FROM list_follows f
       LEFT JOIN lists l    ON l.user_id = f.owner_id AND l.id = f.list_id
       LEFT JOIN public_lists p ON p.owner_id = f.owner_id AND p.list_id = f.list_id
       LEFT JOIN profiles pr    ON pr.user_id = f.owner_id
      WHERE f.user_id = ?1
      ORDER BY f.created_at DESC
      LIMIT ${MAX_FOLLOWS}`,
  )
    .bind(session.userId)
    .all<Record<string, unknown>>();

  const results = rows.results ?? [];
  // Keyed on the LEFT JOIN actually failing, not on `name` — `lists.name` is NOT NULL
  // but not constrained non-empty, so an empty name must not be mistaken for "gone".
  const goneOf = (r: Record<string, unknown>) => r.list_owner == null || r.deleted_at != null;
  const live = results.filter((r) => !goneOf(r));

  // Batched the same way handleBrowse batches poster lookups (a row-value IN over a
  // ROW_NUMBER-ranked derived table) rather than one itemsFor() call per followed list.
  // The loop form was up to MAX_FOLLOWS D1 calls in a single request.
  const itemsByList = new Map<
    string,
    { tmdbId: number; type: string; position: number; note: string }[]
  >();
  if (live.length) {
    const placeholders = live.map((_, i) => `(?${i * 2 + 1}, ?${i * 2 + 2})`).join(",");
    const binds = live.flatMap((r) => [r.owner_id, r.list_id]);
    const items = await env.DB.prepare(
      `SELECT user_id, list_id, tmdb_id, type, position, ai_note FROM (
         SELECT user_id, list_id, tmdb_id, type, position, ai_note,
                ROW_NUMBER() OVER (PARTITION BY user_id, list_id ORDER BY position, added_at) AS rn
           FROM list_items
          WHERE (user_id, list_id) IN (${placeholders})
       ) AS ranked
        WHERE ranked.rn <= ${MAX_PUBLIC_ITEMS}
        ORDER BY ranked.list_id, ranked.rn`,
    )
      .bind(...binds)
      .all<{
        user_id: string;
        list_id: string;
        tmdb_id: number;
        type: string;
        position: number;
        ai_note: string | null;
      }>();
    for (const r of live) itemsByList.set(`${r.owner_id} ${r.list_id}`, []);
    for (const i of items.results ?? []) {
      itemsByList.get(`${i.user_id} ${i.list_id}`)?.push({
        tmdbId: i.tmdb_id,
        type: i.type,
        position: i.position,
        note: i.ai_note ?? "",
      });
    }
  }

  const follows = results.map((r) => {
    const gone = goneOf(r);
    const isLive = !gone && Number(r.still_published) === 1 && r.hidden_at == null;
    return {
      ownerId: r.owner_id,
      listId: r.list_id,
      status: gone ? "gone" : isLive ? "live" : "unpublished",
      name: r.name ?? "",
      description: r.description ?? "",
      authorName: r.display_name ?? "",
      authorPictureUrl: r.picture_url ?? "",
      tags: safeTags(r.tags as string | null),
      updatedAt: r.updated_at ?? 0,
      // A gone list has no items to fetch; everything else materialises live, which
      // is the whole reason a follow stays current without a propagation step.
      items: gone ? [] : (itemsByList.get(`${r.owner_id} ${r.list_id}`) ?? []),
    };
  });
  return json({ follows });
}

/**
 * The ONE writer of `public_lists.hidden_at`.
 *
 * Shared with the admin takedown in moderationQueue.ts — the same rule
 * moderationQueue.ts:431 already records for comments: a manual takedown and the
 * automatic one must write the same thing, or the two drift and the admin panel stops
 * describing what the read paths actually do.
 *
 * `at = null` restores. A hide applies only to a row that is not already hidden, so a
 * later report cannot re-date an existing takedown; a restore is unconditional, which
 * is what makes the auto-hide threshold reversible rather than terminal.
 */
export function setPublicListHidden(
  env: PublicListsEnv,
  ownerId: string,
  listId: string,
  at: number | null,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE public_lists SET hidden_at = ?3
      WHERE owner_id = ?1 AND list_id = ?2 AND (?3 IS NULL OR hidden_at IS NULL)`,
  ).bind(ownerId, listId, at);
}

// ── POST /api/public/lists/{owner}/{id}/report ───────────────────────────────
//
// Files into the SAME `reports` table as comments, profiles and pictures, so the
// unified queue in moderationQueue.ts picks it up with no second store to reconcile.
export async function handleReportPublicList(
  ownerId: string,
  listId: string,
  req: Request,
  env: PublicListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return unauthorized();

  const body = (await req.json().catch(() => null)) as { context?: unknown } | null;
  const context =
    typeof body?.context === "string" ? body.context.slice(0, MAX_REPORT_CONTEXT) : null;

  const targetId = `${ownerId}:${listId}`;
  const t = now();

  // One OPEN report per reporter per target. Without it a single person could trip
  // the auto-hide threshold on their own, which makes it a brigading tool.
  await env.DB.prepare(
    `INSERT INTO reports (id, reporter_id, target_id, kind, context, state, created_at)
     SELECT ?1, ?2, ?3, 'public_list', ?4, 'open', ?5
      WHERE NOT EXISTS (
        SELECT 1 FROM reports
         WHERE reporter_id = ?2 AND target_id = ?3 AND kind = 'public_list' AND state = 'open')`,
  )
    .bind(crypto.randomUUID(), session.userId, targetId, context, t)
    .run();

  const threshold = Number(env.REPORT_AUTOHIDE ?? DEFAULT_REPORT_AUTOHIDE);
  const distinct = await env.DB.prepare(
    `SELECT COUNT(DISTINCT reporter_id) AS n FROM reports
      WHERE target_id = ?1 AND kind = 'public_list' AND state = 'open'`,
  )
    .bind(targetId)
    .first<{ n: number }>();

  if ((distinct?.n ?? 0) >= threshold) {
    await setPublicListHidden(env, ownerId, listId, t).run();
  }

  return json({ ok: true });
}

/** A malformed tags column degrades one card's chips; it does not break the page. */
function safeTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ── GET /api/public/lists/tags ───────────────────────────────────────────────
//
// The vocabulary with live counts, so the client can order the rail by what people
// actually use and hide tags nothing is filed under.
export async function handleTagCatalogue(
  req: Request,
  env: PublicListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return unauthorized();

  const rows = await env.DB.prepare(
    `SELECT pt.tag, COUNT(*) AS n
       FROM public_list_tags pt
       JOIN public_lists p ON p.owner_id = pt.owner_id AND p.list_id = pt.list_id
      WHERE p.hidden_at IS NULL
      GROUP BY pt.tag`,
  ).all<{ tag: string; n: number }>();

  const counts = new Map((rows.results ?? []).map((r) => [r.tag, r.n]));
  return json({
    tags: PUBLIC_LIST_TAGS.map((tag) => ({ tag, count: counts.get(tag) ?? 0 })),
  });
}
