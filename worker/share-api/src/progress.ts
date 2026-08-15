/**
 * Friend-visible watch-progress digests.
 *
 * A friend's detail page needs to answer "has Alex finished this show, or what episode are
 * they on?". The 30-day feed cannot: it holds *events*, so anything watched earlier is
 * invisible and "completed" is unknowable. The private history document can, but it is the
 * user's entire viewing history and must never be served to anyone else.
 *
 * So this is a third object: a small per-user digest derived from the history document,
 * carrying one packed entry per title and nothing else. Readers are the owner's accepted
 * friends, gated on the owner's own share flag.
 */

import type { HistoryDoc } from "./historyDoc";

export const progressKey = (userId: string) => `progress/${userId}.json`;

/**
 * R2 gets fanned out in one sync.
 *
 * The Free plan allows 50 subrequests per request and this handler shares that budget with
 * the rest of `POST /api/sync`. Only friends whose version actually moved are fetched, so
 * hitting this cap means a genuinely busy pass; the remainder arrive on the next sync, which
 * is correct because the client's stored version for them is unchanged.
 */
const MAX_DIGEST_FETCHES = 20;

/** Packed as `[watchedCount, furthestSeason, furthestEpisode, lastWatchedAtMillis]`. */
export type PackedProgress = [number, number, number, number];

export interface ProgressDigest {
  v: number;
  ver: number;
  t: Record<string, PackedProgress>;
}

export interface ProgressQuery {
  userId?: string;
  version?: number;
}

export interface ProgressEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
}

/**
 * Derive the digest from a history document.
 *
 * Pure, so the packing rules are testable without R2 or D1.
 *
 * ⚠️ **The furthest episode is tie-broken on (season, episode), never on watch time.** A
 * binge drop stamps one identical timestamp across a whole season, so a time-ordered max
 * picks an arbitrary episode within it — the same trap that broke `maxBy { airdate }` in the
 * episode-notification path.
 */
export function digestFrom(doc: HistoryDoc): ProgressDigest {
  const t: Record<string, PackedProgress> = {};

  for (const [key, title] of Object.entries(doc.titles ?? {})) {
    let count = 0;
    let season = 0;
    let episode = 0;
    let lastAt = 0;

    if (title.eps) {
      for (const [epk, watches] of Object.entries(title.eps)) {
        if (!Array.isArray(watches) || watches.length === 0) continue;
        // One distinct EPISODE, however many times it was watched — the count is compared
        // against an aired-episode total, so counting rewatches would read as "completed".
        count += 1;

        const [s, e] = epk.split("x");
        const sn = Number(s);
        const en = Number(e);
        if (Number.isFinite(sn) && Number.isFinite(en)) {
          // Specials (season 0) never advance the marker: "up to S0 E3" is meaningless as
          // progress, and a special watched late would otherwise outrank the real furthest.
          if (sn > 0 && (sn > season || (sn === season && en > episode))) {
            season = sn;
            episode = en;
          }
        }

        for (const w of watches) {
          const at = Array.isArray(w) ? Number(w[0]) : 0;
          if (Number.isFinite(at) && at > lastAt) lastAt = at;
        }
      }
    }

    if (title.w && Array.isArray(title.w)) {
      count += title.w.length;
      for (const w of title.w) {
        const at = Array.isArray(w) ? Number(w[0]) : 0;
        if (Number.isFinite(at) && at > lastAt) lastAt = at;
      }
    }

    // A title carrying only a rating or a status has no watch and is not progress.
    if (count === 0) continue;

    // Watches are stored in SECONDS (see packWatch); the client works in millis.
    t[key] = [count, season, episode, lastAt * 1000];
  }

  return { v: 1, ver: doc.ver ?? 0, t };
}

/**
 * Write or remove the digest, per the owner's share flag.
 *
 * ⚠️ **The delete arm is load-bearing.** Turning sharing off has to remove the object, not
 * merely stop refreshing it — a stale digest keeps serving a user's library to their friends
 * after they revoked consent, and nothing else would ever clean it up.
 *
 * Best-effort like `writePublicRecent` beside it: never fail a history sync over this.
 */
export async function publishProgressDigest(
  env: ProgressEnv,
  userId: string,
  doc: HistoryDoc,
  shareEnabled: boolean,
): Promise<void> {
  try {
    if (!shareEnabled) {
      await env.BUCKET.delete(progressKey(userId));
      return;
    }
    await env.BUCKET.put(progressKey(userId), JSON.stringify(digestFrom(doc)), {
      // Private between friends, so no cacheControl — this must not sit in an edge cache
      // where the authorization check no longer applies.
      httpMetadata: { contentType: "application/json" },
    });
  } catch (e) {
    console.error("progress: digest write failed", e);
  }
}

/**
 * Serve digests for the caller's friends, for the `progress` block of `POST /api/sync`.
 *
 * Returns only friends whose digest is NEWER than the version the caller holds. An absent
 * friend means "unchanged" — the client must never read omission as "they have none", or a
 * steady-state sync would wipe every friend's progress.
 */
export async function loadFriendProgress(
  env: ProgressEnv,
  userId: string,
  queries: ProgressQuery[],
): Promise<Array<{ userId: string; version: number; titles: Record<string, PackedProgress> }>> {
  const wanted = new Map<string, number>();
  for (const q of queries) {
    if (typeof q?.userId === "string" && q.userId) {
      wanted.set(q.userId, typeof q.version === "number" ? q.version : -1);
    }
  }
  if (wanted.size === 0) return [];

  const ids = [...wanted.keys()];
  const placeholders = ids.map(() => "?").join(",");

  // Authorization and freshness in ONE query.
  //
  // ⚠️ The friendship join is what makes this safe — without it any session could ask for
  // any account's progress by id. Checked BIDIRECTIONALLY against blocks for the same reason
  // `canView` does: a blocked viewer must not keep reading through an old friendship edge.
  const rows = await env.DB.prepare(
    `SELECT m.user_id AS user_id, m.version AS version
       FROM history_meta m
       JOIN friendships f
         ON  f.state = 'accepted'
         AND ((f.user_a = ? AND f.user_b = m.user_id)
           OR (f.user_b = ? AND f.user_a = m.user_id))
      WHERE m.user_id IN (${placeholders})
        AND m.share_progress = 1
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = ? AND b.blocked_id = m.user_id)
              OR (b.blocker_id = m.user_id AND b.blocked_id = ?)
        )`,
  )
    .bind(userId, userId, ...ids, userId, userId)
    .all<{ user_id: string; version: number }>();

  const stale = (rows.results ?? [])
    .filter((r) => r.version > (wanted.get(r.user_id) ?? -1))
    .slice(0, MAX_DIGEST_FETCHES);
  if (stale.length === 0) return [];

  const fetched = await Promise.all(
    stale.map(async (r) => {
      try {
        const obj = await env.BUCKET.get(progressKey(r.user_id));
        if (!obj) return null;
        const digest = (await obj.json()) as ProgressDigest;
        return { userId: r.user_id, version: digest.ver ?? r.version, titles: digest.t ?? {} };
      } catch {
        // One unreadable digest must not fail the whole sync — the client keeps what it has
        // and its stored version is unchanged, so the next pass retries naturally.
        return null;
      }
    }),
  );

  return fetched.filter((d): d is NonNullable<typeof d> => d !== null);
}
