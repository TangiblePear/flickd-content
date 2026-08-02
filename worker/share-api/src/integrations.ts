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

/** Queue a REMOVE, so a deletion propagates outward as well as between devices. */
export async function queueRemoval(
  env: IntegrationsEnv,
  userId: string,
  eventId: string,
  now: number,
): Promise<void> {
  const targets = await connectedTargets(env, userId);
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
      WHERE user_id = ? AND (claimed_by IS NULL OR claimed_at < ?)
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

  if (failedIds.length > 0 && target) {
    // Replace the job with one covering ONLY the failures. Re-queueing the whole batch
    // would re-push what already landed and duplicate it in Trakt.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pending_integration_push WHERE user_id = ? AND id = ?").bind(session.userId, pushId),
      env.DB
        .prepare(
          `INSERT INTO pending_integration_push (id, user_id, target, action, event_ids, created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          session.userId,
          target,
          typeof body.action === "string" && body.action.toUpperCase() === "REMOVE" ? "REMOVE" : "ADD",
          JSON.stringify(failedIds.slice(0, MAX_EVENT_IDS)),
          Date.now(),
        ),
    ]);
    return json({ ok: true, requeued: failedIds.length });
  }

  // Whole-job failure: release the claim so it is retried rather than lost.
  await env.DB.prepare(
    "UPDATE pending_integration_push SET claimed_by = NULL, claimed_at = NULL WHERE user_id = ? AND id = ?",
  )
    .bind(session.userId, pushId)
    .run();
  return json({ ok: true, released: true });
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
  }
  await env.DB.batch(statements);
  return json({ ok: true, target, connected });
}

/** `GET /api/history/integrations` — what the server believes is connected. */
export async function handleGetIntegrations(
  req: Request,
  env: IntegrationsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as never, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  return json({ targets: await connectedTargets(env, session.userId) });
}

/** Account deletion. Exported so the erasure batch cannot forget these two tables. */
export const integrationErasureSql = [
  "DELETE FROM pending_integration_push WHERE user_id = ?",
  "DELETE FROM user_integrations WHERE user_id = ?",
];

export { CLAIM_TTL_MS, MAX_JOBS_PER_SYNC };
