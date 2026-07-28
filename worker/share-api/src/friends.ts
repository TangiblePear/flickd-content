// ── Friendships, blocks and reports (Phase 3/4) ──────────────────────────────
// Friendships move server-side, which is what finally makes blocking real. Until
// now a block only took effect when the blocker's device next rotated its keys —
// never, if that device stayed offline — so a blocked user kept the read access
// they already held. Here a block is enforced on the next request, by canView().
//
// Two rules shape almost every handler below:
//
//   1. NEVER reveal a block. A blocked user must not be able to tell the
//      difference between "you are blocked" and "nothing happened". Requests to a
//      blocking user therefore report success and quietly do nothing, and reads
//      return the same 404 a missing account would.
//   2. Friendship rows are canonical (`user_a < user_b`), so a relationship is one
//      row and "are these two friends" is a primary-key hit rather than a scan.

import { areFriends, friendshipKey, isBlockedEitherWay } from "./authz";
import { resolveSession } from "./auth";

export interface FriendsEnv {
  DB: D1Database;
  FIREBASE_PROJECT_ID?: string;
  FRIEND_REQUESTS_PER_HOUR?: string;
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
const FRIEND_ID_RE = /^[A-Z0-9]{12,40}$/;
const MAX_REPORT_CONTEXT = 1000;
const MAX_LEGACY_FRIEND_IDS = 200;
const REPORT_KINDS = new Set(["user", "profile", "comment", "picture"]);
const DEFAULT_REQUESTS_PER_HOUR = 20;

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

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Authenticate, or null. Every handler here starts with this. */
async function requireSession(req: Request, env: FriendsEnv, ctx?: ExecutionContext) {
  return resolveSession(req, env as any, ctx);
}

// ── Friend list ──────────────────────────────────────────────────────────────

interface FriendshipRow {
  user_a: string;
  user_b: string;
  state: string;
  requested_by: string;
  updated_at: number;
}

/**
 * Every friendship touching [userId], split into accepted / incoming / outgoing.
 * Two indexed reads (one per side of the canonical key), never a scan.
 */
export async function loadFriendships(env: FriendsEnv, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT user_a, user_b, state, requested_by, updated_at FROM friendships
      WHERE user_a = ? OR user_b = ?`,
  )
    .bind(userId, userId)
    .all<FriendshipRow>();

  const accepted: string[] = [];
  const incoming: string[] = [];
  const outgoing: string[] = [];
  for (const row of results ?? []) {
    const other = row.user_a === userId ? row.user_b : row.user_a;
    if (row.state === "accepted") accepted.push(other);
    else if (row.requested_by === userId) outgoing.push(other);
    else incoming.push(other);
  }
  return { accepted, incoming, outgoing };
}

/** GET /api/friends — accepted friends plus pending in both directions. */
export async function handleGetFriends(req: Request, env: FriendsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  return json(await loadFriendships(env, session.userId));
}

// ── Requesting and accepting ─────────────────────────────────────────────────

/** Per-sender hourly cap. Rate limiting a *friend request* is an anti-harassment control. */
async function requestRateLimited(env: FriendsEnv, userId: string): Promise<boolean> {
  const limit = Number(env.FRIEND_REQUESTS_PER_HOUR ?? DEFAULT_REQUESTS_PER_HOUR);
  if (limit <= 0) return false;
  const since = Date.now() - 3600_000;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM friendships WHERE requested_by = ? AND created_at > ?",
  )
    .bind(userId, since)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= limit;
}

/**
 * POST /api/friends/request `{ userId }`.
 *
 * Accepting an existing incoming request is folded in here: if they already asked
 * you, asking back is an accept. Returns `{ state }` so the client knows which
 * happened.
 *
 * **A request to someone who has blocked you reports success and does nothing** —
 * anything else turns this endpoint into a block detector.
 */
export async function handleFriendRequest(
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
  notify?: (userId: string) => void,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const payload = await body(req);
  const target = typeof payload?.userId === "string" ? payload.userId : "";
  if (!USER_ID_RE.test(target)) return json({ error: "invalid_payload" }, 400);
  if (target === session.userId) return json({ error: "invalid_payload" }, 400);

  // Silent no-op, deliberately indistinguishable from a delivered request.
  if (await isBlockedEitherWay(env, session.userId, target)) return json({ state: "pending" });

  const exists = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'")
    .bind(target)
    .first<{ id: string }>();
  if (!exists) return json({ error: "not_found" }, 404);

  const [a, b] = friendshipKey(session.userId, target);
  const current = await env.DB.prepare(
    "SELECT state, requested_by FROM friendships WHERE user_a = ? AND user_b = ?",
  )
    .bind(a, b)
    .first<{ state: string; requested_by: string }>();

  const now = Date.now();
  if (current?.state === "accepted") return json({ state: "accepted" });
  if (current?.state === "pending") {
    // They asked first — this is an accept. Asking again ourselves is a no-op.
    if (current.requested_by === session.userId) return json({ state: "pending" });
    await env.DB.prepare(
      "UPDATE friendships SET state = 'accepted', updated_at = ? WHERE user_a = ? AND user_b = ?",
    )
      .bind(now, a, b)
      .run();
    // They have been waiting on an answer since they asked.
    notify?.(target);
    return json({ state: "accepted" });
  }

  if (await requestRateLimited(env, session.userId)) return json({ error: "rate_limited" }, 429);
  await env.DB.prepare(
    `INSERT INTO friendships (user_a, user_b, state, requested_by, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(a, b, session.userId, now, now)
    .run();
  // **Wake the target, or nothing tells them a request exists.** Until pairing left the
  // E2EE inbox (2026-07-28) the sealed FRIEND_REQUEST did this as a side effect of
  // `handlePostInbox`. Deleting that send took the wake-up with it, and the request sat
  // in D1, correct and invisible, until the recipient's next scheduled sync — measured
  // on device the same day. The identical mistake was made with shared lists on
  // 2026-07-27; see the FCM note in `docs/agent-map/android/16-feature-social.md`.
  notify?.(target);
  return json({ state: "pending" });
}

/**
 * POST /api/friends/accept `{ userId }` — accept an incoming request.
 * 404 unless a pending request from that user actually exists, so this cannot be
 * used to force a friendship or to probe for one.
 */
export async function handleFriendAccept(
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
  notify?: (userId: string) => void,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const payload = await body(req);
  const target = typeof payload?.userId === "string" ? payload.userId : "";
  if (!USER_ID_RE.test(target)) return json({ error: "invalid_payload" }, 400);
  if (await isBlockedEitherWay(env, session.userId, target)) return json({ error: "not_found" }, 404);

  const [a, b] = friendshipKey(session.userId, target);
  const result = await env.DB.prepare(
    `UPDATE friendships SET state = 'accepted', updated_at = ?
      WHERE user_a = ? AND user_b = ? AND state = 'pending' AND requested_by = ?`,
  )
    .bind(Date.now(), a, b, target)
    .run();
  if (!result.meta?.changes) return json({ error: "not_found" }, 404);
  // Only on a real transition — `changes` is 0 for a repeat accept, and notifying then
  // would re-wake the requester on every retry.
  notify?.(target);
  return json({ state: "accepted" });
}

/** DELETE /api/friends/{userId} — unfriend, or withdraw/decline a pending request. Idempotent. */
export async function handleFriendRemove(
  target: string,
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
  notify?: (userId: string) => void,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!USER_ID_RE.test(target)) return noContent();
  const [a, b] = friendshipKey(session.userId, target);
  const res = await env.DB.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(a, b).run();
  if (res.meta?.changes) notify?.(target);
  return noContent();
}

/**
 * DELETE /api/friends/by-friend/{friendId} — the same removal, addressed by the
 * **device friendId** the client actually holds.
 *
 * `DELETE /api/friends/{userId}` needs the caller to already know the other side's
 * account id, which it learns from a cache populated by `link-legacy` and card
 * lookups. On device 2026-07-28 that cache was cold at the moment of the unfriend,
 * the client gave up silently, and the friendship survived on the server — which
 * then resurrected it locally and made a later re-add resolve straight to
 * `accepted`. Removal must not depend on a warm cache.
 *
 * Safe to expose: this only ever deletes an edge **the caller is part of**, and it
 * answers `204` whether or not anything matched, so it reveals nothing about
 * whether a given friendId has an account.
 */
export async function handleFriendRemoveByFriendId(
  friendId: string,
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
  notify?: (userId: string) => void,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!FRIEND_ID_RE.test(friendId)) return noContent();

  const other = await env.DB.prepare("SELECT id FROM users WHERE friend_id = ?")
    .bind(friendId)
    .first<{ id: string }>();
  if (!other || other.id === session.userId) return noContent();

  const [a, b] = friendshipKey(session.userId, other.id);
  const res = await env.DB.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(a, b).run();
  // Tell the other side, or they keep showing a friend who has removed them until
  // some unrelated sync happens -- up to 24h, since the client only converges the
  // graph inside SocialSyncWorker and nothing else was waking it. Measured on device
  // 2026-07-28: the removal was correct server-side and simply never arrived.
  // Only on an actual delete, so a repeated DELETE cannot be used to spam someone.
  if (res.meta?.changes) notify?.(other.id);
  return noContent();
}

// ── Blocking ─────────────────────────────────────────────────────────────────

/**
 * POST /api/blocks/{userId} — block, and drop any friendship in the same batch.
 *
 * This is the fix for the live safety gap: blocking used to be client-side and
 * eventually-consistent, so it only bit once the blocker's device rotated keys.
 * Now `canView` denies on the very next request, in both directions.
 */
export async function handleBlock(
  target: string,
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!USER_ID_RE.test(target) || target === session.userId) return json({ error: "invalid_payload" }, 400);

  const [a, b] = friendshipKey(session.userId, target);
  await env.DB.batch([
    env.DB
      .prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)")
      .bind(session.userId, target, Date.now()),
    env.DB.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(a, b),
  ]);
  return noContent();
}

/** DELETE /api/blocks/{userId} — unblock. Does NOT restore the friendship; that must be re-made. */
export async function handleUnblock(
  target: string,
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  await env.DB.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?")
    .bind(session.userId, target)
    .run();
  return noContent();
}

/** GET /api/blocks — who I have blocked. Never reveals who has blocked *me*. */
export async function handleGetBlocks(req: Request, env: FriendsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const { results } = await env.DB.prepare(
    "SELECT blocked_id, created_at FROM blocks WHERE blocker_id = ? ORDER BY created_at DESC",
  )
    .bind(session.userId)
    .all<{ blocked_id: string; created_at: number }>();
  return json({ blocked: (results ?? []).map((r) => ({ userId: r.blocked_id, at: r.created_at })) });
}

// ── Reporting ────────────────────────────────────────────────────────────────

/**
 * POST /api/report `{ userId, kind, context? }` — file a moderation report.
 * One open report per reporter/target pair; repeats are folded in rather than
 * stacking, so a single user cannot inflate a target's report count.
 */
export async function handleReport(req: Request, env: FriendsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const payload = await body(req);
  const target = typeof payload?.userId === "string" ? payload.userId : "";
  const kind = typeof payload?.kind === "string" ? payload.kind : "user";
  if (!USER_ID_RE.test(target) || target === session.userId) return json({ error: "invalid_payload" }, 400);
  if (!REPORT_KINDS.has(kind)) return json({ error: "invalid_payload" }, 400);
  const context =
    typeof payload?.context === "string" ? payload.context.trim().slice(0, MAX_REPORT_CONTEXT) : null;

  const existing = await env.DB.prepare(
    "SELECT id FROM reports WHERE reporter_id = ? AND target_id = ? AND state = 'open'",
  )
    .bind(session.userId, target)
    .first<{ id: string }>();
  if (existing) return noContent();

  await env.DB.prepare(
    `INSERT INTO reports (id, reporter_id, target_id, kind, context, state, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  )
    .bind(newId(), session.userId, target, kind, context, Date.now())
    .run();
  return noContent();
}

// ── Bridging the existing device-identity pairings ───────────────────────────

/**
 * PUT /api/me/friend-id `{ friendId }` — claim this account's device friendId.
 *
 * Existing friendships live only on devices, keyed by that id. Claiming it is what
 * lets [handleLinkLegacyFriends] turn old pairings into real rows. Idempotent, and
 * refuses to steal an id already claimed by a different account.
 */
export async function handleClaimFriendId(req: Request, env: FriendsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const payload = await body(req);
  const friendId = typeof payload?.friendId === "string" ? payload.friendId : "";
  if (!FRIEND_ID_RE.test(friendId)) return json({ error: "invalid_payload" }, 400);

  const owner = await env.DB.prepare("SELECT id FROM users WHERE friend_id = ?")
    .bind(friendId)
    .first<{ id: string }>();
  if (owner && owner.id !== session.userId) return json({ error: "conflict" }, 409);
  if (!owner) {
    await env.DB.prepare("UPDATE users SET friend_id = ? WHERE id = ?").bind(friendId, session.userId).run();
  }
  return json({ friendId });
}

/**
 * POST /api/friends/link-legacy `{ friendIds: [...] }` — migration step.
 *
 * The client posts the device friendIds it is already paired with; any that belong
 * to an account become **accepted** friendships (the pairing was already mutually
 * agreed on the old system, so re-confirming would be a regression for the user).
 * Ids with no account yet are simply skipped and stay device-local until that
 * person signs in. Blocked pairs are never linked.
 */
export async function handleLinkLegacyFriends(
  req: Request,
  env: FriendsEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const payload = await body(req);
  const raw = Array.isArray(payload?.friendIds) ? payload!.friendIds : null;
  if (!raw) return json({ error: "invalid_payload" }, 400);

  const ids = raw
    .filter((v): v is string => typeof v === "string" && FRIEND_ID_RE.test(v))
    .slice(0, MAX_LEGACY_FRIEND_IDS);
  if (ids.length === 0) return json({ linked: 0, pendingSignup: 0, mapping: [] });

  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, friend_id FROM users WHERE friend_id IN (${placeholders}) AND status = 'active'`,
  )
    .bind(...ids)
    .all<{ id: string; friend_id: string }>();

  const now = Date.now();
  const statements = [];
  // The caller needs this: it knows its friends by device friendId, but every
  // server-side operation (blocks, profile reads) keys on users.id. Without
  // returning the pairs, the client can never address a friend server-side, and
  // there is deliberately no friendId -> userId lookup endpoint — that would let
  // anyone probe whether a given friendId has an account.
  const mapping: { friendId: string; userId: string }[] = [];
  let linked = 0;
  for (const row of results ?? []) {
    if (row.id === session.userId) continue;
    if (await isBlockedEitherWay(env, session.userId, row.id)) continue;
    mapping.push({ friendId: row.friend_id, userId: row.id });
    const [a, b] = friendshipKey(session.userId, row.id);
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO friendships (user_a, user_b, state, requested_by, created_at, updated_at)
           VALUES (?, ?, 'accepted', ?, ?, ?)
           ON CONFLICT(user_a, user_b) DO UPDATE SET state = 'accepted', updated_at = excluded.updated_at`,
        )
        .bind(a, b, session.userId, now, now),
    );
    linked++;
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return json({ linked, pendingSignup: ids.length - linked, mapping });
}

// ── Friend cards (pairing off the E2EE inbox) ────────────────────────────────

/**
 * Fetch the published friend card for a device friendId, or null.
 *
 * Injected rather than imported so this module stays D1-only and therefore
 * testable without a bucket — the same reason `sync.ts` takes a `RelayLoader`.
 * Cards live in R2 and are written by the device that owns them.
 */
export type CardLoader = (friendId: string) => Promise<PublicCard | null>;

/**
 * Exactly the fields a local friend row needs, and nothing else.
 *
 * This is the same data `GET /api/friendcode/{code}` already hands to anyone
 * holding the code, `feedReadToken` included — that token is the owner's
 * rotatable feed-read capability and living in the published card is what makes
 * pairing work at all. An explicit allow-list rather than a pass-through,
 * because the stored card is client-written.
 */
export interface PublicCard {
  friendId: string;
  displayName: string;
  avatarId: string;
  borderId: string;
  pictureUrl: string;
  publicKeyset: string;
  feedReadToken: string;
}

const MAX_CARD_LOOKUPS = 25;

/**
 * POST /api/friends/cards `{ userIds: [...] }` — the public cards for people you
 * already have a friendship edge with.
 *
 * This is what lets pairing leave the E2EE inbox. `GET /api/friends` answers with
 * bare `users.id` values, and a local friend row needs a display name, an avatar and
 * above all a **public keyset** — everything E2EE is sealed to it. Without this the
 * client can see that it has an incoming request but can neither render nor answer it.
 *
 * **Edge-gated, and that is the whole security argument.** A card is already public
 * to anyone holding its friend *code*, which is a capability the owner chose to hand
 * out. A `users.id` is not — it appears in feeds and graphs. Serving cards by id
 * without requiring an edge would turn every signed-in session into a card-enumeration
 * oracle over the whole user base. Blocked pairs are excluded for the same reason
 * everything else here excludes them.
 *
 * Unknown ids, ids with no edge, and users who have never published a card are all
 * **omitted silently** rather than erroring: distinguishing them would answer
 * "does this account exist" for an arbitrary id, which is rule 1 of this file.
 */
export async function handleGetFriendCards(
  req: Request,
  env: FriendsEnv,
  loadCard: CardLoader,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const payload = await body(req);
  const raw = Array.isArray(payload?.userIds) ? payload!.userIds : null;
  if (!raw) return json({ error: "invalid_payload" }, 400);

  const wanted = [...new Set(raw.filter((v): v is string => typeof v === "string" && USER_ID_RE.test(v)))]
    .filter((id) => id !== session.userId)
    .slice(0, MAX_CARD_LOOKUPS);
  if (wanted.length === 0) return json({ cards: [] });

  // One query for the edges, one for the friendIds — never one round trip per id.
  const { accepted, incoming, outgoing } = await loadFriendships(env, session.userId);
  const related = new Set([...accepted, ...incoming, ...outgoing]);
  const allowed = wanted.filter((id) => related.has(id));
  if (allowed.length === 0) return json({ cards: [] });

  const placeholders = allowed.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, friend_id FROM users
      WHERE id IN (${placeholders}) AND status = 'active' AND friend_id IS NOT NULL`,
  )
    .bind(...allowed)
    .all<{ id: string; friend_id: string }>();

  const cards: (PublicCard & { userId: string })[] = [];
  for (const row of results ?? []) {
    if (await isBlockedEitherWay(env, session.userId, row.id)) continue;
    const card = await loadCard(row.friend_id);
    // A card whose friendId disagrees with the claimed one is not this user's, and
    // `users.friend_id` is the claim-checked side — trust it over the R2 blob.
    if (!card || card.friendId !== row.friend_id) continue;
    cards.push({ userId: row.id, ...card });
  }
  return json({ cards });
}

// ── Account deletion (§9b — legal requirement) ───────────────────────────────

/**
 * DELETE /api/me/account — erase the account from D1.
 *
 * Children before parents, so a failure part-way leaves the account recoverable
 * rather than orphaned. GDPR erasure has to actually erase: a stale `users` row
 * with a live `friendships` edge is a failure, not a partial success.
 *
 * **Every table holding this user's data must appear below.** A new table that does
 * not is a silent compliance gap — nothing fails, nothing logs, and the data simply
 * survives an erasure the user was told had happened. `shared_lists`, `match_requests`
 * and `match_payloads` were exactly that until they were added here.
 *
 * The caller is still responsible for the Firebase Auth user and the relay purge —
 * both live outside D1, and both must happen after this returns.
 */
export async function handleDeleteAccount(req: Request, env: FriendsEnv, ctx?: ExecutionContext): Promise<Response> {
  const session = await requireSession(req, env, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);
  const id = session.userId;
  await env.DB.batch([
    // Sealed match payloads first: they are children of match_requests, and a blob
    // outliving the handshake that addressed it is unreachable data nobody can delete.
    env.DB
      .prepare(
        `DELETE FROM match_payloads WHERE request_id IN
           (SELECT id FROM match_requests WHERE requester_id = ? OR target_id = ?)`,
      )
      .bind(id, id),
    env.DB.prepare("DELETE FROM match_requests WHERE requester_id = ? OR target_id = ?").bind(id, id),
    // Both directions. A list you sent is as much your data as one you received, and
    // leaving the sender's copy behind would keep your content readable after erasure.
    env.DB.prepare("DELETE FROM shared_lists WHERE sender_id = ? OR recipient_id = ?").bind(id, id),
    // Your activity feed. Erasing the account while leaving these would keep every
    // title you watched readable by anyone still friends with the deleted row.
    env.DB.prepare("DELETE FROM feed_events WHERE author_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?").bind(id, id),
    env.DB.prepare("DELETE FROM friendships WHERE user_a = ? OR user_b = ?").bind(id, id),
    env.DB.prepare("DELETE FROM reports WHERE reporter_id = ?").bind(id),
    env.DB.prepare("DELETE FROM profile_stats WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM profiles WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM identities WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  return noContent();
}

export { areFriends };
