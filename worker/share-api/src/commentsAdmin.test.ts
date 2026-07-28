// Comment moderation, admin side.
//
// The two properties worth pinning are the ones a reviewer would not think to
// check: that an unconfigured ADMIN_KEY closes these routes rather than opening
// them, and that restoring a comment also dismisses the reports that hid it —
// without which the next single report re-trips the threshold and one person
// overturns the moderator.

import { describe, it, expect } from "vitest";
import { adminAuthorized, handleAdminCommentAction, handleAdminCommentReports } from "./commentsAdmin";

const KEY = "s3cret-admin-key";
const A = "AAAAH73X7P55T48R4CFHDED9CW";

class FakeD1 {
  comments: any[] = [];
  comment_counts: any[] = [];
  reports: any[] = [];
  prepare(sql: string) {
    return new FakeStmt(this, sql.replace(/\s+/g, " ").trim());
  }
  async batch(stmts: FakeStmt[]) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
  count() {
    return this.comment_counts[0]?.n_public ?? 0;
  }
}

class FakeStmt {
  private args: any[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args as any[];
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.startsWith("SELECT id, tmdb_id, media_type, season, episode, author_id, body")) {
      return (this.db.comments.find((c) => c.id === this.args[0]) as T) ?? null;
    }
    throw new Error(`FakeD1: unhandled first() ${this.sql}`);
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.startsWith("SELECT r.target_id, r.kind")) {
      const groups = new Map<string, any>();
      for (const r of this.db.reports.filter((x) => x.state === "open")) {
        const key = `${r.target_id}:${r.kind}`;
        const g = groups.get(key) ?? { target_id: r.target_id, kind: r.kind, reporters: new Set(), last_at: 0 };
        g.reporters.add(r.reporter_id);
        g.last_at = Math.max(g.last_at, r.created_at ?? 0);
        groups.set(key, g);
      }
      return {
        results: [...groups.values()].map((g) => {
          const c = this.db.comments.find((x) => x.id === g.target_id) ?? {};
          const earliest = this.db.reports
            .filter((x) => x.target_id === g.target_id && x.kind === g.kind && x.state === "open")
            .sort((x, y) => (x.created_at ?? 0) - (y.created_at ?? 0))[0];
          return {
            ...g, reporters: g.reporters.size, reasons: "abuse",
            reported_body: earliest?.body_snapshot ?? null, ...c,
          };
        }) as T[],
      };
    }
    throw new Error(`FakeD1: unhandled all() ${this.sql}`);
  }
  async run() {
    const s = this.sql;
    const a = this.args;
    if (s.startsWith("UPDATE comments SET hidden_at")) {
      const r = this.db.comments.find((c) => c.id === a[1]);
      if (r) r.hidden_at = a[0];
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE comments SET spoiler = 0")) {
      const r = this.db.comments.find((c) => c.id === a[0]);
      if (r) r.spoiler = 0;
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE reports SET state = 'dismissed'")) {
      let n = 0;
      for (const r of this.db.reports) {
        if (r.target_id === a[0] && r.kind === a[1] && r.state === "open") {
          r.state = "dismissed";
          n++;
        }
      }
      return { success: true, meta: { changes: n } };
    }
    if (s.startsWith("INSERT INTO comment_counts")) {
      const row = this.db.comment_counts[0];
      if (row) row.n_public += a[5];
      else this.db.comment_counts.push({ n_public: a[4] });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE comment_counts SET n_public")) {
      const row = this.db.comment_counts[0];
      if (row) row.n_public = Math.max(row.n_public + a[0], 0);
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    throw new Error(`FakeD1: unhandled run() ${s}`);
  }
}

const env = (over: Record<string, unknown> = {}) => ({ DB: new FakeD1(), ADMIN_KEY: KEY, ...over }) as any;
const req = (key = KEY) =>
  new Request("https://flickto.app/api/admin/comment-reports", { method: "POST", headers: { "X-Admin-Key": key } });

function seed(db: FakeD1, over: Record<string, unknown> = {}) {
  db.comments.push({
    id: "C1", tmdb_id: 603, media_type: "movie", season: -1, episode: -1, author_id: A,
    body: "text", visibility: "public", spoiler: 0, hidden_at: null, deleted_at: null, media_id: null, ...over,
  });
  db.comment_counts.push({ n_public: 1 });
}

describe("admin authorization", () => {
  it("is CLOSED, not open, when ADMIN_KEY is unset", () => {
    // A dev worker with no key must not be a worker where moderation is
    // unauthenticated — the same choice the Pages middleware makes.
    expect(adminAuthorized(req(), env({ ADMIN_KEY: undefined }))).toBe(false);
  });

  it("rejects a wrong key and accepts the right one", () => {
    expect(adminAuthorized(req("nope"), env())).toBe(false);
    expect(adminAuthorized(req(), env())).toBe(true);
  });

  it("refuses every action without the key", async () => {
    const e = env();
    seed(e.DB);
    expect((await handleAdminCommentAction("C1", "hide", req("nope"), e)).status).toBe(403);
    expect((await handleAdminCommentReports(req("nope"), e)).status).toBe(403);
  });
});

describe("admin actions", () => {
  it("hides and restores, moving the public counter both ways", async () => {
    const e = env();
    seed(e.DB);
    await handleAdminCommentAction("C1", "hide", req(), e);
    expect(e.DB.comments[0].hidden_at).toBeGreaterThan(0);
    expect(e.DB.count()).toBe(0);

    await handleAdminCommentAction("C1", "restore", req(), e);
    expect(e.DB.comments[0].hidden_at).toBeNull();
    expect(e.DB.count()).toBe(1);
  });

  it("⚠️ restoring DISMISSES the reports that hid it", async () => {
    const e = env();
    seed(e.DB, { hidden_at: 123 });
    for (const r of ["r1", "r2", "r3"]) {
      e.DB.reports.push({ id: r, reporter_id: r, target_id: "C1", kind: "comment", state: "open", created_at: 1 });
    }
    await handleAdminCommentAction("C1", "restore", req(), e);
    // Leaving them open would mean the next single report re-trips
    // REPORT_AUTOHIDE and one person overturns the moderator.
    expect(e.DB.reports.every((r: any) => r.state === "dismissed")).toBe(true);
  });

  it("unblurs and clears only the SPOILER reports, leaving abuse reports open", async () => {
    const e = env();
    seed(e.DB, { spoiler: 1 });
    e.DB.reports.push(
      { id: "s1", reporter_id: "s1", target_id: "C1", kind: "comment_spoiler", state: "open", created_at: 1 },
      { id: "a1", reporter_id: "a1", target_id: "C1", kind: "comment", state: "open", created_at: 1 },
    );
    await handleAdminCommentAction("C1", "unblur", req(), e);
    expect(e.DB.comments[0].spoiler).toBe(0);
    expect(e.DB.reports.find((r: any) => r.kind === "comment_spoiler").state).toBe("dismissed");
    // An unblur is not a verdict on the abuse report, which is a separate decision.
    expect(e.DB.reports.find((r: any) => r.kind === "comment").state).toBe("open");
  });

  it("rejects an unknown action rather than silently doing nothing", async () => {
    const e = env();
    seed(e.DB);
    expect((await handleAdminCommentAction("C1", "delete", req(), e)).status).toBe(400);
  });
});

describe("the queue", () => {
  it("carries BOTH the reported text and the current one", async () => {
    const e = env();
    seed(e.DB, { body: "something innocuous" });
    e.DB.reports.push({
      id: "r1", reporter_id: "r1", target_id: "C1", kind: "comment", state: "open",
      created_at: 1, body_snapshot: "the original text",
    });
    const { reports } = (await (await handleAdminCommentReports(req(), e)).json()) as any;
    // The divergence is the signal: editing straight after a report is usually
    // damage control, and the admin has to decide on what was actually reported.
    expect(reports[0].reportedBody).toBe("the original text");
    expect(reports[0].currentBody).toBe("something innocuous");
  });

  it("groups by kind, so abuse and spoiler are two decisions with two buttons", async () => {
    const e = env();
    seed(e.DB);
    e.DB.reports.push(
      { id: "a1", reporter_id: "a1", target_id: "C1", kind: "comment", state: "open", created_at: 1 },
      { id: "s1", reporter_id: "s1", target_id: "C1", kind: "comment_spoiler", state: "open", created_at: 2 },
    );
    const { reports } = (await (await handleAdminCommentReports(req(), e)).json()) as any;
    expect(reports.map((r: any) => r.kind).sort()).toEqual(["comment", "comment_spoiler"]);
  });
});
