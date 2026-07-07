// Orphan-profile reaper. A profile folder ({friendId}/...) whose newest object
// has gone untouched for longer than the TTL is dead (its device was wiped or
// uninstalled) and is deleted. Live installs re-PUT fcm-token every =<3 days, so
// their folders never age out.

export interface ReapCandidate {
  friendId: string;
  /** max(uploaded) across every object under `${friendId}/`, in epoch ms. */
  lastSeenMs: number;
}

/** The subset of R2Bucket the reaper needs (list only; deletes go via `purge`). */
export interface ReaperBucket {
  list(opts: { prefix?: string; delimiter?: string; cursor?: string }): Promise<{
    objects: { key: string; uploaded: Date }[];
    delimitedPrefixes: string[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/** Deletes everything under a friendId (its prefix + fc card). Returns object count. */
export type PurgeFn = (friendId: string) => Promise<number>;

export interface ReapOptions {
  nowMs: number;
  ttlMs: number;
  /** Max folders purged per run, so one invocation stays bounded. */
  cap: number;
  /** Resume point from the previous run's top-level listing. */
  cursor?: string;
}

export interface ReapResult {
  reaped: string[];
  /** Where the next run should resume, or undefined when the listing is exhausted. */
  nextCursor?: string;
}

/** friendId folders look like `AAAAAAAAAAAA/`; backup/, self/, fc/, share/, rl/ do not. */
const FRIEND_PREFIX = /^[A-Z0-9]{12,40}\/$/;

/**
 * Opportunistic-trigger gate: with no cron budget, the reaper fires from normal
 * request traffic at most once per interval. Due when it has never run or the
 * interval has fully elapsed since the last run.
 */
export function dueForReap(lastRunAtMs: number | undefined, nowMs: number, intervalMs: number): boolean {
  return nowMs - (lastRunAtMs ?? 0) >= intervalMs;
}

export async function reapOrphanProfiles(
  bucket: ReaperBucket,
  purge: PurgeFn,
  opts: ReapOptions,
): Promise<ReapResult> {
  const listing = await bucket.list({ delimiter: "/", cursor: opts.cursor });
  const friendIds = listing.delimitedPrefixes
    .filter((p) => FRIEND_PREFIX.test(p))
    .map((p) => p.slice(0, -1)); // strip trailing "/"

  const candidates: ReapCandidate[] = [];
  for (const friendId of friendIds) {
    candidates.push({ friendId, lastSeenMs: await lastSeen(bucket, friendId) });
  }

  const dead = selectReapable(candidates, opts.nowMs, opts.ttlMs, opts.cap);
  const reaped: string[] = [];
  for (const friendId of dead) {
    await purge(friendId);
    reaped.push(friendId);
  }

  return { reaped, nextCursor: listing.truncated ? listing.cursor : undefined };
}

/** Newest `uploaded` across every object under `${friendId}/`, in epoch ms. */
async function lastSeen(bucket: ReaperBucket, friendId: string): Promise<number> {
  let newest = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${friendId}/`, cursor });
    for (const obj of page.objects) {
      const t = obj.uploaded.getTime();
      if (t > newest) newest = t;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return newest;
}

/**
 * Pure decision core: which candidates are past the TTL, capped at `cap`.
 * A candidate is reapable only when it has been cold for strictly longer than
 * the TTL, so a folder touched exactly at the boundary is kept.
 */
export function selectReapable(
  candidates: ReapCandidate[],
  nowMs: number,
  ttlMs: number,
  cap: number,
): string[] {
  const dead: string[] = [];
  for (const c of candidates) {
    if (nowMs - c.lastSeenMs > ttlMs) {
      dead.push(c.friendId);
      if (dead.length >= cap) break;
    }
  }
  return dead;
}
