/**
 * The write mirror: our public comments, published into the shared archive.
 *
 * ⚠️ **This is the only code in the integration that makes our users' words leave our
 * systems.** Everything else reads, hides, or reports. A mistake here is not a bug that
 * shows the wrong thing on a screen — it publishes text to a third-party platform that
 * other apps read, and the only remedy is a delete that may already be too late.
 *
 * Three guards, in order, and each one is load-bearing:
 *
 *  1. {@link mirrorEnabled} — the whole feature is OFF unless explicitly switched on.
 *     The privacy policy has to say this happens before it may happen; the flag is how
 *     "the code is ready" and "the code is live" stay separate facts.
 *  2. {@link mayMirror} — `visibility === 'public'` and nothing else. A friends-only
 *     comment leaving is unrecoverable in the way that matters: it was written under a
 *     promise about who could read it.
 *  3. The drain runs AFTER moderation, never inline with the post, so an auto-hide, a
 *     suspension or a fast delete lands first.
 */

import { actorId, commsuniCall, commsuniEnabled, type CommsuniEnv } from "./commsuni";

export interface MirrorEnv extends CommsuniEnv {
  /**
   * The kill switch. **Absent means off.**
   *
   * ⚠️ Deliberately not a "disable" flag. A feature that publishes user content must
   * fail CLOSED: a typo'd or missing variable then mirrors nothing, rather than
   * silently starting to publish because a negation was misread. Only the exact
   * string "1" enables it.
   */
  COMMSUNI_MIRROR?: string;
}

/** Off unless explicitly on, and off entirely when upstream is unconfigured. */
export const mirrorEnabled = (env: MirrorEnv): boolean =>
  commsuniEnabled(env) && (env.COMMSUNI_MIRROR ?? "").trim() === "1";

/** How many outbox items one request may drain. See the table comment in 0047. */
export const DRAIN_LIMIT = 5;

/** After this many edits a comment stops being re-mirrored. */
const MAX_EDITS = 3;

export interface MirrorableComment {
  id: string;
  author_id: string;
  visibility?: string | null;
  /** ⚠️ `hidden_at`, not `hidden` — 0003 names it that, and a wrong name here reads as
   *  undefined, i.e. "not hidden", so a moderated row would have mirrored anyway. */
  hidden_at?: number | null;
  deleted_at?: number | null;
  body?: string | null;
  lang?: string | null;
  spoiler?: number | null;
}

/**
 * May this specific row be published?
 *
 * ⚠️ **Default deny.** Every branch returns false unless it positively establishes the
 * row is public, live and visible. `visibility` is compared to the exact string
 * `"public"` rather than tested for not being `"friends"`, so a new visibility value
 * added later is not-public by default instead of silently mirroring.
 */
export function mayMirror(c: MirrorableComment | null | undefined): boolean {
  if (!c) return false;
  if (c.visibility !== "public") return false;
  // Moderation state wins over the author's intent: a hidden or deleted row must not
  // be republished by a retry that was queued before it was actioned.
  if (c.hidden_at) return false;
  if (c.deleted_at) return false;
  if (!c.body || !c.body.trim()) return false;
  return true;
}

/**
 * One key per user ACTION.
 *
 * `{commentId}:{updatedAt}` — stable across retries of the same edit, different for the
 * next one. Reusing a key across different bodies would make the second edit replay the
 * first; minting a new key per attempt would double-charge `write_units`, which are
 * billed on the request and not the outcome.
 */
export const mirrorKey = (commentId: string, updatedAt: number): string => `${commentId}:${updatedAt}`;

interface OutboxRow {
  id: string;
  kind: string;
  idempotency_key: string;
  actor_user_id: string;
  payload: string;
  attempts: number;
}

/** Queue outbound work. The drain, not the caller, decides when it leaves. */
export async function enqueue(
  env: MirrorEnv,
  kind: "comment" | "reply" | "delete",
  userId: string,
  key: string,
  payload: unknown,
  delayMs = 0,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO archive_outbox (id, kind, idempotency_key, actor_user_id, payload, attempts, next_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(crypto.randomUUID(), kind, key, userId, JSON.stringify(payload), Date.now() + delayMs, Date.now())
    .run()
    .catch(() => {});
}

/**
 * Publish one comment, and record the ref that makes it deletable.
 *
 * ⚠️ The ref is written on `201` and the archive id comes from the response. If that
 * write were skipped the comment would be live upstream and unreachable for ever —
 * which is why a failure to record is treated as a failure of the whole operation and
 * left in the outbox to retry, even though the upstream write itself succeeded. A
 * duplicate retry is cheap and idempotent; an orphaned publication is permanent.
 */
async function publishComment(env: MirrorEnv, row: OutboxRow): Promise<boolean> {
  const p = JSON.parse(row.payload) as {
    commentId: string;
    refPath?: string;
    parentArchiveId?: string;
    body: string;
    lang?: string | null;
    spoiler?: boolean;
    attachments?: string[];
    entity?: { title?: string; showTitle?: string };
  };

  // Re-read the row at drain time. It may have been hidden, deleted or its author
  // suspended in the window between queueing and draining — which is the entire reason
  // the mirror runs here rather than inline with the post.
  const live = await env.DB
    .prepare("SELECT id, author_id, visibility, hidden_at, deleted_at, body, lang, spoiler FROM comments WHERE id = ?")
    .bind(p.commentId)
    .first<MirrorableComment>()
    .catch(() => null);
  if (!mayMirror(live)) return true; // Settled: drop it, do not retry.

  if (await authorSuspended(env, row.actor_user_id)) return true;

  const actor = await actorId(env, row.actor_user_id);
  if (!actor) return true; // No actor secret ⇒ nothing can be attributed. Not retryable.

  const path = row.kind === "reply"
    ? `/comments/${p.parentArchiveId}/replies`
    : `/entities/${p.refPath}/comments`;

  const res = await commsuniCall<{ comment?: { id?: string } }>(env, path, {
    method: "POST",
    actor,
    idempotencyKey: row.idempotency_key,
    body: {
      text: live!.body,
      language: p.lang ?? live!.lang ?? undefined,
      isSpoiler: !!(p.spoiler ?? live!.spoiler),
      // ⚠️ `attachments`. `media`, `gif` and `imageUrl` are all 400.
      ...(p.attachments?.length ? { attachments: p.attachments } : {}),
      ...(p.entity ? { entity: p.entity } : {}),
    },
  });

  if (!res.ok) return !retryable(res);

  const archiveId = res.data?.comment?.id;
  if (!archiveId) return false; // 201 with no id: retry rather than lose the handle.

  await env.DB
    .prepare(
      `INSERT INTO archive_comment_refs (comment_id, archive_id, author_id, edits, shared, mirrored_at)
       VALUES (?, ?, ?, 0, 1, ?)
       ON CONFLICT(comment_id) DO UPDATE SET archive_id = excluded.archive_id, shared = 1`,
    )
    .bind(p.commentId, archiveId, row.actor_user_id, Date.now())
    .run();
  return true;
}

/**
 * Unpublish one comment.
 *
 * ⚠️ Made with **that author's** actor id, read from the ledger rather than from
 * `comments` — the local row is already gone by the time this runs, which is precisely
 * why 0049 stores `author_id` separately.
 *
 * A `404` counts as success: the row is not there, which is the state we wanted.
 */
async function publishDelete(env: MirrorEnv, row: OutboxRow): Promise<boolean> {
  const p = JSON.parse(row.payload) as { archiveId: string };
  const actor = await actorId(env, row.actor_user_id);
  if (!actor) return true;

  const res = await commsuniCall(env, `/comments/${p.archiveId}`, { method: "DELETE", actor });
  if (!res.ok && res.status !== 404 && retryable(res)) return false;

  await env.DB
    .prepare("DELETE FROM archive_comment_refs WHERE archive_id = ?")
    .bind(p.archiveId)
    .run()
    .catch(() => {});
  return true;
}

const retryable = (res: { code?: string; status?: number }): boolean =>
  res.code === "network" || res.code === "breaker_open" || (res.status ?? 0) >= 500 || res.status === 429;

/** A suspended author may not publish. Suspension that lets writes out is decoration. */
async function authorSuspended(env: MirrorEnv, userId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT posting_suspended_until AS until FROM users WHERE id = ?")
    .bind(userId)
    .first<{ until: number | null }>()
    .catch(() => null);
  return !!row?.until && row.until > Date.now();
}

/**
 * Drain up to {@link DRAIN_LIMIT} items, oldest due first.
 *
 * ⚠️ **Bounded, and the bound is not a tuning knob.** This rides someone else's request
 * and every item is an outbound subrequest; an unbounded drain of a 40-item backlog
 * would blow the 50-subrequest cap and take down whatever request happened to trigger
 * it. A backlog drains over several requests — there is no deadline.
 *
 * ⚠️ Reports were already being ENQUEUED by Phase 3 with nothing to drain them, so
 * `report` is handled here too. Until this existed a transient report failure sat in
 * the table for ever.
 */
export async function drainArchiveOutbox(env: MirrorEnv, limit = DRAIN_LIMIT): Promise<number> {
  // ⚠️ Gated on upstream being CONFIGURED, not on the mirror being ON. Deletes and
  // reports must keep draining after the kill switch is thrown: a switch that also
  // stopped retractions would strand exactly the content someone asked to remove, and
  // reports have been queueing since Phase 3 with no drain at all. Only the two
  // publishing kinds check the flag, immediately below.
  if (!commsuniEnabled(env)) return 0;

  const { results } = await env.DB
    .prepare(
      `SELECT id, kind, idempotency_key, actor_user_id, payload, attempts
         FROM archive_outbox WHERE next_at <= ? ORDER BY next_at LIMIT ?`,
    )
    .bind(Date.now(), limit)
    .all<OutboxRow>()
    .catch(() => ({ results: [] as OutboxRow[] }));

  let done = 0;
  for (const row of results ?? []) {
    let settled = false;
    try {
      if (row.kind === "delete") settled = await publishDelete(env, row);
      else if (row.kind === "comment" || row.kind === "reply") {
        // Switched off mid-flight: leave it queued rather than dropping it, so
        // enabling the mirror later publishes the backlog instead of losing it.
        settled = mirrorEnabled(env) ? await publishComment(env, row) : false;
      }
      else if (row.kind === "report") settled = await publishReport(env, row);
      else settled = true; // Unknown kind: drop rather than spin on it for ever.
    } catch {
      settled = false;
    }

    if (settled) {
      await env.DB.prepare("DELETE FROM archive_outbox WHERE id = ?").bind(row.id).run().catch(() => {});
      done++;
    } else {
      // Give up after enough attempts rather than retrying for ever — each attempt is
      // a subrequest on somebody's request, and a permanently failing item would tax
      // every drain behind it.
      const attempts = row.attempts + 1;
      if (attempts >= 6) {
        await env.DB.prepare("DELETE FROM archive_outbox WHERE id = ?").bind(row.id).run().catch(() => {});
      } else {
        await env.DB
          .prepare("UPDATE archive_outbox SET attempts = ?, next_at = ? WHERE id = ?")
          .bind(attempts, Date.now() + Math.min(2 ** attempts, 60) * 60_000, row.id)
          .run()
          .catch(() => {});
      }
    }
  }
  return done;
}

/** The Phase 3 report retry, which previously had no drain at all. */
async function publishReport(env: MirrorEnv, row: OutboxRow): Promise<boolean> {
  const p = JSON.parse(row.payload) as { archiveId: string; reason: string };
  const actor = await actorId(env, row.actor_user_id);
  if (!actor) return true;
  const res = await commsuniCall(env, `/comments/${p.archiveId}/reports`, {
    method: "POST",
    actor,
    idempotencyKey: row.idempotency_key,
    body: { reason: p.reason },
  });
  return res.ok || !retryable(res);
}

/**
 * Queue a freshly posted or edited comment for mirroring.
 *
 * Called from the post handler. Does nothing at all unless the mirror is on and the row
 * is public — the two checks that keep a friends-only comment from ever entering the
 * pipeline in the first place.
 */
export async function queueMirror(
  env: MirrorEnv,
  comment: MirrorableComment & { updated_at?: number },
  refPathValue: string,
  extras: { attachments?: string[]; entity?: { title?: string; showTitle?: string }; parentArchiveId?: string } = {},
): Promise<void> {
  if (!mirrorEnabled(env)) return;
  if (!mayMirror(comment)) return;

  const existing = await env.DB
    .prepare("SELECT archive_id, edits, shared FROM archive_comment_refs WHERE comment_id = ?")
    .bind(comment.id)
    .first<{ archive_id: string; edits: number; shared: number }>()
    .catch(() => null);

  // An edit is delete + repost. Past the cap, or once replies hang off it, we stop and
  // mark it no longer shared rather than orphaning other people's replies.
  if (existing) {
    if (!existing.shared) return;
    if (existing.edits >= MAX_EDITS || (await hasArchiveReplies(env, existing.archive_id))) {
      await enqueue(env, "delete", comment.author_id, `unshare:${comment.id}`, { archiveId: existing.archive_id });
      await env.DB
        .prepare("UPDATE archive_comment_refs SET shared = 0 WHERE comment_id = ?")
        .bind(comment.id)
        .run()
        .catch(() => {});
      return;
    }
    await enqueue(env, "delete", comment.author_id, `edit:${comment.id}:${existing.edits}`, {
      archiveId: existing.archive_id,
    });
    await env.DB
      .prepare("UPDATE archive_comment_refs SET edits = edits + 1 WHERE comment_id = ?")
      .bind(comment.id)
      .run()
      .catch(() => {});
  }

  await enqueue(
    env,
    extras.parentArchiveId ? "reply" : "comment",
    comment.author_id,
    mirrorKey(comment.id, comment.updated_at ?? Date.now()),
    {
      commentId: comment.id,
      refPath: refPathValue,
      parentArchiveId: extras.parentArchiveId,
      body: comment.body,
      lang: comment.lang,
      spoiler: !!comment.spoiler,
      attachments: extras.attachments,
      entity: extras.entity,
    },
  );
}

/** Does this upstream row have replies? An edit must not orphan them. */
async function hasArchiveReplies(env: MirrorEnv, archiveId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT 1 AS n FROM comments WHERE parent_id = ? LIMIT 1")
    .bind(archiveId)
    .first<{ n: number }>()
    .catch(() => null);
  return !!row;
}

/**
 * Queue the teardown for a deleted comment.
 *
 * ⚠️ Runs even when the mirror is switched off, and deliberately so: rows published
 * while it was on must still be retractable after it is turned off. A kill switch that
 * also disables deletion would strand exactly the content someone asked to remove.
 */
export async function queueUnmirror(env: MirrorEnv, commentId: string): Promise<void> {
  if (!commsuniEnabled(env)) return;
  const ref = await env.DB
    .prepare("SELECT archive_id, author_id FROM archive_comment_refs WHERE comment_id = ?")
    .bind(commentId)
    .first<{ archive_id: string; author_id: string }>()
    .catch(() => null);
  if (!ref) return;
  await enqueue(env, "delete", ref.author_id, `del:${commentId}`, { archiveId: ref.archive_id });
}
