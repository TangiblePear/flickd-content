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
  /**
   * Distinct reporters that auto-hide a profile picture. Optional so the report
   * handler still works in tests and on a Worker without the binding — a missing
   * bucket disables the takedown, it never fails the report.
   */
  BUCKET?: R2Bucket;
  REPORT_AUTOHIDE?: string;
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
// `feed_comment` is a friend's comment as it appears on the Friend Feed, and is
// distinct from `comment` (a D1 title/episode comment) — they are moderated through
// different admin queues, so folding them together would hide one behind the other.
const REPORT_KINDS = new Set(["user", "profile", "comment", "comment_spoiler", "feed_comment", "picture"]);
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

  // Snapshot who they were, BEFORE the friendship goes. A block record that cannot name
  // its target is unrenderable later: the local row is gone after a device wipe, and
  // `GET /api/profile/{userId}` is gated by `canView`, which fails on a blocked pair. So
  // the one thing that could name them is the one thing a block guarantees you cannot read.
  //
  // Read outside the batch and tolerated as null — a block must never fail because a name
  // lookup did. A snapshot, not a live join, so a later rename does not rewrite history.
  const who = await env.DB.prepare("SELECT display_name, avatar_id FROM profiles WHERE user_id = ?")
    .bind(target)
    .first<{ display_name: string | null; avatar_id: string | null }>()
    .catch(() => null);

  const [a, b] = friendshipKey(session.userId, target);
  await env.DB.batch([
    // OR REPLACE, not OR IGNORE: re-blocking someone should refresh the snapshot rather
    // than keep a name from the first time.
    env.DB
      .prepare(
        `INSERT INTO blocks (blocker_id, blocked_id, created_at, display_name, avatar_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(blocker_id, blocked_id) DO UPDATE SET
           display_name = excluded.display_name, avatar_id = excluded.avatar_id`,
      )
      .bind(session.userId, target, Date.now(), who?.display_name ?? null, who?.avatar_id ?? null),
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
  // `displayName` / `avatarId` are the snapshot taken at block time — the only way a
  // client that has been wiped can render this list at all. Empty for a row written before
  // migration 0011, which the client renders as an unnamed entry rather than hiding: a
  // block you cannot see is a block you cannot lift.
  const { results } = await env.DB.prepare(
    "SELECT blocked_id, created_at, display_name, avatar_id FROM blocks WHERE blocker_id = ? ORDER BY created_at DESC",
  )
    .bind(session.userId)
    .all<{ blocked_id: string; created_at: number; display_name: string | null; avatar_id: string | null }>();
  return json({
    blocked: (results ?? []).map((r) => ({
      userId: r.blocked_id,
      at: r.created_at,
      displayName: r.display_name ?? "",
      avatarId: r.avatar_id ?? "",
    })),
  });
}

// ── Reporting ────────────────────────────────────────────────────────────────

/**
 * POST /api/report `{ userId, kind, context? }` — file a moderation report.
 *
 * One open report per reporter/target/**kind**; repeats are folded in rather than
 * stacking, so a single user cannot inflate a target's report count. The kind is
 * part of that key deliberately: reporting someone's picture must not silently
 * swallow a later report about their behaviour, which is what happened while the
 * dedupe was on the pair alone.
 *
 * Replaces the relay's `POST /api/user/{friendId}/report`, which authenticated on a
 * bound read token rather than a session and keyed on the device `friendId`.
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
    "SELECT id FROM reports WHERE reporter_id = ? AND target_id = ? AND kind = ? AND state = 'open'",
  )
    .bind(session.userId, target, kind)
    .first<{ id: string }>();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO reports (id, reporter_id, target_id, kind, context, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
      .bind(newId(), session.userId, target, kind, context, Date.now())
      .run();
  }

  if (kind === "picture") await maybeAutoHidePicture(env, target);
  return noContent();
}

/**
 * Hide a profile picture once enough **distinct** reporters have flagged it.
 *
 * Ported from the relay handler this replaced. It is the only automatic takedown in
 * the system, so losing it in the migration would have quietly removed an abuse
 * control rather than dead code.
 *
 * ⚠️ **Writes BOTH tombstones.** A picture is now reachable by two routes — the
 * account-keyed `/api/profile/{userId}/picture` and the legacy
 * `/api/user/{friendId}/picture` — and each checks its own key. Writing one and not
 * the other leaves the image up on the other route, which is this abuse control
 * silently not working rather than a cosmetic inconsistency. The legacy write goes
 * when the legacy route goes, not before.
 *
 * Best-effort by design: a Worker with no bucket means no takedown — but the report
 * itself is already recorded, and failing the request would lose the report to keep a
 * picture up. A target with no claimed `friend_id` is no longer an obstacle: the
 * account-keyed tombstone does not need one, so those accounts are now coverable too.
 */
async function maybeAutoHidePicture(env: FriendsEnv, targetUserId: string): Promise<void> {
  const bucket = env.BUCKET;
  if (!bucket) return;
  const threshold = Number(env.REPORT_AUTOHIDE ?? "3");
  if (!Number.isFinite(threshold) || threshold <= 0) return;

  // COUNT(DISTINCT ...) in SQL rather than listing rows: D1 bills rows SCANNED, and
  // idx_reports_pair covers this.
  const row = await env.DB.prepare(
    "SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_id = ? AND kind = 'picture' AND state = 'open'",
  )
    .bind(targetUserId)
    .first<{ n: number }>();
  if (!row || row.n < threshold) return;

  const body = JSON.stringify({ reason: "auto_report_threshold", at: Date.now() });
  const opts = { httpMetadata: { contentType: "application/json" } };
  await bucket.put(`_moderation/u/${targetUserId}.json`, body, opts);

  const owner = await env.DB.prepare("SELECT friend_id FROM users WHERE id = ?")
    .bind(targetUserId)
    .first<{ friend_id: string | null }>();
  if (owner?.friend_id) await bucket.put(`_moderation/${owner.friend_id}.json`, body, opts);
}

// ── Bridging the existing device-identity pairings ───────────────────────────

/**
 * PUT /api/me/friend-id `{ friendId }` — claim this account's device friendId.
 *
 * Existing friendships live only on devices, keyed by that id. Claiming it is what
 * turned old pairings into real rows before that endpoint was retired. Idempotent, and
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

// ── Friend cards (pairing off the E2EE inbox) ────────────────────────────────

/**
 * Fetch the published friend card for a device friendId, or null.
 *
 * Injected rather than imported so this module stays D1-only and therefore
 * testable without a bucket — the same reason `sync.ts` takes a `RelayLoader`.
 * Cards live in R2 and are written by the device that owns them.
 */
/**
 * [friendCode] is the account-keyed lookup and is preferred; [friendId] is the legacy
 * pointer, used only for an account that has not republished its card since the code
 * moved into D1. The second argument goes at step 8.
 */
export type CardLoader = (friendCode: string | null, friendId: string) => Promise<PublicCard | null>;

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

/**
 * A card plus the fields that come from D1 rather than the R2 blob.
 *
 * [friendTopic] is how a friend learns which FCM topic to subscribe to for this
 * person's ambient updates. It used to travel **sealed inside `access.json`**, wrapped
 * to each friend's public keyset — which is why step 2 could move the push *write* onto
 * the account without noticing the *distribution* was somewhere else entirely.
 *
 * The two topics are asymmetric, and that is what hid the gap: `selfTopic` is subscribed
 * only by the owner's own devices, which derive it from `socialSelfKey` and need no
 * handout at all. `friendTopic` has to reach other people.
 *
 * No new exposure to the server: `users.push_friend_topic` has been a plaintext column
 * since step 2. This only hands it to accepted friends, who are the intended audience,
 * and it rides the `users` query this handler already runs.
 */
export type FriendCardWithTopic = PublicCard & { userId: string; friendTopic: string };

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
  // ⚠️ `AND friend_id IS NOT NULL` was here and is gone (9a). It made an account that
  // never claimed a device friendId INVISIBLE to its own friends: no card came back, so
  // `applyServerGraph` dropped the edge at `cards[userId] ?? continue` and an accepted
  // friendship on both sides rendered as nothing, with no error anywhere. Measured
  // 2026-07-30: 1 of 5 active accounts was in exactly that state. The column is on its
  // way out (8c-3) and was never what authorised the card — the friendship edge is.
  const { results } = await env.DB.prepare(
    `SELECT id, friend_id, friend_code, push_friend_topic FROM users
      WHERE id IN (${placeholders}) AND status = 'active'`,
  )
    .bind(...allowed)
    .all<{ id: string; friend_id: string; friend_code: string | null; push_friend_topic: string | null }>();

  const cards: FriendCardWithTopic[] = [];
  for (const row of results ?? []) {
    if (await isBlockedEitherWay(env, session.userId, row.id)) continue;
    // The code rides the query above, so the common path costs no extra read.
    const card = await loadCard(row.friend_code ?? null, row.friend_id);
    // A card whose friendId disagrees with the claimed one is not this user's, and
    // `users.friend_id` is the claim-checked side — trust it over the R2 blob.
    if (!card || card.friendId !== row.friend_id) continue;
    cards.push({ userId: row.id, ...card, friendTopic: row.push_friend_topic ?? "" });
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

  // The account-keyed objects that live in R2, not D1, so the batch below cannot reach
  // them. Done BEFORE the batch: once the `users` row is gone, nothing can name them —
  // the friend code in particular is only findable through that row — and they become
  // unreachable data no erasure can ever collect.
  if (env.BUCKET) {
    await env.BUCKET.delete(`accounts/${id}/picture.jpg`);
    await env.BUCKET.delete(`accounts/${id}/picture-meta.json`);
    await env.BUCKET.delete(`_moderation/u/${id}.json`);
    // The public friend card. Leaving it behind keeps a deleted person's name, avatar
    // and picture URL resolvable by anyone still holding their code.
    const own = await env.DB.prepare("SELECT friend_code FROM users WHERE id = ?")
      .bind(id)
      .first<{ friend_code: string | null }>();
    if (own?.friend_code) await env.BUCKET.delete(`fc/${own.friend_code}.json`);
  }

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
    // Comments, and the three tables hanging off them. Order matters: the
    // children go first, because once `comments` is gone nothing can name the
    // rows that pointed at it and they become unreachable data no erasure can
    // ever reach.
    //
    // Reactions are deleted in BOTH directions — the reactions you made on other
    // people's comments are your data too, and their counts have to come down
    // with them or every comment you ever reacted to keeps an inflated number.
    env.DB
      .prepare(
        `UPDATE comment_reaction_counts SET n = MAX(n - 1, 0)
          WHERE (comment_id, emoji) IN
            (SELECT comment_id, emoji FROM comment_reactions WHERE user_id = ?)`,
      )
      .bind(id),
    env.DB.prepare("DELETE FROM comment_reactions WHERE user_id = ?").bind(id),
    env.DB
      .prepare("DELETE FROM comment_reactions WHERE comment_id IN (SELECT id FROM comments WHERE author_id = ?)")
      .bind(id),
    env.DB
      .prepare("DELETE FROM comment_reaction_counts WHERE comment_id IN (SELECT id FROM comments WHERE author_id = ?)")
      .bind(id),
    env.DB
      .prepare("DELETE FROM comment_translations WHERE comment_id IN (SELECT id FROM comments WHERE author_id = ?)")
      .bind(id),
    // The public counters the deleted comments were contributing to, before the
    // rows they are derived from go away and the delta can no longer be computed.
    env.DB
      .prepare(
        `UPDATE comment_counts SET n_public = MAX(n_public - (
           SELECT COUNT(*) FROM comments c
            WHERE c.author_id = ? AND c.visibility = 'public'
              AND c.hidden_at IS NULL AND c.deleted_at IS NULL
              AND (c.body <> '' OR c.media_id IS NOT NULL)
              AND c.tmdb_id = comment_counts.tmdb_id AND c.media_type = comment_counts.media_type
              AND c.season = comment_counts.season AND c.episode = comment_counts.episode
         ), 0)
         WHERE (tmdb_id, media_type, season, episode) IN
           (SELECT tmdb_id, media_type, season, episode FROM comments WHERE author_id = ?)`,
      )
      .bind(id, id),
    env.DB.prepare("DELETE FROM comments WHERE author_id = ?").bind(id),
    // Episode poll votes. This row is the ONLY thing linking a person to what they
    // voted, so removing it is what makes the vote anonymous rather than merely
    // unattributed.
    //
    // ⚠️ `episode_vote_counts` and `episode_option_counts` are deliberately NOT
    // adjusted. They hold nothing but numbers — no user id, no way back to a person —
    // so they are not this account's data to erase, and unpicking them would mean one
    // statement per episode this user ever voted on, unbounded, inside a batch that has
    // to stay transactional. The privacy policy says this plainly rather than implying
    // the totals are recalculated.
    env.DB.prepare("DELETE FROM episode_votes WHERE user_id = ?").bind(id),
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
