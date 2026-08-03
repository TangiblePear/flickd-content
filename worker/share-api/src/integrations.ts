/**
 * Phase 3: server-coordinated, device-executed push to Trakt / SIMKL.
 *
 * ## Why the server does not push
 *
 * Pushing from here would mean storing a user's Trakt OAuth token on the server. This
 * design refuses that outright: the token stays on the device, the server only decides
 * WHAT is owed and WHICH device is doing it, and the device makes the call itself.
 *
 * That coordination is the whole point. Every device pushing its own writes is fine with
 * one device and a duplicate-generator with two — both push the same watch and Trakt
 * records it twice. A claimed job means exactly one device performs each push.
 *
 * ## Claims expire, and the device confirms
 *
 * A device that dies mid-push must not strand the work forever, so a claim times out and
 * another device may take it. And the SERVER never assumes success — the executing device
 * confirms, because only it knows whether Trakt actually accepted the call.
 */

import { resolveSession } from "./auth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Revoke-Session",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

export interface IntegrationsEnv {
  DB: D1Database;
}

/** Targets the server will coordinate. Validated, because it becomes a primary-key value. */
const TARGETS = new Set(["TRAKT", "SIMKL"]);

/**
 * Sentinel `origin` meaning "this removal collapsed two records of ONE viewing".
 *
 * Not a target, and deliberately not one: it must suppress the outward push to *every*
 * service, whereas a real origin excludes exactly the one it was observed from.
 */
export const ORIGIN_DEDUPE = "DEDUPE";

/**
 * How long a device owns a claimed job.
 *
 * Long enough that a slow push over mobile data finishes; short enough that a device
 * which was killed does not hold the work for an appreciable time. The cost of expiring
 * too early is a duplicate in Trakt; too late is a delayed push. Ten minutes is the
 * plan's figure and errs toward the second, which is the recoverable one.
 */
const CLAIM_TTL_MS = 10 * 60 * 1000;

/** Jobs handed to one device per sync. Bounds the work a single pass takes on. */
const MAX_JOBS_PER_SYNC = 5;

/** Ids per job — one sync batch's worth. */
const MAX_EVENT_IDS = 5000;

/**
 * Retries before a job is marked permanently failed.
 *
 * A failed push releases its claim rather than being deleted, which is right — dropping it
 * would leave the user's history missing entries with nothing to notice. But without a
 * ceiling, a dead integration (revoked token, an event the service will never accept)
 * re-issues the same doomed job on every sync pass forever.
 *
 * Eight is chosen against the sync cadence, not plucked: passes are ~15 minutes apart, so
 * this rides out roughly two hours of a service outage before concluding the job itself is
 * the problem. Giving up is reversible — reconnecting revives the backlog.
 */
const MAX_PUSH_ATTEMPTS = 8;

export interface PendingPush {
  pushId: string;
  target: string;
  action: string;
  eventIds: string[];
  claimExpiresAt: number;
}

/** Targets this account has connected. Empty ⇒ nothing to coordinate, and no writes. */
export async function connectedTargets(env: IntegrationsEnv, userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT target FROM user_integrations WHERE user_id = ? AND connected = 1",
  )
    .bind(userId)
    .all<{ target: string }>();
  return (results ?? []).map((r) => r.target);
}

/**
 * Queue a push for each connected target.
 *
 * ## The echo guard
 *
 * ⚠️ Events are filtered by SOURCE against the target: an event that came FROM Trakt is
 * never queued back TO Trakt. Without this, importing a 20,000-event Trakt history would
 * immediately queue all 20,000 straight back at Trakt — re-writing the user's own library
 * to itself, burning their rate limit, and on any timestamp rounding difference creating
 * a duplicate of every watch they own. It is the single most destructive thing this
 * feature could do, and it is one `filter` away at all times.
 *
 * Returns the number of jobs created, so the caller can decide whether anything happened.
 */
export async function queuePushes(
  env: IntegrationsEnv,
  userId: string,
  events: Array<{ id: string; source?: string }>,
  now: number,
): Promise<number> {
  if (events.length === 0) return 0;
  const targets = await connectedTargets(env, userId);
  if (targets.length === 0) return 0;

  const statements: D1PreparedStatement[] = [];
  for (const target of targets) {
    const ids = events
      .filter((e) => (e.source ?? "INTERNAL").toUpperCase() !== target)
      .map((e) => e.id)
      .slice(0, MAX_EVENT_IDS);
    if (ids.length === 0) continue;

    statements.push(
      env.DB.prepare(
        `INSERT INTO pending_integration_push (id, user_id, target, action, event_ids, created_at)
         VALUES (?,?,?,'ADD',?,?)`,
      ).bind(crypto.randomUUID(), userId, target, JSON.stringify(ids), now),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return statements.length;
}

/**
 * Queue a REMOVE, so a deletion propagates outward as well as between devices.
 *
 * ## The echo guard applies to removals too, and here it is safety-critical
 *
 * `origin` is the integration the deletion was OBSERVED from — "TRAKT" when a full sync
 * noticed the watch had gone there — or absent when the user deleted it themselves.
 *
 * ⚠️ Without excluding it, a deletion LEARNED from Trakt is pushed straight back to Trakt
 * as an instruction to delete. That inverts the direction of trust: the additive guard
 * merely prevents a wasteful round trip, but this one prevents a local MISREAD from
 * destroying data on the remote service. A reconcile that wrongly concludes an event is
 * gone would otherwise make itself right by deleting it for real.
 */
export async function queueRemoval(
  env: IntegrationsEnv,
  userId: string,
  eventId: string,
  now: number,
  origin?: string,
): Promise<void> {
  const exclude = (origin ?? "").toUpperCase();

  // ⚠️ A de-duplication is NOT a deletion of the watch. Two rows described one viewing —
  // the client pushed it, the service stored it under a coarser timestamp, and it came back
  // as a second row. Collapsing them keeps the viewing under the OTHER id, so propagating a
  // REMOVE would delete a watch the user still has, on every service at once. Excluded from
  // all targets rather than one, which is why a single `origin` string cannot express it.
  if (exclude === ORIGIN_DEDUPE) return;


  const targets = (await connectedTargets(env, userId)).filter((t) => t !== exclude);
  if (targets.length === 0) return;
  await env.DB.batch(
    targets.map((target) =>
      env.DB
        .prepare(
          `INSERT INTO pending_integration_push (id, user_id, target, action, event_ids, created_at)
           VALUES (?,?,?,'REMOVE',?,?)`,
        )
        .bind(crypto.randomUUID(), userId, target, JSON.stringify([eventId]), now),
    ),
  );
}

/**
 * Hand this device the jobs it should execute, claiming them in the same pass.
 *
 * Takes unclaimed jobs and jobs whose claim has EXPIRED — that second case is what stops
 * a device dying mid-push from stranding the work permanently.
 *
 * Returns an empty list without writing anything when there is nothing owed, which is the
 * overwhelmingly common case and must stay free.
 */
export async function claimPushes(
  env: IntegrationsEnv,
  userId: string,
  deviceId: string,
  now: number,
): Promise<PendingPush[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, target, action, event_ids FROM pending_integration_push
      WHERE user_id = ? AND failed_at IS NULL AND (claimed_by IS NULL OR claimed_at < ?)
      ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(userId, now - CLAIM_TTL_MS, MAX_JOBS_PER_SYNC)
    .all<{ id: string; target: string; action: string; event_ids: string }>();

  const rows = results ?? [];
  if (rows.length === 0) return [];

  await env.DB.batch(
    rows.map((r) =>
      env.DB
        .prepare("UPDATE pending_integration_push SET claimed_by = ?, claimed_at = ? WHERE user_id = ? AND id = ?")
        .bind(deviceId || "unknown", now, userId, r.id),
    ),
  );

  return rows.map((r) => ({
    pushId: r.id,
    target: r.target,
    action: r.action,
    eventIds: safeIds(r.event_ids),
    claimExpiresAt: now + CLAIM_TTL_MS,
  }));
}

/** A malformed blob must not throw on the hot sync path; an empty job is simply a no-op. */
function safeIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * `POST /api/history/confirm-push` — the device reports what happened.
 *
 * Success deletes the job. Failure RELEASES the claim rather than deleting it, so another
 * device (or this one, later) retries — a push that failed must not be silently forgotten,
 * because nothing else would ever notice the user's Trakt history was missing entries.
 *
 * When only some events failed, the job is replaced by a smaller one covering exactly
 * those. Retrying the whole batch would re-push the events that DID land, and Trakt would
 * record them twice.
 */
export async function handleConfirmPush(req: Request, env: IntegrationsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "invalid_payload" }, 400);

  const pushId = typeof body.pushId === "string" ? body.pushId : "";
  if (!pushId) return json({ error: "invalid_payload" }, 400);
  const succeeded = body.succeeded === true;
  const failedIds = Array.isArray(body.failedEventIds)
    ? body.failedEventIds.filter((x): x is string => typeof x === "string")
    : [];

  if (succeeded && failedIds.length === 0) {
    await env.DB.prepare("DELETE FROM pending_integration_push WHERE user_id = ? AND id = ?")
      .bind(session.userId, pushId)
      .run();
    return json({ ok: true });
  }

  const target = typeof body.target === "string" && TARGETS.has(body.target.toUpperCase())
    ? body.target.toUpperCase()
    : null;

  // The attempt count so far. Read before either branch, because both consume one.
  const row = await env.DB.prepare(
    "SELECT attempts FROM pending_integration_push WHERE user_id = ? AND id = ?",
  )
    .bind(session.userId, pushId)
    .first<{ attempts: number }>();
  const attempts = (row?.attempts ?? 0) + 1;
  const givingUp = attempts >= MAX_PUSH_ATTEMPTS;

  if (failedIds.length > 0 && target) {
    // Replace the job with one covering ONLY the failures. Re-queueing the whole batch
    // would re-push what already landed and duplicate it in Trakt.
    //
    // ⚠️ The replacement INHERITS the attempt count. It is a new row with a new id, so
    // without this a job that keeps failing partially resets its counter every pass and
    // retries forever — the exact loop the ceiling exists to stop.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pending_integration_push WHERE user_id = ? AND id = ?").bind(session.userId, pushId),
      env.DB
        .prepare(
          `INSERT INTO pending_integration_push (id, user_id, target, action, event_ids, created_at, attempts, failed_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          session.userId,
          target,
          typeof body.action === "string" && body.action.toUpperCase() === "REMOVE" ? "REMOVE" : "ADD",
          JSON.stringify(failedIds.slice(0, MAX_EVENT_IDS)),
          Date.now(),
          attempts,
          givingUp ? Date.now() : null,
        ),
    ]);
    return json({ ok: true, requeued: failedIds.length, attempts, gaveUp: givingUp });
  }

  // Whole-job failure: release the claim so it is retried rather than lost — until the
  // ceiling, at which point it is MARKED rather than deleted. Deleting would reintroduce
  // exactly the silent loss that release-on-failure exists to prevent; `failed_at` stops it
  // being claimed while keeping "these watches never reached Trakt" an answerable question.
  await env.DB.prepare(
    `UPDATE pending_integration_push
        SET claimed_by = NULL, claimed_at = NULL, attempts = ?, failed_at = ?
      WHERE user_id = ? AND id = ?`,
  )
    .bind(attempts, givingUp ? Date.now() : null, session.userId, pushId)
    .run();
  return json({ ok: true, released: !givingUp, attempts, gaveUp: givingUp });
}

/**
 * `PUT /api/history/integrations` — the device tells the server what it has connected.
 *
 * Idempotent. Disconnecting sets `connected = 0` rather than deleting the row, and also
 * clears any queued work for that target: a user who disconnects Trakt must not have a
 * backlog fire at it days later when they reconnect.
 */
export async function handleUpdateIntegration(
  req: Request,
  env: IntegrationsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const target = typeof body?.target === "string" ? body.target.toUpperCase() : "";
  if (!TARGETS.has(target)) return json({ error: "invalid_target" }, 400);
  const connected = body?.connected === true;

  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO user_integrations (user_id, target, connected, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(user_id, target) DO UPDATE SET connected = excluded.connected, updated_at = excluded.updated_at`,
    ).bind(session.userId, target, connected ? 1 : 0, now),
  ];
  if (!connected) {
    statements.push(
      env.DB.prepare("DELETE FROM pending_integration_push WHERE user_id = ? AND target = ?").bind(
        session.userId,
        target,
      ),
    );
  } else {
    // Reconnecting REVIVES a backlog that had given up. The usual reason pushes die is a
    // lapsed token, and re-authorising is exactly the action that makes those jobs
    // deliverable again — leaving them dead would strand work that has just become valid.
    // Costs nothing when there is nothing failed, which is the normal case.
    statements.push(
      env.DB.prepare(
        `UPDATE pending_integration_push SET failed_at = NULL, attempts = 0
          WHERE user_id = ? AND target = ? AND failed_at IS NOT NULL`,
      ).bind(session.userId, target),
    );
  }
  await env.DB.batch(statements);
  return json({ ok: true, target, connected });
}

/**
 * How long a granted reconcile lease lasts.
 *
 * This is a rate limit as much as a mutex. A delete reconcile means crawling the user's
 * entire remote history, so once a day per ACCOUNT is generous; running it per device per
 * day is the thing being prevented. A device that takes the lease and then dies simply
 * delays the next reconcile by under a day, which is the cheap failure — the expensive one
 * is two devices reconciling at once, and that is what the lease makes impossible.
 */
const RECONCILE_LEASE_MS = 20 * 60 * 60 * 1000;

/**
 * `POST /api/history/reconcile-lease` — "may I be the device that decides what Trakt has
 * deleted?"
 *
 * ## Why deletion is serialised when addition is not
 *
 * Adding is idempotent and self-correcting: two devices pushing the same watch converge on
 * the same union. Deleting is neither. It is a claim of ABSENCE, derived from one device's
 * possibly-truncated view of a remote service, and it is now account-wide — so every extra
 * device is another independent chance to be wrong, with no corresponding chance to be
 * more right. The safe number of devices forming that opinion is one.
 *
 * Denial is a pure read and writes nothing, which matters because it is the common answer.
 * Only the grant costs a row.
 */
export async function handleReconcileLease(
  req: Request,
  env: IntegrationsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const target = typeof body?.target === "string" ? body.target.toUpperCase() : "";
  if (!TARGETS.has(target)) return json({ error: "invalid_target" }, 400);
  const deviceId = typeof body?.deviceId === "string" && body.deviceId ? body.deviceId : "unknown";

  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT reconcile_by, reconcile_at FROM user_integrations WHERE user_id = ? AND target = ?",
  )
    .bind(session.userId, target)
    .first<{ reconcile_by: string | null; reconcile_at: number | null }>();

  // No row means the account never registered this integration, so it has no business
  // reconciling it. Registration happens on the ordinary sync loop and will fill this in.
  if (!row) return json({ granted: false, reason: "not_registered" });

  const heldUntil = (row.reconcile_at ?? 0) + RECONCILE_LEASE_MS;
  // The holder renewing its own lease is a grant, not a conflict — a device that
  // reconciles daily should keep doing so rather than lock itself out on day two.
  if (now < heldUntil && row.reconcile_by !== deviceId) {
    return json({ granted: false, reason: "held", retryAfter: heldUntil - now });
  }

  // Compare-and-set on exactly the values just read, so two devices racing here cannot
  // both win: the loser's UPDATE matches zero rows and it is told so. `IS` rather than `=`
  // because the first-ever lease compares against NULL, where `=` yields NULL, not true.
  const res = await env.DB.prepare(
    `UPDATE user_integrations SET reconcile_by = ?, reconcile_at = ?
      WHERE user_id = ? AND target = ? AND reconcile_at IS ? AND reconcile_by IS ?`,
  )
    .bind(deviceId, now, session.userId, target, row.reconcile_at, row.reconcile_by)
    .run();

  if ((res.meta?.changes ?? 0) === 0) return json({ granted: false, reason: "raced" });
  return json({ granted: true, expiresAt: now + RECONCILE_LEASE_MS });
}

/** `GET /api/history/integrations` — what the server believes is connected. */
export async function handleGetIntegrations(
  req: Request,
  env: IntegrationsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const { results } = await env.DB.prepare(
    "SELECT target, COUNT(*) AS n FROM pending_integration_push WHERE user_id = ? AND failed_at IS NOT NULL GROUP BY target",
  )
    .bind(session.userId)
    .all<{ target: string; n: number }>();
  const abandoned: Record<string, number> = {};
  for (const r of results ?? []) abandoned[r.target] = r.n;
  return json({ targets: await connectedTargets(env, session.userId), abandoned });
}

/** Account deletion. Exported so the erasure batch cannot forget these two tables. */
export const integrationErasureSql = [
  "DELETE FROM pending_integration_push WHERE user_id = ?",
  "DELETE FROM user_integrations WHERE user_id = ?",
];

export { CLAIM_TTL_MS, MAX_JOBS_PER_SYNC, MAX_PUSH_ATTEMPTS, RECONCILE_LEASE_MS };
