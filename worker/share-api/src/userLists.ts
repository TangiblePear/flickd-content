// ── Personal lists and the watchlist ─────────────────────────────────────────
//
// ⚠️ NOT `lists.ts`. That module is friend-to-friend list SHARING (`shared_lists`,
// migration 0002) — a directed message from one user to another, routed under
// `/api/lists/*`. This module owns the lists a user KEEPS, routed under
// `/api/me/lists*`, and the two share nothing but a word.
//
// Concurrency is deliberately two-tier, which is a departure from settings.ts:
//
//   • The list HEADER (name, description, pin, order, and a smart list's
//     filters) uses `If-Match: <version>` exactly as profiles/settings do.
//   • ITEMS use no version at all. Adding and removing distinct items are
//     commutative, so two devices editing different items of one list have no
//     conflict to detect. A single version across a COLLECTION would make
//     editing list A on a phone spuriously conflict with editing list B in a
//     browser — settings can share one version because it is one owned object;
//     a set of lists is not.
//
// See migration 0026 for why this is D1 rather than an R2 document.

import { resolveSession } from "./auth";

export interface UserListsEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-Revoke-Session, X-App-Version",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

const unauthorized = () => json({ error: "unauthorized" }, 401);
const badRequest = (error: string) => json({ error }, 400);

/** Caps mirroring the house convention — client-controlled writes get bounds. */
const MAX_LISTS = 200;
const MAX_ITEMS_PER_REQUEST = 500;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 500;
const MAX_ID = 64;
const MAX_AI_NOTE = 300;
/** Android's BUILTIN_WATCHLIST id, the same constant on every account. */
const WATCHLIST_KIND = "BUILTIN_WATCHLIST";

const now = () => Date.now();
const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length ? v.slice(0, max) : null;
const int = (v: unknown): number | null => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const bool = (v: unknown): number => (v === true || v === 1 || v === "1" ? 1 : 0);

interface ListRow {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  source_collection_id: string | null;
  auto_updated: number;
  media_filter: string | null;
  manual_sort_mode: string | null;
  is_pinned_to_home: number;
  display_order: number;
  home_order: number;
  version: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

const jsonCol = (raw: string | null): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null; // a bad row degrades the filter, it does not break the read
  }
};

function toWire(row: ListRow, filters: Record<string, unknown> | null, items: unknown[] | null) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description ?? "",
    sourceCollectionId: row.source_collection_id ?? "",
    autoUpdated: row.auto_updated === 1,
    mediaFilter: row.media_filter ?? "",
    manualSortMode: row.manual_sort_mode ?? "",
    isPinnedToHome: row.is_pinned_to_home === 1,
    displayOrder: row.display_order,
    homeOrder: row.home_order,
    version: row.version,
    deletedAt: row.deleted_at ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(filters ? { filters } : {}),
    ...(items ? { items } : {}),
  };
}

/** Bump the freshness pointer in the same batch as the write it accompanies. */
function bumpMeta(env: UserListsEnv, userId: string) {
  return env.DB.prepare(
    `INSERT INTO lists_meta (user_id, version, list_count, item_count, updated_at)
     VALUES (?1, 1, 0, 0, ?2)
     ON CONFLICT(user_id) DO UPDATE SET version = version + 1, updated_at = ?2`,
  ).bind(userId, now());
}

async function metaVersion(env: UserListsEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT version FROM lists_meta WHERE user_id = ?1`)
    .bind(userId)
    .first<{ version: number }>();
  return row?.version ?? 0;
}

// ── GET /api/me/lists?version=N ──────────────────────────────────────────────
//
// Returns the whole snapshot, or `{version, upToDate:true}` when the caller's
// version already matches — so a polling client costs one indexed read.
export async function handleGetMyLists(
  req: Request,
  env: UserListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();

  const version = await metaVersion(env, session.userId);
  const since = int(new URL(req.url).searchParams.get("version"));
  if (since !== null && since === version && version > 0) return json({ version, upToDate: true });

  const [lists, filters, items] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM lists WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY display_order, created_at`,
    )
      .bind(session.userId)
      .all<ListRow>(),
    env.DB.prepare(`SELECT * FROM list_filters WHERE user_id = ?1`).bind(session.userId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT list_id, tmdb_id, type, position, match_percentage, ai_note, added_at
         FROM list_items WHERE user_id = ?1 ORDER BY list_id, position, added_at`,
    )
      .bind(session.userId)
      .all<Record<string, unknown>>(),
  ]);

  const filterBy = new Map<string, Record<string, unknown>>();
  for (const f of filters.results ?? []) {
    filterBy.set(String(f.list_id), {
      sortBy: f.sort_by ?? null,
      includeGenres: jsonCol(f.include_genres as string | null) ?? [],
      excludeGenres: jsonCol(f.exclude_genres as string | null) ?? [],
      yearFrom: f.year_from ?? null,
      yearTo: f.year_to ?? null,
      ratingMin: f.rating_min ?? null,
      ratingMax: f.rating_max ?? null,
      voteCountMin: f.vote_count_min ?? null,
      voteCountMax: f.vote_count_max ?? null,
      language: f.language ?? null,
      includeUnreleased: f.include_unreleased === 1,
      mediaTypes: jsonCol(f.media_types as string | null) ?? [],
      relativeReleaseWindow: f.relative_release_window ?? null,
    });
  }

  const itemsBy = new Map<string, unknown[]>();
  for (const i of items.results ?? []) {
    const key = String(i.list_id);
    let arr = itemsBy.get(key);
    if (!arr) itemsBy.set(key, (arr = []));
    arr.push({
      tmdbId: i.tmdb_id,
      type: i.type,
      position: i.position,
      matchPercentage: i.match_percentage ?? null,
      aiNote: i.ai_note ?? null,
      addedAt: i.added_at,
    });
  }

  return json({
    version,
    lists: (lists.results ?? []).map((row) =>
      toWire(row, filterBy.get(row.id) ?? null, itemsBy.get(row.id) ?? []),
    ),
  });
}

/** Write the 1:1 filter row for a smart list. Absent keys are left alone. */
function filterStatement(env: UserListsEnv, userId: string, listId: string, f: Record<string, unknown>) {
  const arr = (v: unknown) => (Array.isArray(v) ? JSON.stringify(v) : null);
  return env.DB.prepare(
    `INSERT INTO list_filters (user_id, list_id, sort_by, include_genres, exclude_genres,
       year_from, year_to, rating_min, rating_max, vote_count_min, vote_count_max,
       language, include_unreleased, media_types, relative_release_window, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
     ON CONFLICT(user_id, list_id) DO UPDATE SET
       sort_by=?3, include_genres=?4, exclude_genres=?5, year_from=?6, year_to=?7,
       rating_min=?8, rating_max=?9, vote_count_min=?10, vote_count_max=?11,
       language=?12, include_unreleased=?13, media_types=?14,
       relative_release_window=?15, updated_at=?16`,
  ).bind(
    userId,
    listId,
    str(f.sortBy, 40),
    arr(f.includeGenres),
    arr(f.excludeGenres),
    int(f.yearFrom),
    int(f.yearTo),
    Number.isFinite(Number(f.ratingMin)) ? Number(f.ratingMin) : null,
    Number.isFinite(Number(f.ratingMax)) ? Number(f.ratingMax) : null,
    int(f.voteCountMin),
    int(f.voteCountMax),
    str(f.language, 12),
    bool(f.includeUnreleased),
    arr(f.mediaTypes),
    str(f.relativeReleaseWindow, 24),
    now(),
  );
}

// ── POST /api/me/lists ───────────────────────────────────────────────────────
//
// Idempotent create: the client mints the id (a UUID, or the literal
// "watchlist"), so a retry after a dropped response cannot produce a duplicate.
export async function handleCreateList(
  req: Request,
  env: UserListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return badRequest("bad_json");

  const id = str(body.id, MAX_ID);
  const name = str(body.name, MAX_NAME);
  const kind = str(body.kind, 40);
  if (!id || !name || !kind) return badRequest("id_name_kind_required");

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM lists WHERE user_id = ?1 AND deleted_at IS NULL`,
  )
    .bind(session.userId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_LISTS) return json({ error: "too_many_lists" }, 409);

  const t = now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO lists (user_id, id, name, kind, description, source_collection_id,
         auto_updated, media_filter, manual_sort_mode, is_pinned_to_home,
         display_order, home_order, version, deleted_at, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,NULL,?13,?13)
       ON CONFLICT(user_id, id) DO NOTHING`,
    ).bind(
      session.userId,
      id,
      name,
      kind,
      str(body.description, MAX_DESCRIPTION),
      str(body.sourceCollectionId, MAX_ID),
      bool(body.autoUpdated),
      str(body.mediaFilter, 40),
      str(body.manualSortMode, 40),
      bool(body.isPinnedToHome),
      int(body.displayOrder) ?? 0,
      int(body.homeOrder) ?? 0,
      t,
    ),
    bumpMeta(env, session.userId),
  ];
  if (body.filters && typeof body.filters === "object") {
    statements.splice(1, 0, filterStatement(env, session.userId, id, body.filters as Record<string, unknown>));
  }
  await env.DB.batch(statements);

  const row = await env.DB.prepare(`SELECT * FROM lists WHERE user_id = ?1 AND id = ?2`)
    .bind(session.userId, id)
    .first<ListRow>();
  return row ? json({ list: toWire(row, null, null) }, 201) : json({ error: "not_created" }, 500);
}

// ── PUT /api/me/lists/{id} ───────────────────────────────────────────────────
//
// Merge of only the fields sent, guarded by `If-Match: <version>` — the same
// contract as settings.ts. Omitted keys are left untouched, so a client that
// only knows about `name` cannot blank `homeOrder` by sending a partial object.
export async function handleUpdateList(
  id: string,
  req: Request,
  env: UserListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return badRequest("bad_json");

  const row = await env.DB.prepare(`SELECT * FROM lists WHERE user_id = ?1 AND id = ?2`)
    .bind(session.userId, id)
    .first<ListRow>();
  if (!row || row.deleted_at) return json({ error: "not_found" }, 404);

  const ifMatch = (req.headers.get("If-Match") ?? "").replace(/"/g, "").trim();
  if (ifMatch !== "" && Number(ifMatch) !== row.version) {
    return json({ error: "version_conflict", version: row.version }, 409);
  }

  const pick = <T>(key: string, current: T, parse: (v: unknown) => T): T =>
    key in body ? parse(body[key]) : current;

  const t = now();
  const statements = [
    env.DB.prepare(
      `UPDATE lists SET name=?3, description=?4, media_filter=?5, manual_sort_mode=?6,
         is_pinned_to_home=?7, display_order=?8, home_order=?9, auto_updated=?10,
         version = version + 1, updated_at=?11
       WHERE user_id=?1 AND id=?2`,
    ).bind(
      session.userId,
      id,
      pick("name", row.name, (v) => str(v, MAX_NAME) ?? row.name),
      pick("description", row.description, (v) => str(v, MAX_DESCRIPTION)),
      pick("mediaFilter", row.media_filter, (v) => str(v, 40)),
      pick("manualSortMode", row.manual_sort_mode, (v) => str(v, 40)),
      pick("isPinnedToHome", row.is_pinned_to_home, bool),
      pick("displayOrder", row.display_order, (v) => int(v) ?? row.display_order),
      pick("homeOrder", row.home_order, (v) => int(v) ?? row.home_order),
      pick("autoUpdated", row.auto_updated, bool),
      t,
    ),
    bumpMeta(env, session.userId),
  ];
  if (body.filters && typeof body.filters === "object") {
    statements.splice(1, 0, filterStatement(env, session.userId, id, body.filters as Record<string, unknown>));
  }
  await env.DB.batch(statements);

  return json({ version: row.version + 1 });
}

// ── DELETE /api/me/lists/{id} ────────────────────────────────────────────────
export async function handleDeleteList(
  id: string,
  req: Request,
  env: UserListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();

  const row = await env.DB.prepare(`SELECT kind FROM lists WHERE user_id = ?1 AND id = ?2`)
    .bind(session.userId, id)
    .first<{ kind: string }>();
  if (!row) return json({ error: "not_found" }, 404);
  // Defence in depth: no client should offer this, and losing it would strand
  // every saved title with nowhere to live.
  if (row.kind === WATCHLIST_KIND) return json({ error: "watchlist_not_deletable" }, 400);

  await env.DB.batch([
    env.DB.prepare(`UPDATE lists SET deleted_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2`).bind(
      session.userId,
      id,
      now(),
    ),
    // Items go for good; the tombstone only needs to carry the fact of deletion.
    env.DB.prepare(`DELETE FROM list_items WHERE user_id = ?1 AND list_id = ?2`).bind(session.userId, id),
    env.DB.prepare(`DELETE FROM list_filters WHERE user_id = ?1 AND list_id = ?2`).bind(session.userId, id),
    // A published list's directory row and tags. Left behind, the orphan is not a
    // content leak — browse/detail both gate on `lists.deleted_at IS NULL` — but it
    // permanently occupies a slot in the publish cap, and `liveList` would still let
    // anyone follow or like it.
    env.DB.prepare(`DELETE FROM public_lists WHERE owner_id = ?1 AND list_id = ?2`).bind(session.userId, id),
    env.DB.prepare(`DELETE FROM public_list_tags WHERE owner_id = ?1 AND list_id = ?2`).bind(session.userId, id),
    bumpMeta(env, session.userId),
  ]);
  return json({ ok: true });
}

// ── POST / DELETE /api/me/lists/{id}/items ───────────────────────────────────
//
// No `If-Match`. See the header: item operations are commutative, so there is
// no conflict for a version to detect.
export async function handleListItems(
  id: string,
  req: Request,
  env: UserListsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return unauthorized();

  const body = (await req.json().catch(() => null)) as { items?: unknown } | null;
  const items = Array.isArray(body?.items) ? body!.items : null;
  if (!items) return badRequest("items_required");
  if (items.length > MAX_ITEMS_PER_REQUEST) return badRequest("too_many_items");

  const list = await env.DB.prepare(`SELECT kind, deleted_at FROM lists WHERE user_id = ?1 AND id = ?2`)
    .bind(session.userId, id)
    .first<{ kind: string; deleted_at: number | null }>();
  if (!list || list.deleted_at) return json({ error: "not_found" }, 404);
  // A smart list's content IS its filter. Items here would be orphaned rows
  // nothing ever reads, so a client sending them is a bug worth surfacing.
  if (list.kind === "SMART") return badRequest("smart_lists_have_no_items");

  const removing = req.method === "DELETE";
  const t = now();
  const statements: D1PreparedStatement[] = [];

  for (const raw of items) {
    const it = raw as Record<string, unknown>;
    const tmdbId = int(it.tmdbId);
    const type = str(it.type, 8)?.toUpperCase();
    if (tmdbId === null || (type !== "MOVIE" && type !== "SHOW")) continue;

    if (removing) {
      statements.push(
        env.DB.prepare(
          `DELETE FROM list_items WHERE user_id=?1 AND list_id=?2 AND tmdb_id=?3 AND type=?4`,
        ).bind(session.userId, id, tmdbId, type),
      );
    } else {
      statements.push(
        env.DB.prepare(
          `INSERT INTO list_items (user_id, list_id, tmdb_id, type, position,
             match_percentage, ai_note, added_at, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)
           ON CONFLICT(user_id, list_id, tmdb_id, type) DO UPDATE SET
             position=?5, match_percentage=?6, ai_note=?7, updated_at=?8`,
        ).bind(
          session.userId,
          id,
          tmdbId,
          type,
          int(it.position) ?? 0,
          int(it.matchPercentage),
          str(it.aiNote, MAX_AI_NOTE),
          int(it.addedAt) ?? t,
        ),
      );
    }
  }
  if (!statements.length) return badRequest("no_valid_items");

  statements.push(
    env.DB.prepare(`UPDATE lists SET updated_at = ?3 WHERE user_id = ?1 AND id = ?2`).bind(
      session.userId,
      id,
      t,
    ),
    bumpMeta(env, session.userId),
  );
  await env.DB.batch(statements);

  return json({ ok: true, changed: statements.length - 2 });
}

export function handleListsOptions(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
