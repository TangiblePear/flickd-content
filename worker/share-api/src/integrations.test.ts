// Phase 3: server-coordinated, device-executed push to Trakt / SIMKL.
//
// Two properties here are worth more than the rest combined, and both fail silently:
//
//  1. The ECHO GUARD. Queueing Trakt-sourced events back at Trakt would re-write a user's
//     own library to itself on every import — 20,000 calls, their rate limit burned, and a
//     duplicate of every watch they own if any timestamp rounds differently. Nothing about
//     that throws; it just quietly wrecks the account it was meant to sync.
//  2. A failed push RELEASING rather than deleting its job. A deleted job is a push nobody
//     will ever retry, and nothing anywhere would notice the entries missing from Trakt.

import { describe, it, expect } from "vitest";
import {
  CLAIM_TTL_MS,
  claimPushes,
  connectedTargets,
  handleConfirmPush,
  handleGetIntegrations,
  handleUpdateIntegration,
  queuePushes,
  queueRemoval,
} from "./integrations";

const A = "AAAAH73X7P55T48R4CFHDED9CW";
const B = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const TOKENS: Record<string, string> = { "tok-a": A, "tok-b": B };

class FakeD1 {
  sessions = new Map<string, string>();
  user_integrations: any[] = [];
  pending_integration_push: any[] = [];
  prepare(sql: string) { return new FakeStmt(this, sql.replace(/\s+/g, " ").trim()); }
  async batch(stmts: FakeStmt[]) { const o = []; for (const s of stmts) o.push(await s.run()); return o; }
}

class FakeStmt {
  args: any[] = [];
  constructor(private db: FakeD1, private sql: string) {}
  bind(...a: any[]) { this.args = a; return this; }

  async first<T>(): Promise<T | null> {
    const s = this.sql, a = this.args;
    if (s.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      const u = this.db.sessions.get(a[0]);
      return u ? ({ user_id: u, expires_at: Date.now() + 8.64e7, revoked_at: null } as T) : null;
    }
    throw new Error(`FakeD1: unhandled first() ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const s = this.sql, a = this.args;
    if (s.startsWith("SELECT target FROM user_integrations")) {
      return { results: this.db.user_integrations.filter((r) => r.user_id === a[0] && r.connected === 1) as T[] };
    }
    if (s.startsWith("SELECT id, target, action, event_ids FROM pending_integration_push")) {
      const [userId, staleBefore, limit] = a;
      return {
        results: this.db.pending_integration_push
          .filter((r) => r.user_id === userId && (r.claimed_by == null || r.claimed_at < staleBefore))
          .sort((x, y) => x.created_at - y.created_at)
          .slice(0, limit) as T[],
      };
    }
    throw new Error(`FakeD1: unhandled all() ${this.sql}`);
  }

  async run() {
    const s = this.sql, a = this.args;
    if (s.startsWith("INSERT INTO pending_integration_push")) {
      const generic = s.includes("VALUES (?,?,?,?,?,?)");
      const [id, user_id, target, ...rest] = a;
      this.db.pending_integration_push.push({
        id, user_id, target,
        action: generic ? rest[0] : (s.includes("'REMOVE'") ? "REMOVE" : "ADD"),
        event_ids: generic ? rest[1] : rest[0],
        created_at: generic ? rest[2] : rest[1],
        claimed_by: null, claimed_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE pending_integration_push SET claimed_by = ?, claimed_at = ?")) {
      const [by, at, userId, id] = a;
      const r = this.db.pending_integration_push.find((x) => x.user_id === userId && x.id === id);
      if (r) { r.claimed_by = by; r.claimed_at = at; }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE pending_integration_push SET claimed_by = NULL")) {
      const [userId, id] = a;
      const r = this.db.pending_integration_push.find((x) => x.user_id === userId && x.id === id);
      if (r) { r.claimed_by = null; r.claimed_at = null; }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (s.startsWith("DELETE FROM pending_integration_push WHERE user_id = ? AND target = ?")) {
      this.db.pending_integration_push = this.db.pending_integration_push.filter((x) => !(x.user_id === a[0] && x.target === a[1]));
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM pending_integration_push WHERE user_id = ? AND id = ?")) {
      this.db.pending_integration_push = this.db.pending_integration_push.filter((x) => !(x.user_id === a[0] && x.id === a[1]));
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO user_integrations")) {
      const [user_id, target, connected, updated_at] = a;
      const r = this.db.user_integrations.find((x) => x.user_id === user_id && x.target === target);
      if (r) Object.assign(r, { connected, updated_at });
      else this.db.user_integrations.push({ user_id, target, connected, updated_at });
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled run() ${this.sql}`);
  }
}

async function hash(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function env0(targets: string[] = []) {
  const db = new FakeD1();
  for (const [tok, uid] of Object.entries(TOKENS)) db.sessions.set(await hash(tok), uid);
  for (const t of targets) db.user_integrations.push({ user_id: A, target: t, connected: 1, updated_at: 1 });
  return { DB: db } as any;
}

const req = (token: string, body: unknown, method = "PUT") =>
  new Request("https://flickto.app/api/history/integrations", {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });

const ev = (id: string, source: string) => ({ id, source });
const NOW = 1_700_000_000_000;

describe("integrations: the echo guard", () => {
  it("never queues a Trakt-sourced event back at Trakt", async () => {
    // ⚠️ The most destructive bug this feature could have. Importing 20,000 events FROM
    // Trakt would otherwise queue all 20,000 straight back AT Trakt.
    const env = await env0(["TRAKT"]);
    const n = await queuePushes(env, A, [ev("a", "TRAKT"), ev("b", "TRAKT")], NOW);
    expect(n).toBe(0);
    expect(env.DB.pending_integration_push).toHaveLength(0);
  });

  it("queues only the events that did not come from that target", async () => {
    const env = await env0(["TRAKT"]);
    await queuePushes(env, A, [ev("a", "TRAKT"), ev("b", "MANUAL"), ev("c", "INTERNAL")], NOW);
    expect(env.DB.pending_integration_push).toHaveLength(1);
    expect(JSON.parse(env.DB.pending_integration_push[0].event_ids)).toEqual(["b", "c"]);
  });

  it("cross-posts between services — a SIMKL event still goes to Trakt", async () => {
    // The guard is per TARGET, not "anything imported". A watch that came from SIMKL is
    // legitimately missing from Trakt and should be pushed there.
    const env = await env0(["TRAKT", "SIMKL"]);
    await queuePushes(env, A, [ev("a", "SIMKL")], NOW);
    const jobs = env.DB.pending_integration_push;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].target).toBe("TRAKT");
  });
});

describe("integrations: queueing", () => {
  it("writes nothing when the account has no integrations", async () => {
    // The overwhelmingly common case, and it must stay free.
    const env = await env0([]);
    expect(await queuePushes(env, A, [ev("a", "MANUAL")], NOW)).toBe(0);
    expect(env.DB.pending_integration_push).toHaveLength(0);
  });

  it("creates ONE job per target per batch, not one per event", async () => {
    // A 5,000-event batch is one row. Per-event rows are what this whole redesign exists
    // to avoid, and re-introducing them here would undo it through the side door.
    const env = await env0(["TRAKT", "SIMKL"]);
    const events = Array.from({ length: 500 }, (_, i) => ev(`e${i}`, "MANUAL"));
    await queuePushes(env, A, events, NOW);
    expect(env.DB.pending_integration_push).toHaveLength(2);
    expect(JSON.parse(env.DB.pending_integration_push[0].event_ids)).toHaveLength(500);
  });

  it("queues removals so a deletion propagates outward too", async () => {
    const env = await env0(["TRAKT"]);
    await queueRemoval(env, A, "watch-MOVIE-550-1700000000", NOW);
    expect(env.DB.pending_integration_push[0]).toMatchObject({ action: "REMOVE", target: "TRAKT" });
  });
});

describe("integrations: claiming", () => {
  it("hands a job to one device and withholds it from the next", async () => {
    // The entire point of server coordination: two devices must not both push the same
    // watch, or Trakt records it twice.
    const env = await env0(["TRAKT"]);
    await queuePushes(env, A, [ev("a", "MANUAL")], NOW);

    const first = await claimPushes(env, A, "device-1", NOW);
    expect(first).toHaveLength(1);
    expect(first[0].eventIds).toEqual(["a"]);

    const second = await claimPushes(env, A, "device-2", NOW + 1000);
    expect(second).toHaveLength(0);
  });

  it("lets another device take over an EXPIRED claim", async () => {
    // A device that died mid-push must not strand the work forever.
    const env = await env0(["TRAKT"]);
    await queuePushes(env, A, [ev("a", "MANUAL")], NOW);
    await claimPushes(env, A, "device-1", NOW);

    const later = await claimPushes(env, A, "device-2", NOW + CLAIM_TTL_MS + 1);
    expect(later).toHaveLength(1);
    expect(env.DB.pending_integration_push[0].claimed_by).toBe("device-2");
  });

  it("writes nothing when there is nothing owed", async () => {
    const env = await env0(["TRAKT"]);
    expect(await claimPushes(env, A, "device-1", NOW)).toEqual([]);
  });

  it("never hands one account's jobs to another", async () => {
    const env = await env0(["TRAKT"]);
    await queuePushes(env, A, [ev("a", "MANUAL")], NOW);
    expect(await claimPushes(env, B, "device-b", NOW)).toEqual([]);
  });

  it("survives a malformed id blob rather than throwing on the sync path", async () => {
    const env = await env0(["TRAKT"]);
    env.DB.pending_integration_push.push({
      id: "j1", user_id: A, target: "TRAKT", action: "ADD",
      event_ids: "{not json", created_at: NOW, claimed_by: null, claimed_at: null,
    });
    const jobs = await claimPushes(env, A, "device-1", NOW);
    expect(jobs[0].eventIds).toEqual([]);
  });
});

describe("integrations: confirmation", () => {
  const confirm = (token: string, body: unknown) =>
    new Request("https://flickto.app/api/history/confirm-push", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("deletes the job on success", async () => {
    const env = await env0(["TRAKT"]);
    await queuePushes(env, A, [ev("a", "MANUAL")], NOW);
    const [job] = await claimPushes(env, A, "device-1", NOW);

    const res = await handleConfirmPush(confirm("tok-a", { pushId: job.pushId, succeeded: true }), env);
    expect(res.status).toBe(200);
    expect(env.DB.pending_integration_push).toHaveLength(0);
  });

  it("RELEASES rather than deletes on failure, so it is retried", async () => {
    // ⚠️ Deleting here would be a push nobody ever retries, and nothing anywhere would
    // notice the entries missing from Trakt.
    const env = await env0(["TRAKT"]);
    await queuePushes(env, A, [ev("a", "MANUAL")], NOW);
    const [job] = await claimPushes(env, A, "device-1", NOW);

    await handleConfirmPush(confirm("tok-a", { pushId: job.pushId, succeeded: false }), env);
    expect(env.DB.pending_integration_push).toHaveLength(1);
    expect(env.DB.pending_integration_push[0].claimed_by).toBeNull();

    // Immediately available to any device, without waiting out the claim.
    expect(await claimPushes(env, A, "device-2", NOW + 1)).toHaveLength(1);
  });

  it("re-queues only the FAILED ids on a partial failure", async () => {
    // Retrying the whole batch would re-push what already landed and duplicate it.
    const env = await env0(["TRAKT"]);
    await queuePushes(env, A, [ev("a", "MANUAL"), ev("b", "MANUAL"), ev("c", "MANUAL")], NOW);
    const [job] = await claimPushes(env, A, "device-1", NOW);

    await handleConfirmPush(
      confirm("tok-a", { pushId: job.pushId, target: "TRAKT", succeeded: false, failedEventIds: ["c"] }),
      env,
    );
    expect(env.DB.pending_integration_push).toHaveLength(1);
    expect(JSON.parse(env.DB.pending_integration_push[0].event_ids)).toEqual(["c"]);
  });

  it("cannot confirm another account's job", async () => {
    const env = await env0(["TRAKT"]);
    await queuePushes(env, A, [ev("a", "MANUAL")], NOW);
    const [job] = await claimPushes(env, A, "device-1", NOW);
    await handleConfirmPush(confirm("tok-b", { pushId: job.pushId, succeeded: true }), env);
    expect(env.DB.pending_integration_push).toHaveLength(1);
  });

  it("refuses without a session", async () => {
    const env = await env0(["TRAKT"]);
    expect((await handleConfirmPush(confirm("nope", { pushId: "x", succeeded: true }), env)).status).toBe(401);
  });
});

describe("integrations: registration", () => {
  it("records a connection and reports it back", async () => {
    const env = await env0([]);
    await handleUpdateIntegration(req("tok-a", { target: "TRAKT", connected: true }), env);
    expect(await connectedTargets(env, A)).toEqual(["TRAKT"]);

    const listed = await (await handleGetIntegrations(req("tok-a", null, "GET"), env)).json();
    expect(listed.targets).toEqual(["TRAKT"]);
  });

  it("disconnecting also clears the backlog for that target", async () => {
    // Otherwise a user who disconnects Trakt has queued work fire at it days later.
    const env = await env0(["TRAKT"]);
    await queuePushes(env, A, [ev("a", "MANUAL")], NOW);
    expect(env.DB.pending_integration_push).toHaveLength(1);

    await handleUpdateIntegration(req("tok-a", { target: "TRAKT", connected: false }), env);
    expect(await connectedTargets(env, A)).toEqual([]);
    expect(env.DB.pending_integration_push).toHaveLength(0);
  });

  it("rejects an unknown target rather than storing it", async () => {
    const env = await env0([]);
    const res = await handleUpdateIntegration(req("tok-a", { target: "LETTERBOXD", connected: true }), env);
    expect(res.status).toBe(400);
    expect(env.DB.user_integrations).toHaveLength(0);
  });

  it("refuses without a session", async () => {
    const env = await env0([]);
    expect((await handleUpdateIntegration(req("nope", { target: "TRAKT", connected: true }), env)).status).toBe(401);
  });
});
