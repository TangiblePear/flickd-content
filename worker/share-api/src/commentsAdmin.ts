// ── Comment moderation, admin side ──────────────────────────────────────────
// The queue behind the admin panel's Comments section, plus the four actions on
// it. Lives on the Worker rather than in the Pages function that renders it, for
// one reason: `n_public` moves with `hidden_at`, and that invariant already has
// exactly one implementation (`setHidden`). A Pages function reading D1 directly
// would be a second one, in a second repo, and a counter maintained in two places
// is a counter that drifts.
//
// The panel therefore proxies here with a shared key. Same shape the awards admin
// already uses to reach the flickto-ai worker.
//
// Authorization is a shared secret, NOT a user session: the admin is not a user
// of this system, and giving a `users.id` moderator powers would mean an account
// takeover is a moderation takeover.

import { setHidden, type CommentRow, type CommentsEnv } from "./comments";

export interface CommentsAdminEnv extends CommentsEnv {
  /** Shared with the Pages admin function. Unset ⇒ every admin route 503s. */
  ADMIN_KEY?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

/** How many reported comments one page of the queue carries. */
const QUEUE_LIMIT = 100;

/**
 * Constant-time-ish comparison, and **closed rather than open when unconfigured**
 * — the same choice the Pages middleware makes for ADMIN_PASSWORD. A dev worker
 * with no key must not be a worker where moderation is unauthenticated.
 */
export function adminAuthorized(req: Request, env: CommentsAdminEnv): boolean {
  if (!env.ADMIN_KEY) return false;
  const given = req.headers.get("X-Admin-Key") ?? "";
  if (given.length !== env.ADMIN_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.ADMIN_KEY.charCodeAt(i);
  return diff === 0;
}

interface QueueRow {
  target_id: string;
  kind: string;
  reporters: number;
  reasons: string;
  reported_body: string | null;
  last_at: number;
  id: string | null;
  body: string | null;
  author_id: string | null;
  tmdb_id: number | null;
  media_type: string | null;
  season: number | null;
  episode: number | null;
  spoiler: number | null;
  hidden_at: number | null;
  deleted_at: number | null;
  display_name: string | null;
}

/**
 * `GET /api/admin/comment-reports` — open comment reports, most-reported first.
 *
 * Grouped by target **and kind**, because the two kinds are two independent
 * decisions with two different actions: abuse hides, spoiler blurs. Collapsing
 * them into one row would make the panel offer the wrong button.
 *
 * Both texts travel: `body_snapshot` is what was reported and `body` is what the
 * comment says now. When they diverge that is itself a signal — editing straight
 * after a report is usually damage control — so the view renders both.
 */
export async function handleAdminCommentReports(req: Request, env: CommentsAdminEnv): Promise<Response> {
  if (!adminAuthorized(req, env)) return json({ error: "forbidden" }, 403);

  const { results } = await env.DB.prepare(
    `SELECT r.target_id, r.kind,
            COUNT(DISTINCT r.reporter_id) AS reporters,
            GROUP_CONCAT(DISTINCT r.context) AS reasons,
            -- The text the EARLIEST open report was filed against — the one the
            -- threshold tripped on. No aggregate expresses "earliest", hence the
            -- correlated subquery rather than a GROUP_CONCAT whose order is not
            -- guaranteed and whose separator has to be an invisible control byte.
            (SELECT body_snapshot FROM reports r2
              WHERE r2.target_id = r.target_id AND r2.kind = r.kind AND r2.state = 'open'
              ORDER BY r2.created_at ASC LIMIT 1) AS reported_body,
            MAX(r.created_at) AS last_at,
            c.id, c.body, c.author_id, c.tmdb_id, c.media_type, c.season, c.episode,
            c.spoiler, c.hidden_at, c.deleted_at,
            p.display_name
       FROM reports r
       LEFT JOIN comments c ON c.id = r.target_id
       LEFT JOIN profiles p ON p.user_id = c.author_id
      WHERE r.state = 'open' AND r.kind IN ('comment', 'comment_spoiler')
      GROUP BY r.target_id, r.kind
      ORDER BY reporters DESC, last_at DESC
      LIMIT ?`,
  )
    .bind(QUEUE_LIMIT)
    .all<QueueRow>();

  const reports = (results ?? []).map((r) => ({
    commentId: r.target_id,
    kind: r.kind,
    reporterCount: r.reporters,
    reasons: (r.reasons ?? "").split(",").filter(Boolean),
    reportedBody: r.reported_body ?? "",
    currentBody: r.body ?? "",
    authorId: r.author_id ?? "",
    authorName: r.display_name ?? "",
    tmdbId: r.tmdb_id ?? 0,
    mediaType: r.media_type ?? "",
    season: r.season ?? -1,
    episode: r.episode ?? -1,
    spoiler: r.spoiler === 1,
    hidden: r.hidden_at != null,
    // A comment the author deleted after being reported. The row survives so the
    // record does; the panel shows it so a dismissal is an informed one.
    deleted: r.deleted_at != null,
    lastAt: r.last_at,
  }));
  return json({ reports });
}

/**
 * `POST /api/admin/comments/{id}/{action}` — hide, restore, dismiss or unblur.
 *
 * ⚠️ **Restore also dismisses the reports that hid it.** Leaving them `open`
 * means the next single report re-trips `REPORT_AUTOHIDE` and one person
 * overturns the moderator. A restored comment needs three *new* reports — still
 * re-hideable if it really is a problem.
 *
 * The same rule applies to `unblur` and the spoiler threshold, for the same
 * reason at a lower threshold.
 */
export async function handleAdminCommentAction(
  id: string,
  action: string,
  req: Request,
  env: CommentsAdminEnv,
): Promise<Response> {
  if (!adminAuthorized(req, env)) return json({ error: "forbidden" }, 403);

  const row = await env.DB.prepare(
    `SELECT id, tmdb_id, media_type, season, episode, author_id, body, visibility,
            spoiler, hidden_at, deleted_at, media_id
       FROM comments WHERE id = ?`,
  )
    .bind(id)
    .first<CommentRow>();
  if (!row) return json({ error: "not_found" }, 404);

  const dismiss = (kind: string) =>
    env.DB
      .prepare("UPDATE reports SET state = 'dismissed' WHERE target_id = ? AND kind = ? AND state = 'open'")
      .bind(id, kind);

  switch (action) {
    case "hide":
      if (row.hidden_at == null) await setHidden(env, row, true);
      return json({ ok: true });

    case "restore":
      if (row.hidden_at != null) await setHidden(env, row, false);
      await dismiss("comment").run();
      return json({ ok: true });

    case "unblur":
      await env.DB.batch([
        env.DB.prepare("UPDATE comments SET spoiler = 0 WHERE id = ?").bind(id),
        dismiss("comment_spoiler"),
      ]);
      return json({ ok: true });

    // Judged unfounded, with no change to the comment. Deliberately clears BOTH
    // kinds: an admin dismissing a queue entry means "this is fine", and leaving
    // the other kind open would put it straight back in the queue.
    case "dismiss":
      await env.DB.batch([dismiss("comment"), dismiss("comment_spoiler")]);
      return json({ ok: true });

    default:
      return json({ error: "unknown_action" }, 400);
  }
}
