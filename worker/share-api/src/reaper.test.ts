import { describe, it, expect } from "vitest";
import {
  selectReapable,
  reapOrphanProfiles,
  type ReapCandidate,
  type ReaperBucket,
} from "./reaper";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY; // arbitrary fixed "now"
const TTL = 365 * DAY;

/** Minimal in-memory R2 stand-in with controllable `uploaded` timestamps. */
function makeR2(entries: Record<string, number>) {
  const map = new Map<string, Date>(
    Object.entries(entries).map(([k, ms]) => [k, new Date(ms)]),
  );
  const bucket = {
    async list(opts: { prefix?: string; delimiter?: string; cursor?: string } = {}) {
      const prefix = opts.prefix ?? "";
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix));
      if (opts.delimiter) {
        const prefixes = new Set<string>();
        const objects: { key: string; uploaded: Date }[] = [];
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const idx = rest.indexOf(opts.delimiter);
          if (idx >= 0) prefixes.add(prefix + rest.slice(0, idx + 1));
          else objects.push({ key: k, uploaded: map.get(k)! });
        }
        return { objects, delimitedPrefixes: [...prefixes], truncated: false, cursor: undefined };
      }
      return {
        objects: keys.map((k) => ({ key: k, uploaded: map.get(k)! })),
        delimitedPrefixes: [] as string[],
        truncated: false,
        cursor: undefined,
      };
    },
    _map: map,
  };
  return bucket as ReaperBucket & { _map: Map<string, Date> };
}

/** Purge callback that deletes a friendId prefix, mirroring purgeFriendScoped. */
function makePurge(bucket: ReaperBucket & { _map: Map<string, Date> }) {
  const calls: string[] = [];
  const purge = async (friendId: string) => {
    calls.push(friendId);
    let n = 0;
    for (const k of [...bucket._map.keys()]) {
      if (k.startsWith(`${friendId}/`)) {
        bucket._map.delete(k);
        n++;
      }
    }
    return n;
  };
  return { purge, calls };
}

describe("reapOrphanProfiles", () => {
  it("reaps only friendId folders past the TTL, never backup/ or self/", async () => {
    const bucket = makeR2({
      "AAAAAAAAAAAA/owner.json": NOW,
      "AAAAAAAAAAAA/fcm-token.json": NOW,
      "BBBBBBBBBBBB/owner.json": NOW - TTL - DAY,
      "BBBBBBBBBBBB/profile.json": NOW - TTL - DAY,
      "backup/somelookupkey000000.json": NOW - TTL - 10 * DAY,
      "self/otherlookupkey000000.json": NOW - TTL - 10 * DAY,
    });
    const { purge, calls } = makePurge(bucket);

    const result = await reapOrphanProfiles(bucket, purge, { nowMs: NOW, ttlMs: TTL, cap: 100 });

    expect(result.reaped).toEqual(["BBBBBBBBBBBB"]);
    expect(calls).toEqual(["BBBBBBBBBBBB"]);
    expect([...bucket._map.keys()]).toContain("AAAAAAAAAAAA/owner.json");
    expect([...bucket._map.keys()]).toContain("backup/somelookupkey000000.json");
    expect([...bucket._map.keys()]).toContain("self/otherlookupkey000000.json");
    expect([...bucket._map.keys()].some((k) => k.startsWith("BBBBBBBBBBBB/"))).toBe(false);
  });

  it("keeps a folder whose newest object is fresh even if an older object is stale", async () => {
    const bucket = makeR2({
      "CCCCCCCCCCCC/opinions/old.json": NOW - TTL - DAY,
      "CCCCCCCCCCCC/fcm-token.json": NOW - DAY,
    });
    const { purge, calls } = makePurge(bucket);

    const result = await reapOrphanProfiles(bucket, purge, { nowMs: NOW, ttlMs: TTL, cap: 100 });

    expect(result.reaped).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("selectReapable", () => {
  it("reaps a folder cold for longer than the TTL", () => {
    const candidates: ReapCandidate[] = [{ friendId: "AAAAAAAAAAAA", lastSeenMs: NOW - TTL - DAY }];
    expect(selectReapable(candidates, NOW, TTL, 100)).toEqual(["AAAAAAAAAAAA"]);
  });

  it("keeps a folder touched within the TTL", () => {
    const candidates: ReapCandidate[] = [{ friendId: "BBBBBBBBBBBB", lastSeenMs: NOW - TTL + DAY }];
    expect(selectReapable(candidates, NOW, TTL, 100)).toEqual([]);
  });

  it("keeps a folder touched exactly at the TTL boundary", () => {
    const candidates: ReapCandidate[] = [{ friendId: "CCCCCCCCCCCC", lastSeenMs: NOW - TTL }];
    expect(selectReapable(candidates, NOW, TTL, 100)).toEqual([]);
  });

  it("caps the number reaped per run", () => {
    const candidates: ReapCandidate[] = Array.from({ length: 5 }, (_, i) => ({
      friendId: `D${i}`.padEnd(12, "0"),
      lastSeenMs: NOW - TTL - DAY,
    }));
    expect(selectReapable(candidates, NOW, TTL, 2)).toHaveLength(2);
  });
});
