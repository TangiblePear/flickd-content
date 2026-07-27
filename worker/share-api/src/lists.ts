// ── Shared lists, server-side ────────────────────────────────────────────────
// The in-app "send this list to Alex" path, moved off the E2EE inbox.
//
// This is NOT the anonymous `/api/share` → `/share/{code}` path, which stays
// exactly as it is: that one is for sharing to someone who has no app and is not
// your friend, and the 6-char code IS the token. This one already required an
// accepted friend, and that requirement now lives server-side where it can
// actually be enforced.
//
// What we give up: these lists were sealed to the recipient's keyset and are now
// server-readable. The promise becomes "only your friends can see this", enforced
// by the friendship check below, rather than "not even we can". That is the same
// trade already accepted for comments, and it is what makes a list reportable —
// which E2EE cannot support at all.
//
// **The block rule from friends.ts applies verbatim**: sharing to someone who has
// blocked you returns the SAME body as a delivered share and creates nothing. Any
// other behaviour turns this endpoint into a block detector, and it is the single
// easiest thing here to get wrong.

import { areFriends, isBlockedEitherWay } from "./authz";
import { resolveSession } from "./auth";

export interface ListsEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
}

/**
 * Wake a user's devices so they sync **now**.
 *
 * Injected rather than imported: the push record lives in R2 and is keyed by the
 * device friendId, neither of which belongs in a D1-only module — the same reason
 * `sync.ts` takes a `RelayLoader` and the match request takes a `CardResolver`.
 *
 * **This is not a nicety, it is what makes the feature work.** The inbox path it
 * replaces fired an FCM on every delivery (`handlePostInbox`), and the recipient
 * synced within seconds. Moving to D1 without carrying the push across left the
 * row sitting on the server with nothing telling anyone to look, so a share only
 * surfaced on the next scheduled sync — up to 24 hours later. Measured on device
 * 2026-07-27: the share landed 5 seconds after the recipient's last sync and was
 * still invisible ten minutes on.
 *
 * Fire-and-forget by contract: a delivered share must never fail because a push did.
 */
export type Notifier = (userId: string) => void;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-Revoke-Session",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const noContent = () => new Response(null, { status: 204, headers: CORS });

const USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Sender-minted share id. Same alphabet as `users.id`, but its length is the sender's business. */
const SHARE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{8,40}$/;

const MAX_TITLE = 120;
/** Matches `feed_events.payload`. A shared list of 100 titles is ~1.5KB. */
const MAX_PAYLOAD = 2048;
/** How many accepted rows ride a sync. Bounded by friend count anyway; this is the belt. */
const ACCEPTED_LIMIT = 50;

export interface SharedListRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  title: string;
  kind: string;
  item_count: number;
  payload: string;
  created_at: number;
  state: string;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Every shared list touching [userId], split by direction and state.
 *
 * Read on every sync, so it is one indexed read against
 * `idx_shared_lists_recipient` plus one for the caller's own outgoing rows. The
 * `accepted` half is what replaces the inbox ack: a second device sees the state
 * flip and drops its local pending row, with no request of its own.
 */
export async function loadSharedLists(env: ListsEnv, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, sender_id, recipient_id, title, kind, item_count, payload, created_at, state
       FROM shared_lists
      WHERE recipient_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(userId, ACCEPTED_LIMIT)
    .all<SharedListRow>();

  const pending: SharedListRow[] = [];
  const accepted: SharedListRow[] = [];
  for (const row of results ?? []) {
    if (row.state === "pending") pending.push(row);
    else if (row.state === "accepted") accepted.push(row);
  }
  return { pending: pending.map(toWire), accepted: accepted.map(toWire) };
}

/** Wire shape. `payload` travels as the opaque string the sender stored. */
function toWire(row: SharedListRow) {
  return {
    id: row.id,
    senderId: row.sender_id,
    title: row.title,
    kind: row.kind,
    itemCount: row.item_count,
    payload: row.payload,
    createdAt: row.created_at,
    state: row.state,
  };
}

/**
 * `POST /api/lists/share` `{ id, recipientId, title, kind, itemCount, payload }`.
 *
 * **[id] is minted by the sender, not here.** While the dual path is live the same
 * id rides the inbox message and this row, so the client's existing upsert de-dupes
 * for free; minting a server id would render the share twice.
 *
 * A share to someone who has blocked you returns `{ id }` exactly as a delivered
 * one does, and writes nothing.
 */
export async function handleShareList(
  req: Request,
  env: ListsEnv,
  ctx?: ExecutionContext,
  notify?: Notifier,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const payload = await readBody(req);
  const id = str(payload?.id);
  const recipient = str(payload?.recipientId);
  const title = str(payload?.title).slice(0, MAX_TITLE);
  const kind = payload?.kind === "smart" ? "smart" : "manual";
  const blob = str(payload?.payload);
  const itemCount = typeof payload?.itemCount === "number" ? Math.max(0, payload.itemCount | 0) : 0;

  if (!SHARE_ID_RE.test(id) || !USER_ID_RE.test(recipient)) return json({ error: "invalid_payload" }, 400);
  if (recipient === session.userId || !title || !blob) return json({ error: "invalid_payload" }, 400);
  if (blob.length > MAX_PAYLOAD) return json({ error: "too_large" }, 413);

  // Silent no-op, deliberately indistinguishable from a delivered share.
  if (await isBlockedEitherWay(env, session.userId, recipient)) return json({ id });
  // These are directed messages: a non-friend must not be able to address you at all.
  if (!(await areFriends(env, session.userId, recipient))) return json({ error: "forbidden" }, 403);

  // Re-sending the same id is the same share, not a second one — a retry after a
  // dropped response must not stack. The state is deliberately NOT reset: a share
  // the recipient already declined must stay declined.
  await env.DB.prepare(
    `INSERT INTO shared_lists (id, sender_id, recipient_id, title, kind, item_count, payload, created_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(id, session.userId, recipient, title, kind, itemCount, blob, Date.now())
    .run();

  // Deliberately NOT reached by the block branch above: waking someone's devices for
  // a share that was never created would be both pointless and a way to sense a block.
  notify?.(recipient);
  return json({ id });
}

/** `GET /api/lists/shared` — what has been shared with me, pending and recently accepted. */
export async function handleGetSharedLists(req: Request, env: ListsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  return json(await loadSharedLists(env, session.userId));
}

/**
 * `POST /api/lists/shared/{id}/accept` — the recipient took the list.
 *
 * Idempotent, and scoped to the recipient in the WHERE clause rather than by
 * reading the row first: a caller who is not the recipient changes nothing, and
 * gets the same 404 an unknown id gets. Answering 403 would confirm the id exists.
 */
export async function handleAcceptSharedList(
  id: string,
  req: Request,
  env: ListsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  const result = await env.DB.prepare(
    "UPDATE shared_lists SET state = 'accepted' WHERE id = ? AND recipient_id = ? AND state != 'accepted'",
  )
    .bind(id, session.userId)
    .run();
  if (result.meta?.changes) return noContent();

  // No change: either already accepted (idempotent success) or not addressed to us.
  const mine = await env.DB.prepare("SELECT id FROM shared_lists WHERE id = ? AND recipient_id = ?")
    .bind(id, session.userId)
    .first<{ id: string }>();
  return mine ? noContent() : json({ error: "not_found" }, 404);
}

/**
 * `DELETE /api/lists/shared/{id}` — decline/dismiss as the recipient, or withdraw
 * as the sender. Idempotent, and 204 even for an unknown id so it cannot be used
 * to probe which ids exist.
 */
export async function handleDeleteSharedList(
  id: string,
  req: Request,
  env: ListsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  await env.DB.prepare("DELETE FROM shared_lists WHERE id = ? AND (recipient_id = ? OR sender_id = ?)")
    .bind(id, session.userId, session.userId)
    .run();
  return noContent();
}
