// ── Friend Match, server-side ────────────────────────────────────────────────
// The pair-scoring handshake, moved off the E2EE inbox — but the taste vectors
// themselves are NOT given up. The server gains the handshake in plaintext (who
// asked whom, when, what state) and nothing more: that is the friend graph it
// already holds, plus an edge type. The profiles stay sealed to exactly one reader.
//
// E2EE was rejected for comments because encrypting to a MUTABLE audience drags
// along the key-rotation machinery that caused the first-pairing bootstrap
// deadlock. A match is exactly two people, fixed at accept time — there is no
// audience to rotate, so that objection does not apply here, and taste vectors are
// the most revealing thing in the app.
//
// ## The exchange order IS the privacy property. Do not reorder it.
//
//   1. The requester creates the row AND uploads their own profile sealed to the
//      target. Ciphertext, addressed to one reader; the server cannot read it.
//   2. The target's device sees the request on its next sync and prompts.
//   3. **On accept** the target uploads THEIR profile, sealed to the requester,
//      and the state flips to `accepted`.
//   4. Each side fetches the other's blob.
//
// The asymmetry is the point: a request costs the *requester* some exposure to
// their chosen recipient, and costs the *target* nothing at all until they tap
// accept. That is also what makes `origin = 'scan'` safe — nothing of yours leaves
// before you consent, so it does not much matter who is allowed to ask.

import { areFriends, isBlockedEitherWay } from "./authz";
import { resolveSession } from "./auth";
import type { Notifier } from "./lists";

export interface MatchEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
  /** Distinct-request cap per requester per hour. Anti-harassment, same idea as friend requests. */
  MATCH_REQUESTS_PER_HOUR?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-Revoke-Session",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const noContent = () => new Response(null, { status: 204, headers: CORS });

const USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MATCH_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FRIEND_CODE_RE = /^[A-Z0-9]{6,12}$/;

/** Sealed PartnerProfile ciphertext. Generous — a taste vector plus a watched-id list. */
const MAX_SEALED = 256 * 1024;
const MAX_KEYSET = 8 * 1024;
const DEFAULT_REQUESTS_PER_HOUR = 20;

/**
 * Backstop for a device that never comes back to collect a `once` payload. The
 * primary delete is on collection (both sides fetched); this only catches the
 * abandoned case, and it runs lazily off request traffic because this account is
 * at its 5-cron limit — the same reason the orphan-profile reaper is opportunistic.
 */
const ONCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a finished handshake stays as a tombstone before it is swept.
 *
 * A revoke/decline sets a terminal state rather than deleting the row, because that
 * row is the ONLY thing that tells the other side the match ended — the client's
 * "row vanished" sweep clears pending requests but never the stored roster, so a
 * deleted row leaves the other device showing "Matched" forever. The tombstone has
 * to outlive every device's next sync, and 30 days is far past that for anything
 * still installed. Nothing else prunes this table: without a sweep, every match ever
 * declined or revoked is kept for the life of the account.
 */
const TERMINAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const MATCH_ORIGIN_SCAN = "scan";
export const RETENTION_ONCE = "once";
export const RETENTION_KEEP = "keep";

/**
 * Resolves a published friend card to the account that owns it.
 *
 * Injected rather than imported because the card lives in R2 and this module is
 * deliberately D1-only — the same reason `sync.ts` takes a `RelayLoader`. Returns
 * null for an unknown code or a card whose owner has no account.
 */
export type CardResolver = (code: string) => Promise<string | null>;

interface MatchRow {
  id: string;
  requester_id: string;
  target_id: string;
  state: string;
  origin: string;
  retention: string;
  requester_keyset: string;
  anchor_at: number;
  created_at: number;
  updated_at: number;
}

/** 128-bit opaque id, Crockford base32 — same shape as `users.id`. */
function newId(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A terminal state can be re-requested; a live one cannot be re-opened. */
const isTerminal = (state: string) => state === "declined" || state === "revoked";

/**
 * Every match handshake touching [userId], split by direction.
 *
 * Handshakes only — the sealed blobs are a separate table and a separate,
 * explicit fetch, because this is read on every sync and they are not.
 */
export async function loadMatches(env: MatchEnv, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, requester_id, target_id, state, origin, retention, requester_keyset,
            anchor_at, created_at, updated_at
       FROM match_requests
      WHERE requester_id = ? OR target_id = ?`,
  )
    .bind(userId, userId)
    .all<MatchRow>();

  const incoming: unknown[] = [];
  const outgoing: unknown[] = [];
  for (const row of results ?? []) {
    (row.target_id === userId ? incoming : outgoing).push(toWire(row));
  }
  return { incoming, outgoing };
}

function toWire(row: MatchRow) {
  return {
    id: row.id,
    requesterId: row.requester_id,
    targetId: row.target_id,
    state: row.state,
    origin: row.origin,
    retention: row.retention,
    // Only meaningful to the target, who has no friend row for a stranger and
    // therefore nothing else to seal their half back to.
    requesterKeyset: row.requester_keyset,
    anchorAt: row.anchor_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `GET /api/match` — my handshakes, both directions.
 *
 * The same rows `POST /api/sync` folds in. It exists as its own endpoint so a pass
 * that could not use the consolidated sync still has a real fallback, exactly as
 * `GET /api/lists/shared` does — otherwise the only way to read a handshake would be
 * the very request the client just failed to make.
 */
export async function handleGetMatches(req: Request, env: MatchEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  return json(await loadMatches(env, session.userId));
}

/** Per-requester hourly cap. Rate limiting a match request is an anti-harassment control. */
async function requestRateLimited(env: MatchEnv, userId: string): Promise<boolean> {
  const limit = Number(env.MATCH_REQUESTS_PER_HOUR ?? DEFAULT_REQUESTS_PER_HOUR);
  if (limit <= 0) return false;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM match_requests WHERE requester_id = ? AND created_at > ?",
  )
    .bind(userId, Date.now() - 3600_000)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= limit;
}

/**
 * `POST /api/match/request` `{ targetId, retention, origin, sealed, keyset, anchorAt, targetFriendCode? }`
 *
 * Two origins:
 *
 * - `friend` — requires an accepted friendship. **Not a new restriction:** today
 *   `FriendMatchRepository` refuses on both ends unless the pair are accepted
 *   friends. The rule simply moves somewhere it can be enforced.
 * - `scan`   — the stranger path. Requires a valid published friend card for the
 *   target, and forces `retention = once`.
 *
 * The card check is spam control, **not** a proximity proof, and must not be
 * mistaken for one: the same card is published under the shareable friend code
 * that goes in invite links, so holding it proves nothing about being in the room.
 * What actually makes this safe is the exchange order — nothing of the target's
 * leaves before they tap accept.
 *
 * A request to someone who has blocked you reports success and creates nothing.
 */
export async function handleMatchRequest(
  req: Request,
  env: MatchEnv,
  ctx?: ExecutionContext,
  resolveCard?: CardResolver,
  notify?: Notifier,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const payload = await readBody(req);
  const target = str(payload?.targetId);
  const sealed = str(payload?.sealed);
  const keyset = str(payload?.keyset);
  const origin = payload?.origin === MATCH_ORIGIN_SCAN ? MATCH_ORIGIN_SCAN : "friend";
  // A scan match is between two people who are not friends. `once` is exactly what
  // that concept was invented for, so it is forced rather than offered.
  const retention =
    origin === MATCH_ORIGIN_SCAN ? RETENTION_ONCE : payload?.retention === RETENTION_ONCE ? RETENTION_ONCE : RETENTION_KEEP;
  const anchorAt = typeof payload?.anchorAt === "number" ? payload.anchorAt : 0;

  if (!USER_ID_RE.test(target) || target === session.userId) return json({ error: "invalid_payload" }, 400);
  if (!sealed || !keyset) return json({ error: "invalid_payload" }, 400);
  if (sealed.length > MAX_SEALED || keyset.length > MAX_KEYSET) return json({ error: "too_large" }, 413);

  // Block wins, and wins silently — same shape as a delivered request. The id is
  // fabricated rather than looked up, because there is nothing to look up.
  if (await isBlockedEitherWay(env, session.userId, target)) {
    return json({ id: newId(), state: "pending" });
  }

  if (origin === MATCH_ORIGIN_SCAN) {
    const code = str(payload?.targetFriendCode).toUpperCase();
    if (!FRIEND_CODE_RE.test(code) || !resolveCard) return json({ error: "forbidden" }, 403);
    const owner = await resolveCard(code);
    if (owner !== target) return json({ error: "forbidden" }, 403);
  } else if (!(await areFriends(env, session.userId, target))) {
    return json({ error: "forbidden" }, 403);
  }

  const now = Date.now();
  const existing = await env.DB.prepare(
    "SELECT id, state, retention FROM match_requests WHERE requester_id = ? AND target_id = ?",
  )
    .bind(session.userId, target)
    .first<{ id: string; state: string; retention: string }>();

  // Re-requesting a *live* handshake is a no-op, which is what the unique index buys:
  // without it a duplicate is possible and only the client de-dupes it.
  //
  // But a `once` match whose payloads have both been collected is **over**, even though
  // the row still reads `accepted` — `consumeIfCollected` deleted them on purpose, and
  // the handshake row survives only as the record that a match happened. Treating that
  // as live made it permanently un-rematchable: the row is not terminal, so every later
  // request returned instantly, created nothing and notified nobody. Measured on device
  // 2026-07-27 as "I pressed Match and nothing happened", forever, with no way back.
  if (existing && !isTerminal(existing.state)) {
    const spent =
      existing.state === "accepted" &&
      existing.retention === RETENTION_ONCE &&
      !(await hasPayloads(env, existing.id));
    if (!spent) {
      // Asking again while they have not answered re-sends the nudge. The first push
      // can be dropped, and a retry that visibly does nothing is worse than a spare
      // notification — this is user-initiated and costs one message.
      if (existing.state === "pending") notify?.(target);
      return json({ id: existing.id, state: existing.state });
    }
  }

  if (await requestRateLimited(env, session.userId)) return json({ error: "rate_limited" }, 429);

  const id = existing?.id ?? newId();
  if (existing) {
    // Re-opening after a decline or revoke is allowed — people change their minds.
    // The old sealed blobs are replaced, never merged: they were sealed for a
    // handshake that is over.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM match_payloads WHERE request_id = ?").bind(id),
      env.DB
        .prepare(
          `UPDATE match_requests
              SET state = 'pending', origin = ?, retention = ?, requester_keyset = ?,
                  anchor_at = ?, created_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(origin, retention, keyset, anchorAt, now, now, id),
    ]);
  } else {
    await env.DB.prepare(
      `INSERT INTO match_requests
         (id, requester_id, target_id, state, origin, retention, requester_keyset, anchor_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, session.userId, target, origin, retention, keyset, anchorAt, now, now)
      .run();
  }

  await putPayload(env, id, session.userId, sealed, now);
  // Not reached by the block branch above — see the note in `handleShareList`.
  notify?.(target);
  return json({ id, state: "pending" });
}

/**
 * `POST /api/match/{id}/accept` `{ sealed }` — the target consents and uploads
 * their half, sealed to the requester.
 *
 * This is the ONLY point at which anything of the target's leaves their device.
 */
export async function handleMatchAccept(
  id: string,
  req: Request,
  env: MatchEnv,
  ctx?: ExecutionContext,
  notify?: Notifier,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!MATCH_ID_RE.test(id)) return json({ error: "not_found" }, 404);

  const payload = await readBody(req);
  const sealed = str(payload?.sealed);
  if (!sealed) return json({ error: "invalid_payload" }, 400);
  if (sealed.length > MAX_SEALED) return json({ error: "too_large" }, 413);

  const row = await env.DB.prepare(
    "SELECT id, requester_id, target_id, state FROM match_requests WHERE id = ? AND target_id = ?",
  )
    .bind(id, session.userId)
    .first<{ id: string; requester_id: string; target_id: string; state: string }>();
  // Not addressed to us is the same 404 an unknown id gets — anything else confirms
  // the handshake exists.
  if (!row) return json({ error: "not_found" }, 404);
  if (row.state === "accepted") return json({ state: "accepted" });
  if (isTerminal(row.state)) return json({ error: "not_found" }, 404);

  // Block can land between request and accept; consenting to it would hand the
  // blocker's sealed profile to someone they have since blocked.
  if (await isBlockedEitherWay(env, session.userId, row.requester_id)) return json({ error: "not_found" }, 404);

  const now = Date.now();
  await putPayload(env, id, session.userId, sealed, now);
  await env.DB.prepare("UPDATE match_requests SET state = 'accepted', updated_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
  // The requester has been waiting on this since they asked, and their half is only
  // collectable now — without a wake-up they would not fetch it until the next sync.
  notify?.(row.requester_id);
  return json({ state: "accepted" });
}

/**
 * `GET /api/match/{id}/payload` — the OTHER party's sealed profile.
 *
 * Stamps `fetched_at`, and once both directions have been collected on a `once`
 * match, deletes both blobs. That is a real delete of data the server could never
 * read anyway — belt and braces, and it makes the UI's promise true rather than
 * aspirational. The handshake row survives as the record that a match happened.
 */
export async function handleGetMatchPayload(
  id: string,
  req: Request,
  env: MatchEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!MATCH_ID_RE.test(id)) return json({ error: "not_found" }, 404);

  const row = await env.DB.prepare(
    "SELECT id, requester_id, target_id, state, retention FROM match_requests WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; requester_id: string; target_id: string; state: string; retention: string }>();
  if (!row) return json({ error: "not_found" }, 404);
  if (row.requester_id !== session.userId && row.target_id !== session.userId) {
    return json({ error: "not_found" }, 404);
  }
  // Before accept there is only the requester's blob, and it is addressed to the
  // target — who has not consented yet. Nobody may collect anything.
  if (row.state !== "accepted") return json({ error: "not_found" }, 404);

  const other = row.requester_id === session.userId ? row.target_id : row.requester_id;
  const blob = await env.DB.prepare(
    "SELECT sealed FROM match_payloads WHERE request_id = ? AND sender_id = ?",
  )
    .bind(id, other)
    .first<{ sealed: string }>();
  if (!blob) return json({ error: "not_found" }, 404);

  await env.DB.prepare(
    "UPDATE match_payloads SET fetched_at = ? WHERE request_id = ? AND sender_id = ? AND fetched_at = 0",
  )
    .bind(Date.now(), id, other)
    .run();

  if (row.retention === RETENTION_ONCE) await consumeIfCollected(env, id);
  return json({ sealed: blob.sealed });
}

/**
 * `DELETE /api/match/{id}` — decline as the target, revoke as the requester.
 *
 * Both land on a terminal state rather than deleting the row, so the other side
 * converges on its next sync instead of the handshake simply vanishing. The sealed
 * blobs go immediately either way: whatever this was, it is over.
 *
 * 204 even for an unknown id, so it cannot be used to probe which ids exist.
 */
export async function handleDeleteMatch(
  id: string,
  req: Request,
  env: MatchEnv,
  ctx?: ExecutionContext,
  notify?: Notifier,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!MATCH_ID_RE.test(id)) return noContent();

  const row = await env.DB.prepare(
    "SELECT id, requester_id, target_id FROM match_requests WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; requester_id: string; target_id: string }>();
  if (!row) return noContent();
  if (row.requester_id !== session.userId && row.target_id !== session.userId) return noContent();

  const state = row.requester_id === session.userId ? "revoked" : "declined";
  await env.DB.batch([
    env.DB
      .prepare("UPDATE match_requests SET state = ?, updated_at = ? WHERE id = ?")
      .bind(state, Date.now(), id),
    env.DB.prepare("DELETE FROM match_payloads WHERE request_id = ?").bind(id),
  ]);
  // Wake the OTHER party. Request and accept both did this; decline and revoke did
  // not, so the one person actually waiting on the answer — the requester, sitting on
  // a "Pending" button — did not learn of it until their next sync, which in practice
  // meant leaving the Friends screen and coming back. Symmetric on purpose: a revoke
  // should clear the target's prompt just as promptly.
  notify?.(row.requester_id === session.userId ? row.target_id : row.requester_id);
  return noContent();
}

async function putPayload(env: MatchEnv, requestId: string, senderId: string, sealed: string, now: number) {
  await env.DB.prepare(
    `INSERT INTO match_payloads (request_id, sender_id, sealed, created_at, fetched_at)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(request_id, sender_id) DO UPDATE
       SET sealed = excluded.sealed, created_at = excluded.created_at, fetched_at = 0`,
  )
    .bind(requestId, senderId, sealed, now)
    .run();
}

/** Any sealed halves still held for this handshake. Distinguishes a live `once` match from a spent one. */
async function hasPayloads(env: MatchEnv, requestId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM match_payloads WHERE request_id = ?")
    .bind(requestId)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

/**
 * Lazy TTL sweep for handshakes that ended long ago.
 *
 * Same shape and the same reason as [sweepOnceMatchPayloads]: not a cron, because the
 * account is at its 5-cron limit, so it rides ambient sync traffic instead. Bounded by
 * the age predicate, and only ever touches rows both parties finished with.
 *
 * Deliberately keyed on `updated_at`, which is when the row went terminal, not
 * `created_at` — a handshake declined yesterday after sitting pending for a year is one
 * day old for this purpose, and sweeping it early would drop the tombstone before the
 * other device ever saw it.
 */
export async function sweepTerminalMatches(env: MatchEnv, nowMs = Date.now()): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM match_requests WHERE state IN ('declined', 'revoked') AND updated_at < ?",
  )
    .bind(nowMs - TERMINAL_TTL_MS)
    .run();
}

/** Both directions collected on a `once` match ⇒ drop both blobs. */
async function consumeIfCollected(env: MatchEnv, requestId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN fetched_at > 0 THEN 1 ELSE 0 END) AS got FROM match_payloads WHERE request_id = ?",
  )
    .bind(requestId)
    .first<{ n: number; got: number }>();
  if ((row?.n ?? 0) >= 2 && (row?.got ?? 0) >= 2) {
    await env.DB.prepare("DELETE FROM match_payloads WHERE request_id = ?").bind(requestId).run();
  }
}

/**
 * Lazy TTL sweep for `once` payloads nobody ever collected.
 *
 * Deliberately not a cron: this account is at its 5-cron limit, which is why the
 * orphan-profile reaper is opportunistic too. One bounded DELETE riding ambient
 * request traffic is enough for a backstop — the primary delete is on collection.
 */
export async function sweepOnceMatchPayloads(env: MatchEnv, nowMs = Date.now()): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM match_payloads
      WHERE created_at < ?
        AND request_id IN (SELECT id FROM match_requests WHERE retention = 'once')`,
  )
    .bind(nowMs - ONCE_TTL_MS)
    .run();
}
