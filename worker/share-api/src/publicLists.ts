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
import { MAX_TAGS_PER_LIST, normaliseTags } from "./publicListTags";

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
  const statements = [
    env.DB.prepare(
      `INSERT INTO public_lists (owner_id, list_id, tags, engagement, published_at, hidden_at)
       VALUES (?1, ?2, ?3, 0, ?4, NULL)
       ON CONFLICT(owner_id, list_id) DO UPDATE SET tags = ?3`,
    ).bind(session.userId, listId, JSON.stringify(tags), t),
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
 * worker has no scheduled() handler (index.ts:756). Per-list-on-write is the shape the
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
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM list_follows WHERE user_id = ?1`)
      .bind(session.userId)
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
