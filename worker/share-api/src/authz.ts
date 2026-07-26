// ── Profile authorization (Phase 2) ──────────────────────────────────────────
// ONE function decides who may read a profile, and every profile read must go
// through it. There is no row-level security here, so a handler that forgets to
// ask FAILS OPEN — that is the failure mode to design against, which is why
// `readViewableProfile` in profile.ts takes the viewer and does the check itself
// rather than leaving it to each caller.
//
// Never let the caller distinguish "you may not see this" from "this does not
// exist": both must produce an identical response, or the API becomes an oracle
// for which accounts exist and who has blocked whom.

export interface AuthzEnv {
  DB: D1Database;
}

export type Visibility = "private" | "friends" | "public";

/** Lenient parse — an unrecognised stored value must never widen access. */
export function parseVisibility(raw: string | null | undefined): Visibility {
  return raw === "public" || raw === "private" ? raw : "friends";
}

/** Canonical friendship key. One row per relationship, so "are these two friends" is a PK hit. */
export function friendshipKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * True when either party has blocked the other. Checked **first** and in **both
 * directions** on every read: a blocked user must neither see nor be seen. Getting
 * this ordering wrong is the single most common way these systems leak.
 */
export async function isBlockedEitherWay(env: AuthzEnv, viewerId: string, ownerId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS hit FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1",
  )
    .bind(ownerId, viewerId, viewerId, ownerId)
    .first<{ hit: number }>();
  return row != null;
}

/** True when an accepted friendship exists. `pending` is deliberately NOT enough. */
export async function areFriends(env: AuthzEnv, a: string, b: string): Promise<boolean> {
  const [userA, userB] = friendshipKey(a, b);
  const row = await env.DB.prepare(
    "SELECT state FROM friendships WHERE user_a = ? AND user_b = ? AND state = 'accepted' LIMIT 1",
  )
    .bind(userA, userB)
    .first<{ state: string }>();
  return row != null;
}

/**
 * May [viewerId] read [ownerId]'s profile at [visibility]?
 *
 * ```
 * blocked either way        → DENY   (always evaluated first)
 * viewer is the owner       → ALLOW
 * visibility = public       → ALLOW
 * visibility = friends      → ALLOW iff an accepted friendship exists
 * otherwise (private)       → DENY
 * ```
 *
 * Cost for a foreign profile: one indexed read for the block pair, one for the
 * friendship — plus the profile row itself. Self and public reads skip the
 * friendship lookup; a self read skips both.
 */
export async function canView(
  env: AuthzEnv,
  viewerId: string,
  ownerId: string,
  visibility: Visibility,
): Promise<boolean> {
  // Own profile is always readable, and a self-block is meaningless — check it
  // before touching the database so the owner path costs nothing.
  if (viewerId === ownerId) return true;
  if (await isBlockedEitherWay(env, viewerId, ownerId)) return false;
  if (visibility === "public") return true;
  if (visibility === "friends") return areFriends(env, viewerId, ownerId);
  return false;
}
