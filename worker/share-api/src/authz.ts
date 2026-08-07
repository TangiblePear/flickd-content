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
 * Why a viewer may read a profile — `null` when they may not.
 *
 * A boolean is not enough once profiles can be public: the layout and stats served
 * depend on *which* rule granted access, not merely that one did.
 */
export type ViewGrant = "owner" | "friend" | "public" | null;

/**
 * May [viewerId] read [ownerId]'s profile at [visibility], and on what grounds?
 *
 * ```
 * blocked either way        → null      (always evaluated first)
 * viewer is the owner       → "owner"
 * accepted friendship       → "friend"  (on a friends OR public profile)
 * visibility = public       → "public"
 * otherwise (private)       → null
 * ```
 *
 * **The friendship is checked before `public`** so a friend reading a public profile
 * grants "friend" and keeps the richer friend-scoped layout, rather than being
 * downgraded to the stranger view.
 *
 * Cost for a foreign profile: one indexed read for the block pair, one for the
 * friendship — plus the profile row itself. A self read skips both; a private
 * profile skips the friendship lookup.
 */
/**
 * May a viewer with NO session read a profile at [visibility]?
 *
 * The signed-out case for `flickto.app/u/{userId}`. It lives here, beside [canView],
 * because the rule at the top of this file is that one place decides who may read a
 * profile — an anonymous branch that made its own decision inline would be the second
 * place, and the one nobody re-reads when the rules change.
 *
 * ```
 * visibility = public  → "public"
 * otherwise            → null
 * ```
 *
 * **There is no block check, because there is no viewer to check.** A public profile is
 * readable by anyone holding the link, so someone who has been blocked can sign out and
 * read it. That is a consequence of publishing profiles to the open web, not an
 * oversight: with no session there is no identity to match against `blocks`. Blocking
 * still holds everywhere a session exists. The privacy policy says so in as many words —
 * if that ever stops being true, fix the policy, not this comment.
 *
 * Synchronous, and deliberately so: it touches no tables, which is also why an anonymous
 * read costs one query (the profile row) rather than three.
 */
export function canViewAnonymous(visibility: Visibility): ViewGrant {
  return visibility === "public" ? "public" : null;
}

export async function canView(
  env: AuthzEnv,
  viewerId: string,
  ownerId: string,
  visibility: Visibility,
): Promise<ViewGrant> {
  // Own profile is always readable, and a self-block is meaningless — check it
  // before touching the database so the owner path costs nothing.
  if (viewerId === ownerId) return "owner";
  if (await isBlockedEitherWay(env, viewerId, ownerId)) return null;
  // A private profile reaches nobody but its owner, so there is nothing to look up.
  if (visibility === "private") return null;
  if (await areFriends(env, viewerId, ownerId)) return "friend";
  return visibility === "public" ? "public" : null;
}
