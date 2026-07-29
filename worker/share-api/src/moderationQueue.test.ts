// The merged moderation queue.
//
// The property worth pinning hardest is that `reporterCount` means the same thing on
// both sides — distinct humans, not distinct report records. D1 counts DISTINCT
// reporter_id; R2 has one object per report and has to dedupe on the reporter segment
// of the filename. Getting that wrong on either side makes the auto-hide threshold and
// the number the admin reads disagree, which is exactly the sort of divergence that
// makes a moderator distrust the panel.

import { describe, it, expect } from "vitest";
import { handleModerationQueue, type ReportItem } from "./moderationQueue";

const KEY = "s3cret-admin-key";
const A = "AAAAH73X7P55T48R4CFHDED9CW";
const B = "BBBBH73X7P55T48R4CFHDED9CW";
const NOW = 1_700_000_000_000;

class FakeD1 {
  reports: any[] = [];
  comments: any[] = [];
  profiles: any[] = [];
  users: any[] = [];
  /** Declared here because `setHidden` writes it via `countStatement` in the act tests. */
  comment_counts: any[] = [];
  prepare(sql: string) {
    const self = this;
    const s = sql.replace(/\s+/g, " ").trim();
    let args: unknown[] = [];
    return {
      bind(...a: unknown[]) {
        args = a;
        return this;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const open = s.includes("WHERE r.state = 'open'");
        const rows = self.reports.filter((r) => (open ? r.state === "open" : r.state !== "open"));
        const groups = new Map<string, any>();
        for (const r of rows) {
          const key = `${r.target_id}:${r.kind}`;
          const g = groups.get(key) ?? {
            target_id: r.target_id,
            kind: r.kind,
            reporters: new Set<string>(),
            reasons: new Set<string>(),
            first_at: Infinity,
            last_at: 0,
            state: r.state,
          };
          g.reporters.add(r.reporter_id);
          if (r.context) g.reasons.add(r.context);
          g.first_at = Math.min(g.first_at, r.created_at);
          g.last_at = Math.max(g.last_at, r.created_at);
          groups.set(key, g);
        }
        return {
          results: [...groups.values()].map((g) => {
            const c = self.comments.find((x) => x.id === g.target_id);
            const p = self.profiles.find((x) => x.user_id === g.target_id);
            const u = self.users.find((x) => x.id === g.target_id);
            const author = c ? self.profiles.find((x) => x.user_id === c.author_id) : null;
            const authorUser = c ? self.users.find((x) => x.id === c.author_id) : null;
            const earliest = self.reports
              .filter((x) => x.target_id === g.target_id && x.kind === g.kind)
              .sort((x, y) => x.created_at - y.created_at)[0];
            return {
              target_id: g.target_id,
              kind: g.kind,
              reporters: g.reporters.size,
              reasons: [...g.reasons].join(","),
              first_at: g.first_at,
              last_at: g.last_at,
              state: g.state,
              reported_body: earliest?.body_snapshot ?? null,
              comment_id: c?.id ?? null,
              body: c?.body ?? null,
              author_id: c?.author_id ?? null,
              tmdb_id: c?.tmdb_id ?? null,
              media_type: c?.media_type ?? null,
              season: c?.season ?? null,
              episode: c?.episode ?? null,
              spoiler: c?.spoiler ?? null,
              hidden_at: c?.hidden_at ?? null,
              deleted_at: c?.deleted_at ?? null,
              author_name: author?.display_name ?? null,
              author_suspended_until: authorUser?.posting_suspended_until ?? null,
              target_name: p?.display_name ?? null,
              target_picture: p?.picture_url ?? null,
              friend_id: u?.friend_id ?? null,
              posting_suspended_until: u?.posting_suspended_until ?? null,
            } as T;
          }),
        };
      },
    };
  }
}

/** Prefix-aware, because the queue lists `_reports/` and then GETs each object. */
class FakeBucket {
  store = new Map<string, string>();
  async list({ prefix, limit }: { prefix: string; limit?: number }) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    return { objects: keys.slice(0, limit ?? 1000).map((key) => ({ key })) };
  }
  async get(key: string) {
    const raw = this.store.get(key);
    return raw === undefined ? null : { json: async () => JSON.parse(raw) };
  }
  async head(key: string) {
    return this.store.has(key) ? { key } : null;
  }
}

const shareReport = (code: string, reporter: string, at: number, over: any = {}) =>
  JSON.stringify({
    kind: "shared_list",
    targetFriendId: code,
    reporterId: reporter,
    reason: "spam",
    context: "My weekend list",
    at,
    ...over,
  });

const env = (db: FakeD1, bucket?: FakeBucket) =>
  ({ DB: db as unknown as D1Database, BUCKET: bucket as unknown as R2Bucket, ADMIN_KEY: KEY }) as any;

const get = (e: any, state = "open", key: string | null = KEY) =>
  handleModerationQueue(
    new Request(`https://flickto.app/api/moderation/reports?state=${state}`, {
      headers: key ? { "X-Admin-Key": key } : {},
    }),
    e,
  );

const items = async (res: Response): Promise<ReportItem[]> => ((await res.json()) as any).items;

describe("handleModerationQueue", () => {
  it("closes rather than opens when the key is wrong or absent", async () => {
    const e = env(new FakeD1());
    expect((await get(e, "open", "nope")).status).toBe(403);
    expect((await get(e, "open", null)).status).toBe(403);
  });

  it("counts distinct humans, not report rows, on the D1 side", async () => {
    const db = new FakeD1();
    db.comments = [
      { id: "C1", body: "now", author_id: B, tmdb_id: 550, media_type: "movie", season: -1, episode: -1, spoiler: 0, hidden_at: null, deleted_at: null },
    ];
    db.profiles = [{ user_id: B, display_name: "Mango", picture_url: "" }];
    // Same reporter twice — one distinct human.
    db.reports = [
      { target_id: "C1", kind: "comment", reporter_id: A, context: "abuse", state: "open", created_at: NOW, body_snapshot: "then" },
      { target_id: "C1", kind: "comment", reporter_id: A, context: "abuse", state: "open", created_at: NOW + 1, body_snapshot: "then" },
    ];
    const list = await items(await get(env(db)));
    expect(list).toHaveLength(1);
    expect(list[0].reporterCount).toBe(1);
    expect(list[0].target.type).toBe("comment");
    expect(list[0].target.authorId).toBe(B);
    // Both texts travel: divergence is itself a signal.
    expect(list[0].target.bodySnapshot).toBe("then");
    expect(list[0].target.currentBody).toBe("now");
  });

  it("counts distinct humans, not report objects, on the R2 side", async () => {
    const bucket = new FakeBucket();
    bucket.store.set("_reports/8FK2QP/1-" + A + ".json", shareReport("8FK2QP", A, NOW));
    bucket.store.set("_reports/8FK2QP/2-" + A + ".json", shareReport("8FK2QP", A, NOW + 1));
    bucket.store.set("_reports/8FK2QP/3-" + B + ".json", shareReport("8FK2QP", B, NOW + 2));
    const list = await items(await get(env(new FakeD1(), bucket)));
    expect(list).toHaveLength(1);
    expect(list[0].reporterCount).toBe(2);
    expect(list[0].source).toBe("r2");
    expect(list[0].target.type).toBe("share");
    expect(list[0].target.shareUrl).toBe("https://flickto.app/share/8FK2QP");
  });

  it("returns both sources in one list with one shape", async () => {
    const db = new FakeD1();
    db.profiles = [{ user_id: B, display_name: "Mango", picture_url: "https://p/x.jpg" }];
    db.users = [{ id: B, friend_id: "FRIEND12345X", posting_suspended_until: null }];
    db.reports = [
      { target_id: B, kind: "picture", reporter_id: A, context: "not them", state: "open", created_at: NOW, body_snapshot: null },
    ];
    const bucket = new FakeBucket();
    bucket.store.set("_reports/8FK2QP/1-" + A + ".json", shareReport("8FK2QP", A, NOW));
    const list = await items(await get(env(db, bucket)));
    expect(list).toHaveLength(2);
    for (const it of list) {
      expect(typeof it.id).toBe("string");
      expect(typeof it.reporterCount).toBe("number");
      expect(Array.isArray(it.reasons)).toBe(true);
      expect(it.state).toBe("open");
    }
    const pic = list.find((i) => i.kind === "picture")!;
    expect(pic.id).toBe(`${B}:picture`);
    expect(pic.target.pictureUrl).toBe("https://p/x.jpg");
  });

  it("reports an existing takedown as tombstoned", async () => {
    const db = new FakeD1();
    db.users = [{ id: B, friend_id: "FRIEND12345X", posting_suspended_until: null }];
    db.reports = [
      { target_id: B, kind: "picture", reporter_id: A, context: "", state: "open", created_at: NOW, body_snapshot: null },
    ];
    const bucket = new FakeBucket();
    bucket.store.set("_moderation/FRIEND12345X.json", "{}");
    const list = await items(await get(env(db, bucket)));
    expect(list[0].tombstoned).toBe(true);
  });

  it("surfaces a live posting suspension on the item", async () => {
    const db = new FakeD1();
    const until = Date.now() + 86_400_000;
    db.users = [{ id: B, friend_id: null, posting_suspended_until: until }];
    db.reports = [
      { target_id: B, kind: "user", reporter_id: A, context: "", state: "open", created_at: NOW, body_snapshot: null },
    ];
    const list = await items(await get(env(db)));
    expect(list[0].suspendedUntil).toBe(until);
  });

  it("sorts most-reported first, then most recent", async () => {
    const db = new FakeD1();
    db.reports = [
      { target_id: A, kind: "user", reporter_id: "R1", context: "", state: "open", created_at: NOW + 99, body_snapshot: null },
      { target_id: B, kind: "user", reporter_id: "R1", context: "", state: "open", created_at: NOW, body_snapshot: null },
      { target_id: B, kind: "user", reporter_id: "R2", context: "", state: "open", created_at: NOW + 1, body_snapshot: null },
    ];
    const list = await items(await get(env(db)));
    expect(list.map((i) => i.target.id)).toEqual([B, A]);
  });

  // R2 has no state column — resolution there is deletion — so a resolved query must
  // return D1 rows only rather than silently re-listing every open share report.
  it("omits R2 entirely from the resolved view", async () => {
    const db = new FakeD1();
    db.reports = [
      { target_id: B, kind: "user", reporter_id: A, context: "", state: "dismissed", created_at: NOW, body_snapshot: null },
    ];
    const bucket = new FakeBucket();
    bucket.store.set("_reports/8FK2QP/1-" + A + ".json", shareReport("8FK2QP", A, NOW));
    const list = await items(await get(env(db, bucket), "resolved"));
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe("d1");
    expect(list[0].state).toBe("dismissed");
  });

  it("works with no bucket bound at all", async () => {
    const db = new FakeD1();
    db.reports = [
      { target_id: B, kind: "user", reporter_id: A, context: "", state: "open", created_at: NOW, body_snapshot: null },
    ];
    const res = await get({ DB: db as unknown as D1Database, ADMIN_KEY: KEY } as any);
    expect(res.status).toBe(200);
    expect(await items(res)).toHaveLength(1);
  });
});
