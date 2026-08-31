// ── Unified moderation queue ─────────────────────────────────────────────────
// One queue over every report kind and both storage backends.
//
// **The merge happens here, in the Worker, not in the Pages function that renders
// it.** This is the only place holding both bindings, and it is the same reasoning
// commentsAdmin.ts already records for the comment half: an invariant implemented in
// a second repo is an invariant that drifts.
//
// Two backends, because they are two different kinds of thing:
//
//   D1 `reports`   comment | comment_spoiler | user | profile | feed_comment | picture
//                  | public_list
//                  Session-authenticated, has a `state` column. Keyed on users.id —
//                  except `public_list`, whose target is the PAIR "{ownerId}:{listId}"
//                  because `lists` is keyed on the pair. See PUBLIC_LIST_KIND.
//   R2 `_reports/` shared_list
//                  A share link is reportable by someone with NO ACCOUNT — the people
//                  most likely to see an abusive link were sent it in a group chat.
//                  There is no session to file it under and no users.id to key it on,
//                  so it keeps its own store. Resolution there is deletion; there is
//                  no state column and therefore no resolved history.
//
// `reporterCount` means DISTINCT HUMANS on both sides. D1 counts DISTINCT reporter_id;
// R2 dedupes on the reporter segment of `{at}-{reporter}.json`. If the two disagreed,
// the number the admin reads would differ from the number the auto-hide threshold acts
// on, and the panel would stop being trustworthy.
//
// Authorization is the shared ADMIN_KEY, never a user session: the admin is not a user
// of this system, and giving a users.id moderator powers would make an account takeover
// a moderation takeover.

import { adminAuthorized } from "./commentsAdmin";
import { setHidden, type CommentRow, type CommentsEnv } from "./comments";
import { setPublicListHidden, type PublicListsEnv } from "./publicLists";
import { suspensionUntil } from "./suspension";

export interface ModerationEnv {
  DB: D1Database;
  /** Share reports, picture tombstones, share objects. Optional: D1-only without it. */
  BUCKET?: R2Bucket;
  ADMIN_KEY?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

/** One page of the queue. Deliberately generous: the UI filters and counts client-side. */
const QUEUE_LIMIT = 200;

export interface ReportItem {
  /** `{targetId}:{kind}` for D1, the share code for R2. Round-trips to /act. */
  id: string;
  source: "d1" | "r2";
  kind: string;
  target: {
    // ⚠️ `archive_comment` belongs here: Phase 3 started emitting it below while this
    // union still said "share", so the panel's own contract disagreed with what it
    // sends. `tsc` is permanently red in this worker, which is exactly how a type
    // error survives a deploy — the runtime never checks, so the wrong `type` reached
    // the admin UI and only its own switch saved it.
    type: "user" | "comment" | "archive_comment" | "share" | "public_list";
    id: string;
    displayName: string;
    pictureUrl: string;
    /** Comment author's `users.id` — the suspend target when the item is a comment. */
    authorId: string;
    /** Where a comment lives, in a form an admin can look up. */
    subject: string;
    /** The text as it read when the earliest open report was filed. */
    bodySnapshot: string;
    /** What it says now. Divergence is itself a signal. */
    currentBody: string;
    shareUrl: string;
  };
  reporterCount: number;
  reasons: string[];
  firstAt: number;
  lastAt: number;
  state: "open" | "actioned" | "dismissed";
  /** Picture taken down, share hidden, comment hidden, or public list hidden. */
  tombstoned: boolean;
  /** Comment blurred as a spoiler. */
  blurred: boolean;
  /** Comment deleted by its author after being reported. */
  deleted: boolean;
  /** Epoch ms the target's posting suspension ends; 0 = not suspended. */
  suspendedUntil: number;
}

interface QueueRow {
  target_id: string;
  kind: string;
  reporters: number;
  reasons: string | null;
  first_at: number;
  last_at: number;
  state: string;
  reported_body: string | null;
  comment_id: string | null;
  body: string | null;
  author_id: string | null;
  tmdb_id: number | null;
  media_type: string | null;
  season: number | null;
  episode: number | null;
  spoiler: number | null;
  hidden_at: number | null;
  deleted_at: number | null;
  author_name: string | null;
  author_suspended_until: number | null;
  target_name: string | null;
  target_picture: string | null;
  posting_suspended_until: number | null;
  list_name: string | null;
  list_hidden_at: number | null;
}

export const COMMENT_KINDS = new Set(["comment", "comment_spoiler"]);

/**
 * Reports against commsuni.tv archive comments — content we did NOT write.
 *
 * ⚠️ `target_id` is a UUID, so the queue's `LEFT JOIN comments c ON c.id = r.target_id`
 * matches nothing for these. Everything the moderator sees therefore comes from the
 * report-time SNAPSHOT (`body_snapshot`, and the origin slug appended to `context`),
 * not from a join — which is also the point: the snapshot is the text the reporter
 * actually saw, and an author editing upstream cannot change it after the fact.
 *
 * ⚠️ There is no `suspend` action for a foreign author. We cannot suspend someone
 * else's user, and conflating "this comment is bad" with "this person is ours to
 * punish" is the same category error `public_list` already avoids — a list is not a
 * person, and neither is a partner's account.
 */
export const ARCHIVE_COMMENT_KINDS = new Set(["archive_comment", "archive_comment_spoiler"]);

/** Is this report about content from the shared archive? */
export const isArchiveKind = (kind: string): boolean => ARCHIVE_COMMENT_KINDS.has(kind);

/**
 * A public list's `reports.target_id` is `"{ownerId}:{listId}"` — TWO ids rather than
 * one, because `lists` is keyed on the pair. Migration 0026 did that so the built-in
 * watchlist's shared client id ("watchlist" on every account) cannot collide across
 * accounts, and the report has to carry both halves to name a row.
 */
export const PUBLIC_LIST_KIND = "public_list";

/** Splits `"{ownerId}:{listId}"`. FIRST colon: a users.id has none, a list id may. */
function splitListTarget(targetId: string): [string, string] | null {
  const cut = targetId.indexOf(":");
  if (cut <= 0 || cut === targetId.length - 1) return null;
  return [targetId.slice(0, cut), targetId.slice(cut + 1)];
}

/** Where a comment is attached, in the shape an admin can actually look up. */
function subjectOf(r: QueueRow): string {
  if (r.tmdb_id == null) return "";
  const kind = r.media_type === "show" ? "Show" : "Movie";
  const at = (r.season ?? -1) >= 0 ? ` · S${r.season}E${r.episode}` : "";
  return `${kind} ${r.tmdb_id}${at}`;
}

/**
 * `GET /api/moderation/reports?state=open|resolved`
 *
 * Returns the whole page rather than accepting `kind` and `sort` parameters. The filter
 * rail shows a live count per family, which needs the full set anyway, so filtering
 * server-side would cost one request per click and still not produce the counts.
 */
export async function handleModerationQueue(req: Request, env: ModerationEnv): Promise<Response> {
  if (!adminAuthorized(req, env as any)) return json({ error: "forbidden" }, 403);

  const resolved = new URL(req.url).searchParams.get("state") === "resolved";
  const items = await loadD1(env, resolved);

  // R2 only in the open view. There is no `state` on a share report — dismissing one
  // deletes it — so a resolved query has no share history to show, and including the
  // open ones there would present them as decided.
  if (!resolved) items.push(...(await loadR2(env)));

  items.sort((a, b) => b.reporterCount - a.reporterCount || b.lastAt - a.lastAt);
  return json({ items });
}

async function loadD1(env: ModerationEnv, resolved: boolean): Promise<ReportItem[]> {
  // Interpolated, not bound, because the subquery needs the same predicate and D1 has
  // no way to bind a fragment. Safe: this is a two-value allow-list derived from a
  // boolean, never from caller text.
  const where = resolved ? "r.state IN ('actioned','dismissed')" : "r.state = 'open'";

  const { results } = await env.DB.prepare(
    `SELECT r.target_id, r.kind,
            COUNT(DISTINCT r.reporter_id) AS reporters,
            GROUP_CONCAT(DISTINCT r.context) AS reasons,
            MIN(r.created_at) AS first_at,
            MAX(r.created_at) AS last_at,
            MIN(r.state) AS state,
            -- The text the EARLIEST report was filed against — the one the threshold
            -- tripped on. No aggregate expresses "earliest", hence the correlated
            -- subquery rather than a GROUP_CONCAT whose order is not guaranteed.
            (SELECT body_snapshot FROM reports r2
              WHERE r2.target_id = r.target_id AND r2.kind = r.kind AND ${where.replace(/\br\./g, "r2.")}
              ORDER BY r2.created_at ASC LIMIT 1) AS reported_body,
            c.id AS comment_id, c.body, c.author_id, c.tmdb_id, c.media_type,
            c.season, c.episode, c.spoiler, c.hidden_at, c.deleted_at,
            cp.display_name AS author_name,
            cu.posting_suspended_until AS author_suspended_until,
            p.display_name AS target_name, p.picture_url AS target_picture,
            u.posting_suspended_until,
            l.name AS list_name, pl.hidden_at AS list_hidden_at
       FROM reports r
       LEFT JOIN comments c  ON c.id = r.target_id
       LEFT JOIN profiles cp ON cp.user_id = c.author_id
       LEFT JOIN users    cu ON cu.id = c.author_id
       LEFT JOIN profiles p  ON p.user_id = r.target_id
       LEFT JOIN users    u  ON u.id = r.target_id
       -- A public list's target is two ids joined by ':' (see PUBLIC_LIST_KIND), so the
       -- name comes from the lists table on the split PAIR rather than from a
       -- single-column join. Gated on the kind: a comment id is ALSO
       -- "{userId}:{something}", and without the guard one could match a lists row and
       -- borrow its name.
       --
       -- Defence in depth, not reachable through this API today: the TS mapping below
       -- only reads list_name when isList (r.kind === PUBLIC_LIST_KIND), so a
       -- comment-kind row picks its displayName from author_name regardless of what
       -- this join produces. Verified by sabotage: removing the r.kind = ... guard
       -- here left every test in this file green. Kept anyway: it is one clause, and it
       -- stops the join itself from silently attaching a stranger's list name onto a
       -- comment row if the TS mapping ever changes to read it.
       --
       -- The name comes from lists, not public_lists, because unpublishing DELETES the
       -- public_lists row while the report stays open — a queue entry that lost its
       -- name the moment the author withdrew the list would be unreadable.
       LEFT JOIN lists l ON r.kind = '${PUBLIC_LIST_KIND}'
                        AND l.user_id = substr(r.target_id, 1, instr(r.target_id, ':') - 1)
                        AND l.id      = substr(r.target_id, instr(r.target_id, ':') + 1)
       LEFT JOIN public_lists pl ON pl.owner_id = l.user_id AND pl.list_id = l.id
      WHERE ${where}
      GROUP BY r.target_id, r.kind
      ORDER BY reporters DESC, last_at DESC
      LIMIT ?`,
  )
    .bind(QUEUE_LIMIT)
    .all<QueueRow>();

  const rows = results ?? [];
  const now = Date.now();
  const out: ReportItem[] = [];

  for (const r of rows) {
    const isComment = COMMENT_KINDS.has(r.kind);
    const isArchive = isArchiveKind(r.kind);
    const isList = r.kind === PUBLIC_LIST_KIND;
    // A comment's suspend target is its AUTHOR; every other kind targets the person
    // directly. Reading the wrong column here would show "not suspended" on a
    // suspended author and invite a moderator to suspend them twice.
    const rawUntil = (isComment ? r.author_suspended_until : r.posting_suspended_until) ?? 0;
    out.push({
      id: `${r.target_id}:${r.kind}`,
      source: "d1",
      kind: r.kind,
      target: {
        // ⚠️ Its OWN type, not "comment". The panel must not offer a moderator
        // actions we cannot perform on content we do not own — there is no author to
        // suspend and no row of ours to edit.
        type: isArchive ? "archive_comment" : isComment ? "comment" : isList ? "public_list" : "user",
        id: r.target_id,
        displayName: (isComment ? r.author_name : isList ? r.list_name : r.target_name) ?? "",
        pictureUrl: r.target_picture ?? "",
        authorId: r.author_id ?? "",
        subject: isComment ? subjectOf(r) : "",
        bodySnapshot: r.reported_body ?? "",
        currentBody: r.body ?? "",
        shareUrl: "",
      },
      reporterCount: r.reporters,
      reasons: (r.reasons ?? "").split(",").filter(Boolean),
      firstAt: r.first_at,
      lastAt: r.last_at,
      state: (r.state as ReportItem["state"]) ?? "open",
      // A hidden public list MUST read as tombstoned: the panel offers "Restore" only
      // on a tombstoned item, so getting this wrong leaves an auto-hidden list with no
      // way back — which is the thing that turns a report threshold into a brigading tool.
      tombstoned: isComment
        ? r.hidden_at != null
        : isList
          ? r.list_hidden_at != null
          : await pictureTombstoned(env, r),
      blurred: r.spoiler === 1,
      deleted: r.deleted_at != null,
      suspendedUntil: rawUntil > now ? rawUntil : 0,
    });
  }
  return out;
}

/**
 * A picture takedown is an R2 object, not a D1 column. Only the account-keyed key is
 * checked now: the legacy friendId twin went with `users.friend_id` (8c-3), and there
 * is no longer any way to resolve which legacy key an account would have used.
 */
async function pictureTombstoned(env: ModerationEnv, r: QueueRow): Promise<boolean> {
  if (r.kind !== "picture" || !env.BUCKET) return false;
  if ((await env.BUCKET.head(`_moderation/u/${r.target_id}.json`)) !== null) return true;
  return false;
}

interface ShareRecord {
  kind?: string;
  targetFriendId?: string;
  reporterId?: string;
  reason?: string;
  context?: string;
  at?: number;
}

/** Marker reporter id for a report filed with no session. Never counted — see index.ts. */
const ANON_REPORTER = "anon";

async function loadR2(env: ModerationEnv): Promise<ReportItem[]> {
  const bucket = env.BUCKET;
  if (!bucket) return [];

  const listed = await bucket.list({ prefix: "_reports/", limit: 1000 });
  const groups = new Map<
    string,
    { kind: string; reporters: Set<string>; reasons: Set<string>; firstAt: number; lastAt: number }
  >();

  for (const obj of listed.objects) {
    const body = await bucket.get(obj.key);
    if (!body) continue;
    let rec: ShareRecord;
    try {
      rec = (await body.json()) as ShareRecord;
    } catch {
      continue; // A corrupt record must not take the whole queue down.
    }
    const code = rec.targetFriendId ?? obj.key.split("/")[1] ?? "";
    if (!code) continue;
    const g = groups.get(code) ?? {
      kind: rec.kind ?? "shared_list",
      reporters: new Set<string>(),
      reasons: new Set<string>(),
      firstAt: Infinity,
      lastAt: 0,
    };
    // Anonymous reports are advisory: they summon a human but never move a counter,
    // which is what stops an open endpoint becoming a takedown weapon.
    if (rec.reporterId && rec.reporterId !== ANON_REPORTER) g.reporters.add(rec.reporterId);
    for (const s of [rec.reason, rec.context]) if (s) g.reasons.add(s);
    if (rec.at) {
      g.firstAt = Math.min(g.firstAt, rec.at);
      g.lastAt = Math.max(g.lastAt, rec.at);
    }
    groups.set(code, g);
  }

  const out: ReportItem[] = [];
  for (const [code, g] of groups) {
    const share = await bucket.get(`share/${code}.json`);
    const hidden = share ? ((await share.json()) as { hidden?: boolean }).hidden === true : false;
    out.push({
      id: code,
      source: "r2",
      kind: g.kind,
      target: {
        type: "share",
        id: code,
        displayName: "",
        pictureUrl: "",
        authorId: "",
        subject: "",
        bodySnapshot: "",
        currentBody: "",
        shareUrl: `https://flickto.app/share/${code}`,
      },
      reporterCount: g.reporters.size,
      reasons: [...g.reasons],
      firstAt: Number.isFinite(g.firstAt) ? g.firstAt : 0,
      lastAt: g.lastAt,
      state: "open",
      tombstoned: hidden,
      blurred: false,
      deleted: false,
      suspendedUntil: 0,
    });
  }
  return out;
}

// ── Actions ──────────────────────────────────────────────────────────────────
// ONE endpoint rather than one per target type. The queue is heterogeneous, so the
// alternative is the client choosing between four URLs — routing knowledge in the
// browser, and a second place to keep the target-type mapping correct.
//
// ⚠️ **Every reversing action also dismisses the reports that caused it.** Leaving
// them `open` means the next single report re-trips the threshold and one person
// overturns the moderator. Established by commentsAdmin.ts; it holds identically for
// pictures, shares and suspensions.

type Action = "hide" | "restore" | "unblur" | "suspend" | "unsuspend" | "dismiss";

const ALLOWED: Record<"comment" | "user" | "share" | "public_list", Set<Action>> = {
  comment: new Set<Action>(["hide", "restore", "unblur", "dismiss"]),
  user: new Set<Action>(["hide", "restore", "suspend", "unsuspend", "dismiss"]),
  share: new Set<Action>(["hide", "restore", "dismiss"]),
  // No suspend: a list is not a person. The moderator suspends its author from the
  // author's own item, which is the same separation comments already have.
  public_list: new Set<Action>(["hide", "restore", "dismiss"]),
};

/** `POST /api/moderation/act` — `{ itemId, source, action, durationMs? }`. */
export async function handleModerationAct(req: Request, env: ModerationEnv): Promise<Response> {
  if (!adminAuthorized(req, env as any)) return json({ error: "forbidden" }, 403);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  const source = body.source === "r2" ? "r2" : "d1";
  const action = String(body.action ?? "") as Action;
  if (!itemId) return json({ error: "bad_request" }, 400);

  if (source === "r2") {
    if (!ALLOWED.share.has(action)) return json({ error: "unsupported_action" }, 400);
    return actOnShare(itemId, action, env);
  }

  // `{targetId}:{kind}`, split on the LAST colon: a comment id is itself
  // `{userId}:{subject}` and contains colons, while no kind ever does.
  const cut = itemId.lastIndexOf(":");
  if (cut <= 0) return json({ error: "bad_request" }, 400);
  const targetId = itemId.slice(0, cut);
  const kind = itemId.slice(cut + 1);

  if (COMMENT_KINDS.has(kind)) return actOnComment(targetId, action, env);
  if (isArchiveKind(kind)) return actOnArchiveComment(targetId, action, kind, env);
  if (kind === PUBLIC_LIST_KIND) return actOnPublicList(targetId, action, env);
  return actOnUser(targetId, action, body.durationMs, env);
}

/**
 * Moderate a comment from the shared archive.
 *
 * ⚠️ **We cannot change anything upstream.** The comment stays live in every other
 * partner app; all we control is whether it appears in ours. §10 permits exactly that
 * ("for that user, or for every viewer in your product"), and being honest about the
 * limit matters — a moderator who believes `hide` removed the comment from the archive
 * would stop escalating to the operator when they should not.
 *
 * There is deliberately no `suspend`: suspending a foreign author is not ours to do,
 * the same separation `public_list` already keeps.
 */
async function actOnArchiveComment(
  archiveId: string,
  action: string,
  kind: string,
  env: ModerationEnv,
): Promise<Response> {
  if (action === "hide") {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO archive_suppressed (archive_id, hidden_at, reason) VALUES (?,?,?)",
    )
      .bind(archiveId, Date.now(), "admin")
      .run();
    return new Response(null, { status: 204 });
  }

  if (action === "restore") {
    /**
     * ⚠️ Restoring must ALSO dismiss the reports that caused the hide.
     *
     * Auto-hide counts distinct OPEN reporters, so leaving them open means the very
     * next report re-trips the threshold and one person overturns the moderator. The
     * native `restore` has the same rule for the same reason.
     */
    await env.DB.batch([
      env.DB.prepare("DELETE FROM archive_suppressed WHERE archive_id = ?").bind(archiveId),
      env.DB.prepare(
        "UPDATE reports SET state = 'dismissed' WHERE target_id = ? AND kind = ? AND state = 'open'",
      ).bind(archiveId, kind),
    ]);
    return new Response(null, { status: 204 });
  }

  if (action === "dismiss") {
    // Both kinds: the two thresholds are independent, but dismissing the queue item
    // means the moderator judged the CONTENT fine, which settles both.
    await env.DB.batch(
      [...ARCHIVE_COMMENT_KINDS].map((k) =>
        env.DB.prepare(
          "UPDATE reports SET state = 'dismissed' WHERE target_id = ? AND kind = ? AND state = 'open'",
        ).bind(archiveId, k),
      ),
    );
    return new Response(null, { status: 204 });
  }

  // `delete_upstream` belongs to Phase 2: it resolves archive_comment_refs to find
  // which of OUR comments this is and deletes it with that author's actor ID. Until
  // the mirror exists there is nothing of ours up there to delete, so the action is
  // refused rather than silently doing nothing.
  return new Response(JSON.stringify({ error: "unsupported_action" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

const dismissKind = (env: ModerationEnv, targetId: string, kind: string) =>
  env.DB.prepare("UPDATE reports SET state = 'dismissed' WHERE target_id = ? AND kind = ? AND state = 'open'")
    .bind(targetId, kind);

async function actOnComment(id: string, action: Action, env: ModerationEnv): Promise<Response> {
  if (!ALLOWED.comment.has(action)) return json({ error: "unsupported_action" }, 400);

  const row = await env.DB.prepare(
    `SELECT id, tmdb_id, media_type, season, episode, author_id, body, visibility,
            spoiler, hidden_at, deleted_at, media_id
       FROM comments WHERE id = ?`,
  )
    .bind(id)
    .first<CommentRow>();
  if (!row) return json({ error: "not_found" }, 404);

  switch (action) {
    case "hide":
      // Hiding goes through `setHidden` rather than a raw UPDATE here so the auto-hide
      // threshold and this admin action share one implementation.
      if (row.hidden_at == null) await setHidden(env as unknown as CommentsEnv, row, true);
      return json({ ok: true });

    case "restore":
      if (row.hidden_at != null) await setHidden(env as unknown as CommentsEnv, row, false);
      await dismissKind(env, id, "comment").run();
      return json({ ok: true });

    case "unblur":
      await env.DB.batch([
        env.DB.prepare("UPDATE comments SET spoiler = 0 WHERE id = ?").bind(id),
        dismissKind(env, id, "comment_spoiler"),
      ]);
      return json({ ok: true });

    // "This is fine" clears BOTH kinds — leaving the other open would put the item
    // straight back in the queue the moderator just cleared.
    default:
      await env.DB.batch([dismissKind(env, id, "comment"), dismissKind(env, id, "comment_spoiler")]);
      return json({ ok: true });
  }
}

/**
 * Hide, restore or dismiss a reported public list.
 *
 * Before this existed, `public_list` matched neither COMMENT_KINDS nor PERSON_KINDS and
 * fell through to `actOnUser("{ownerId}:{listId}")`, whose `SELECT id FROM users`
 * matched nothing and answered 404 — so a list auto-hidden by the report threshold
 * could never be un-hidden and its reports could never be cleared. A threshold with no
 * restore path is a brigading tool, which is exactly what comments.ts's REPORT_AUTOHIDE
 * note says must not happen.
 *
 * ⚠️ Nothing here is observable to a follower. `/api/me/follows` reports a hidden list
 * and an author-unpublished one identically as `unpublished`, and that must stay true:
 * a follower who could tell the two apart could tell that a list had been actioned.
 */
async function actOnPublicList(targetId: string, action: Action, env: ModerationEnv): Promise<Response> {
  if (!ALLOWED.public_list.has(action)) return json({ error: "unsupported_action" }, 400);

  const pair = splitListTarget(targetId);
  if (!pair) return json({ error: "bad_request" }, 400);
  const [ownerId, listId] = pair;

  // Dismiss deliberately does NOT require the `public_lists` row, unlike hide and
  // restore. Unpublishing deletes that row while the reports stay open, so requiring it
  // here would strand the report in the queue with no way to clear it — the same dead
  // end this function exists to remove.
  if (action === "dismiss") {
    await dismissKind(env, targetId, PUBLIC_LIST_KIND).run();
    return json({ ok: true });
  }

  const row = await env.DB.prepare(
    "SELECT hidden_at FROM public_lists WHERE owner_id = ?1 AND list_id = ?2",
  )
    .bind(ownerId, listId)
    .first<{ hidden_at: number | null }>();
  if (!row) return json({ error: "not_found" }, 404);

  // Both directions go through `setPublicListHidden` rather than a raw UPDATE, so the
  // admin takedown and the automatic threshold in handleReportPublicList write the same
  // thing — the rule this file already records for comments at the `setHidden` call.
  const hiding = action === "hide";
  const stmt = setPublicListHidden(env as PublicListsEnv, ownerId, listId, hiding ? Date.now() : null);
  if (hiding) {
    await stmt.run();
    return json({ ok: true });
  }
  // Restoring dismisses the reports that caused the takedown, for the reason every
  // reversing action here does: leaving them open lets the next single report re-trip
  // the threshold and one person overturn the moderator.
  await env.DB.batch([stmt, dismissKind(env, targetId, PUBLIC_LIST_KIND)]);
  return json({ ok: true });
}

const PERSON_KINDS = ["user", "profile", "feed_comment", "picture"];

async function actOnUser(
  userId: string,
  action: Action,
  durationMs: unknown,
  env: ModerationEnv,
): Promise<Response> {
  if (!ALLOWED.user.has(action)) return json({ error: "unsupported_action" }, 400);

  const owner = await env.DB.prepare("SELECT id FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string }>();
  if (!owner) return json({ error: "not_found" }, 404);

  const dismissAll = () =>
    env.DB
      .prepare(
        `UPDATE reports SET state = 'dismissed'
          WHERE target_id = ? AND state = 'open' AND kind IN (${PERSON_KINDS.map(() => "?").join(",")})`,
      )
      .bind(userId, ...PERSON_KINDS);
  // BOTH spellings of the tombstone. A picture is reachable by two routes — the
  // account-keyed one and the legacy friendId one — and each checks only its own key,
  // so a hide that wrote one would leave the other route still serving the image.
  // The legacy entry drops out when the legacy route does.
  const tombstones = [`_moderation/u/${userId}.json`];

  switch (action) {
    // Writes the SAME objects the automatic threshold writes, so a manual takedown and
    // an automatic one can never disagree about whether a picture is down.
    case "hide": {
      if (!env.BUCKET) return json({ error: "no_picture_target" }, 409);
      const body = JSON.stringify({ reason: "admin_takedown", at: Date.now() });
      for (const key of tombstones) {
        await env.BUCKET.put(key, body, { httpMetadata: { contentType: "application/json" } });
      }
      return json({ ok: true });
    }

    case "restore":
      if (!env.BUCKET) return json({ error: "no_picture_target" }, 409);
      for (const key of tombstones) await env.BUCKET.delete(key);
      await dismissKind(env, userId, "picture").run();
      return json({ ok: true });

    case "suspend": {
      const until = suspensionUntil(Number(durationMs));
      if (until == null) return json({ error: "invalid_duration" }, 400);
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET posting_suspended_until = ? WHERE id = ?").bind(until, userId),
        // Marked `dismissed`, not left open: a suspension is a decision on the person,
        // and leaving the reports open would re-present a case already judged.
        dismissAll(),
      ]);
      return json({ ok: true, until });
    }

    case "unsuspend":
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET posting_suspended_until = NULL WHERE id = ?").bind(userId),
        dismissAll(),
      ]);
      return json({ ok: true });

    default:
      await dismissAll().run();
      return json({ ok: true });
  }
}

async function actOnShare(code: string, action: Action, env: ModerationEnv): Promise<Response> {
  const bucket = env.BUCKET;
  if (!bucket) return json({ error: "no_bucket" }, 409);

  // A share link's takedown state is a `hidden` flag on the object itself, not a
  // `_moderation/` tombstone: the read paths check the flag and then answer exactly
  // what an expired link answers, so a hidden link is indistinguishable from a stale one.
  if (action === "hide" || action === "restore") {
    const share = await bucket.get(`share/${code}.json`);
    if (!share) return json({ error: "not_found" }, 404);
    const stored = (await share.json()) as Record<string, unknown>;
    await bucket.put(`share/${code}.json`, JSON.stringify({ ...stored, hidden: action === "hide" }), {
      httpMetadata: { contentType: "application/json" },
    });
    // Restoring clears the reports for the same reason it does everywhere else.
    if (action === "restore") await deleteShareReports(bucket, code);
    return json({ ok: true });
  }

  await deleteShareReports(bucket, code);
  return json({ ok: true });
}

/** R2 has no `state` column, so "resolved" is "deleted" for a share report. */
async function deleteShareReports(bucket: R2Bucket, code: string): Promise<void> {
  const listed = await bucket.list({ prefix: `_reports/${code}/`, limit: 1000 });
  await Promise.all(listed.objects.map((o) => bucket.delete(o.key)));
}
