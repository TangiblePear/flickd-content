import { describe, it, expect } from "vitest";
import {
  handleGetMySettings,
  handlePutMySettings,
  mergeSettings,
  readSettingsRow,
} from "./settings";
import {
  handleGetMyAchievements,
  handlePutMyAchievements,
  readAchievementsRow,
  validateUnlocks,
} from "./achievements";

// ── In-memory D1 fake ────────────────────────────────────────────────────────
// Throws on any SQL shape it does not recognise, matching the fakes in
// profiles.test.ts and auth.test.ts: a future query change must fail loudly here
// rather than silently pass against a fake that quietly returns null.

const OWNER = "C3VXH73X7P55T48R4CFHDED9CW";
const OTHER = "D4WYJ84Y8Q66V59S5DGJEFEAX0";
const SESSION_HASH_FOR: Record<string, string> = { "tok-owner": OWNER, "tok-other": OTHER };

interface Row {
  [k: string]: unknown;
}

class FakeD1 {
  user_settings: Row[] = [];
  user_achievements: Row[] = [];
  sessions = new Map<string, string>();

  prepare(sql: string) {
    return new FakeStmt(this, sql.replace(/\s+/g, " ").trim());
  }
}

class FakeStmt {
  private args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const s = this.sql;
    if (s.startsWith("SELECT user_id, expires_at, revoked_at FROM sessions")) {
      const user = this.db.sessions.get(this.args[0] as string);
      return user ? ({ user_id: user, expires_at: Date.now() + 86400_000, revoked_at: null } as T) : null;
    }
    if (s.includes("FROM user_settings WHERE user_id = ?")) {
      return (this.db.user_settings.find((r) => r.user_id === this.args[0]) ?? null) as T | null;
    }
    if (s.includes("FROM user_achievements WHERE user_id = ?")) {
      return (this.db.user_achievements.find((r) => r.user_id === this.args[0]) ?? null) as T | null;
    }
    throw new Error(`FakeD1: unhandled first() for ${s}`);
  }

  async run() {
    const s = this.sql;
    if (s.startsWith("INSERT INTO user_settings")) {
      const [user_id, payload, version, updated_at] = this.args;
      const existing = this.db.user_settings.find((r) => r.user_id === user_id);
      if (existing) Object.assign(existing, { payload, version, updated_at });
      else this.db.user_settings.push({ user_id, payload, version, updated_at });
      return { success: true };
    }
    if (s.startsWith("INSERT INTO user_achievements")) {
      const [user_id, payload, rules_version, version, updated_at] = this.args;
      const existing = this.db.user_achievements.find((r) => r.user_id === user_id);
      if (existing) Object.assign(existing, { payload, rules_version, version, updated_at });
      else this.db.user_achievements.push({ user_id, payload, rules_version, version, updated_at });
      return { success: true };
    }
    throw new Error(`FakeD1: unhandled run() for ${s}`);
  }
}

const authed = (token: string, path: string, init: RequestInit = {}): Request =>
  new Request(`https://flickto.app${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
  });

/** `resolveSession` hashes the bearer with a real sha256, so the map is keyed on the digest. */
const env0 = async () => {
  const env = { DB: new FakeD1(), FIREBASE_PROJECT_ID: "flickto-cf7b6" } as any;
  const enc = new TextEncoder();
  for (const [token, user] of Object.entries(SESSION_HASH_FOR)) {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(token));
    env.DB.sessions.set(
      [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      user,
    );
  }
  return env;
};

const putSettings = (token: string, body: unknown, ifMatch?: string) =>
  authed(token, "/api/me/settings", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: ifMatch == null ? {} : { "If-Match": ifMatch },
  });

const putAchievements = (token: string, body: unknown, ifMatch?: string) =>
  authed(token, "/api/me/achievements", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: ifMatch == null ? {} : { "If-Match": ifMatch },
  });

// ── mergeSettings, in isolation ──────────────────────────────────────────────
describe("mergeSettings", () => {
  it("carries forward a key the caller never sent", () => {
    const merged = mergeSettings({ themeMode: "light" }, { themeMode: "dark", futureKey: 42 });
    expect(JSON.parse(merged!)).toEqual({ themeMode: "light", futureKey: 42 });
  });

  it("rejects a payload over the byte cap", () => {
    expect(mergeSettings({ big: "x".repeat(9000) }, {})).toBeNull();
  });

  it("rejects a payload over the key cap", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) many[`k${i}`] = i;
    expect(mergeSettings(many, {})).toBeNull();
  });

  it("drops an unusable key rather than failing the whole write", () => {
    const merged = mergeSettings({ "": 1, ["k".repeat(200)]: 2, themeMode: "dark" }, {});
    expect(JSON.parse(merged!)).toEqual({ themeMode: "dark" });
  });
});

// ── Settings endpoints ───────────────────────────────────────────────────────
describe("owner settings", () => {
  it("401s without a session", async () => {
    const env = await env0();
    const res = await handleGetMySettings(new Request("https://flickto.app/api/me/settings"), env);
    expect(res.status).toBe(401);
  });

  it("returns null before anything is stored", async () => {
    const env = await env0();
    const body = (await (await handleGetMySettings(authed("tok-owner", "/api/me/settings"), env)).json()) as any;
    expect(body).toEqual({ settings: null });
  });

  it("creates the row at version 1 on a first write", async () => {
    const env = await env0();
    const res = await handlePutMySettings(putSettings("tok-owner", { themeMode: "light" }), env);
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(1);

    const row = await readSettingsRow(env, OWNER);
    expect(JSON.parse(row!.payload!)).toEqual({ themeMode: "light" });
  });

  it("409s with the current version when If-Match loses the race", async () => {
    const env = await env0();
    await handlePutMySettings(putSettings("tok-owner", { themeMode: "light" }), env);
    const res = await handlePutMySettings(putSettings("tok-owner", { themeMode: "dark" }, "0"), env);
    expect(res.status).toBe(409);
    expect((await res.json()).version).toBe(1);
  });

  /**
   * The regression this module exists to prevent. An older client that has never heard of
   * a key must not erase it by omission — see the mergeSettings header.
   */
  it("does NOT erase a key the pushing client omitted", async () => {
    const env = await env0();
    await handlePutMySettings(putSettings("tok-owner", { themeMode: "dark", tmdbRegion: "GB" }), env);
    // A client that predates `tmdbRegion` saves only what it knows about.
    await handlePutMySettings(putSettings("tok-owner", { themeMode: "light" }, "1"), env);

    const row = await readSettingsRow(env, OWNER);
    expect(JSON.parse(row!.payload!)).toEqual({ themeMode: "light", tmdbRegion: "GB" });
  });

  it("413s past the size cap", async () => {
    const env = await env0();
    const res = await handlePutMySettings(putSettings("tok-owner", { big: "x".repeat(9000) }), env);
    expect(res.status).toBe(413);
  });

  it("400s on a non-object body", async () => {
    const env = await env0();
    const res = await handlePutMySettings(putSettings("tok-owner", [1, 2, 3]), env);
    expect(res.status).toBe(400);
  });

  it("does not let another session read the row", async () => {
    const env = await env0();
    await handlePutMySettings(putSettings("tok-owner", { themeMode: "light" }), env);
    const body = (await (await handleGetMySettings(authed("tok-other", "/api/me/settings"), env)).json()) as any;
    expect(body).toEqual({ settings: null });
  });
});

// ── validateUnlocks, in isolation ────────────────────────────────────────────
describe("validateUnlocks", () => {
  it("drops a malformed entry rather than failing the push", () => {
    const out = JSON.parse(
      validateUnlocks([
        { id: "century_club", tier: 2, unlockedAt: 1000 },
        { id: "", tier: 1, unlockedAt: 1 },
        { id: "no_tier", tier: 0, unlockedAt: 1 },
        "junk",
      ])!,
    );
    expect(out).toEqual([{ id: "century_club", tier: 2, unlockedAt: 1000 }]);
  });

  it("keeps the badge when only the timestamp is junk", () => {
    const out = JSON.parse(validateUnlocks([{ id: "film_buff", tier: 1, unlockedAt: "nope" }])!);
    expect(out).toEqual([{ id: "film_buff", tier: 1, unlockedAt: 0 }]);
  });

  it("rejects a non-array", () => {
    expect(validateUnlocks({ id: "x" })).toBeNull();
  });
});

// ── Achievement endpoints ────────────────────────────────────────────────────
describe("owner achievements", () => {
  const unlocks = [{ id: "century_club", tier: 2, unlockedAt: 1_700_000_000_000 }];

  it("401s without a session", async () => {
    const env = await env0();
    const res = await handleGetMyAchievements(new Request("https://flickto.app/api/me/achievements"), env);
    expect(res.status).toBe(401);
  });

  it("round-trips the unlock set and its rules stamp", async () => {
    const env = await env0();
    const res = await handlePutMyAchievements(putAchievements("tok-owner", { rulesVersion: 3, unlocks }), env);
    expect(res.status).toBe(200);

    const body = (await (
      await handleGetMyAchievements(authed("tok-owner", "/api/me/achievements"), env)
    ).json()) as any;
    expect(body.achievements.rulesVersion).toBe(3);
    expect(body.achievements.unlocks).toEqual(unlocks);
  });

  /**
   * Without a stamp the client cannot tell a current set from one written under rules
   * that have since changed — which is exactly how a one-shot correction gets undone.
   * Defaulting to 0 would be worse than refusing: every client would re-reconcile.
   */
  it("400s when rulesVersion is missing or junk", async () => {
    const env = await env0();
    expect((await handlePutMyAchievements(putAchievements("tok-owner", { unlocks }), env)).status).toBe(400);
    expect(
      (await handlePutMyAchievements(putAchievements("tok-owner", { rulesVersion: 0, unlocks }), env)).status,
    ).toBe(400);
  });

  it("REPLACES rather than merging, so a demotion is expressible", async () => {
    const env = await env0();
    await handlePutMyAchievements(
      putAchievements("tok-owner", {
        rulesVersion: 3,
        unlocks: [
          { id: "night_owl", tier: 3, unlockedAt: 100 },
          { id: "film_buff", tier: 1, unlockedAt: 200 },
        ],
      }),
      env,
    );
    // A client that reconciled against raised thresholds pushes the corrected set.
    await handlePutMyAchievements(
      putAchievements("tok-owner", { rulesVersion: 4, unlocks: [{ id: "film_buff", tier: 1, unlockedAt: 200 }] }, "1"),
      env,
    );

    const row = await readAchievementsRow(env, OWNER);
    expect(JSON.parse(row!.payload!)).toEqual([{ id: "film_buff", tier: 1, unlockedAt: 200 }]);
    expect(row!.rules_version).toBe(4);
  });

  it("409s with the current version when If-Match loses the race", async () => {
    const env = await env0();
    await handlePutMyAchievements(putAchievements("tok-owner", { rulesVersion: 3, unlocks }), env);
    const res = await handlePutMyAchievements(putAchievements("tok-owner", { rulesVersion: 3, unlocks }, "0"), env);
    expect(res.status).toBe(409);
    expect((await res.json()).version).toBe(1);
  });

  it("does not let another session read the row", async () => {
    const env = await env0();
    await handlePutMyAchievements(putAchievements("tok-owner", { rulesVersion: 3, unlocks }), env);
    const body = (await (
      await handleGetMyAchievements(authed("tok-other", "/api/me/achievements"), env)
    ).json()) as any;
    expect(body).toEqual({ achievements: null });
  });
});
