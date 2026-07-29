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
//                  Session-authenticated, keyed on users.id, has a `state` column.
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
    type: "user" | "comment" | "share";
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
    /** Device friendId — what a picture tombstone is still keyed on. */
    friendId: string;
  };
  reporterCount: number;
  reasons: string[];
  firstAt: number;
  lastAt: number;
  state: "open" | "actioned" | "dismissed";
  /** Picture taken down, share hidden, or comment hidden. */
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
  friend_id: string | null;
  posting_suspended_until: number | null;
}

export const COMMENT_KINDS = new Set(["comment", "comment_spoiler"]);

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
            u.friend_id, u.posting_suspended_until
       FROM reports r
       LEFT JOIN comments c  ON c.id = r.target_id
       LEFT JOIN profiles cp ON cp.user_id = c.author_id
       LEFT JOIN users    cu ON cu.id = c.author_id
       LEFT JOIN profiles p  ON p.user_id = r.target_id
       LEFT JOIN users    u  ON u.id = r.target_id
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
    // A comment's suspend target is its AUTHOR; every other kind targets the person
    // directly. Reading the wrong column here would show "not suspended" on a
    // suspended author and invite a moderator to suspend them twice.
    const rawUntil = (isComment ? r.author_suspended_until : r.posting_suspended_until) ?? 0;
    out.push({
      id: `${r.target_id}:${r.kind}`,
      source: "d1",
      kind: r.kind,
      target: {
        type: isComment ? "comment" : "user",
        id: r.target_id,
        displayName: (isComment ? r.author_name : r.target_name) ?? "",
        pictureUrl: r.target_picture ?? "",
        authorId: r.author_id ?? "",
        subject: isComment ? subjectOf(r) : "",
        bodySnapshot: r.reported_body ?? "",
        currentBody: r.body ?? "",
        shareUrl: "",
        friendId: r.friend_id ?? "",
      },
      reporterCount: r.reporters,
      reasons: (r.reasons ?? "").split(",").filter(Boolean),
      firstAt: r.first_at,
      lastAt: r.last_at,
      state: (r.state as ReportItem["state"]) ?? "open",
      tombstoned: isComment ? r.hidden_at != null : await pictureTombstoned(env, r),
      blurred: r.spoiler === 1,
      deleted: r.deleted_at != null,
      suspendedUntil: rawUntil > now ? rawUntil : 0,
    });
  }
  return out;
}

/** A picture takedown is an R2 object keyed on the device friendId, not a D1 column. */
async function pictureTombstoned(env: ModerationEnv, r: QueueRow): Promise<boolean> {
  if (r.kind !== "picture" || !env.BUCKET || !r.friend_id) return false;
  return (await env.BUCKET.head(`_moderation/${r.friend_id}.json`)) !== null;
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
        friendId: "",
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

const ALLOWED: Record<"comment" | "user" | "share", Set<Action>> = {
  comment: new Set<Action>(["hide", "restore", "unblur", "dismiss"]),
  user: new Set<Action>(["hide", "restore", "suspend", "unsuspend", "dismiss"]),
  share: new Set<Action>(["hide", "restore", "dismiss"]),
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

  return COMMENT_KINDS.has(kind)
    ? actOnComment(targetId, action, env)
    : actOnUser(targetId, action, body.durationMs, env);
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
      // `setHidden` moves comment_counts.n_public in the same batch. That invariant has
      // exactly one implementation and this is not a second one.
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

const PERSON_KINDS = ["user", "profile", "feed_comment", "picture"];

async function actOnUser(
  userId: string,
  action: Action,
  durationMs: unknown,
  env: ModerationEnv,
): Promise<Response> {
  if (!ALLOWED.user.has(action)) return json({ error: "unsupported_action" }, 400);

  const owner = await env.DB.prepare("SELECT id, friend_id FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; friend_id: string | null }>();
  if (!owner) return json({ error: "not_found" }, 404);

  const dismissAll = () =>
    env.DB
      .prepare(
        `UPDATE reports SET state = 'dismissed'
          WHERE target_id = ? AND state = 'open' AND kind IN (${PERSON_KINDS.map(() => "?").join(",")})`,
      )
      .bind(userId, ...PERSON_KINDS);
  const tombstone = owner.friend_id ? `_moderation/${owner.friend_id}.json` : null;

  switch (action) {
    // Writes the SAME object the automatic threshold writes, so a manual takedown and
    // an automatic one can never disagree about whether a picture is down.
    case "hide":
      if (!tombstone || !env.BUCKET) return json({ error: "no_picture_target" }, 409);
      await env.BUCKET.put(tombstone, JSON.stringify({ reason: "admin_takedown", at: Date.now() }), {
        httpMetadata: { contentType: "application/json" },
      });
      return json({ ok: true });

    case "restore":
      if (!tombstone || !env.BUCKET) return json({ error: "no_picture_target" }, 409);
      await env.BUCKET.delete(tombstone);
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
