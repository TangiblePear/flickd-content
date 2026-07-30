// ── Posting suspension ───────────────────────────────────────────────────────
// A moderator can stop someone POSTING without touching anything else they do.
// Browsing, syncing, friends, watching, lists, poll votes and reading all keep
// working; comments, profile pictures and profile text do not.
//
// ⚠️ This is deliberately NOT `users.status`. That column is checked at auth.ts:289,
// friends.ts:165, friends.ts:494 and friends.ts:606, and every one treats a
// non-'active' value as "no such person" — no sign-in, no friend requests, absent
// from friend cards. Reusing it would have made every suspension a full account
// lockout plus social erasure.
//
// Because the check runs per gated WRITE against live D1 rather than at session
// resolution, a suspension bites within one request and needs no session revocation.
// `resolveSession` never re-reads `users`, so a status-based ban would have gone
// unnoticed for up to the 90-day session lifetime; and revoking sessions would sign
// someone out of a product they are still allowed to use.

/** 2100-01-01T00:00:00Z. "Permanent", expressed so one `>` covers every case. */
export const PERMANENT_UNTIL = 4_102_444_800_000;

/**
 * The four durations the panel offers, in ms. `0` means permanent.
 *
 * An allow-list rather than a range: the panel is the only caller, these are the only
 * four buttons, and validating against the list turns a malformed request into a 400
 * instead of an arbitrary-length ban.
 */
export const SUSPEND_DURATIONS: readonly number[] = [86_400_000, 604_800_000, 2_592_000_000, 0];

/** A preset duration → the absolute deadline to store. `null` if not a preset. */
export function suspensionUntil(durationMs: number): number | null {
  if (!SUSPEND_DURATIONS.includes(durationMs)) return null;
  return durationMs === 0 ? PERMANENT_UNTIL : Date.now() + durationMs;
}

/**
 * Remaining posting suspension for [userId] as an epoch-ms deadline, or 0.
 *
 * ⚠️ **Fails OPEN.** A D1 error returns 0 — "not suspended" — because a lookup failure
 * that blocked every post in the product would be a far worse outage than a suspended
 * person getting one comment through. Same reasoning as `minSocialVersion`: the unsafe
 * default is the restrictive one.
 *
 * An elapsed deadline returns 0 with no sweep or cron: the comparison is against now,
 * so a suspension expires by arithmetic rather than by a second mechanism that could
 * itself fail.
 */
export async function postingSuspendedUntil(db: D1Database, userId: string): Promise<number> {
  return lookup(db, "SELECT posting_suspended_until AS until FROM users WHERE id = ?", userId);
}

async function lookup(db: D1Database, sql: string, key: string): Promise<number> {
  try {
    const row = await db.prepare(sql).bind(key).first<{ until: number | null }>();
    const until = row?.until ?? 0;
    return until > Date.now() ? until : 0;
  } catch {
    return 0;
  }
}

/**
 * The 403 body every gated write returns.
 *
 * `until` travels so the client can name the date rather than saying "later", and the
 * error string is stable so the client branches on it instead of on the status code —
 * 403 alone is ambiguous with every other refusal.
 */
export const suspendedBody = (until: number) => ({ error: "posting_suspended", until });
