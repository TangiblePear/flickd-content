import { describe, it, expect } from "vitest";
import { canView, parseVisibility, friendshipKey } from "./authz";
import {
  handleBootstrap,
  handleGetMyProfile,
  handleGetProfile,
  handlePutMyProfile,
  handlePutMyStats,
} from "./profiles";

// ── In-memory D1 fake ────────────────────────────────────────────────────────
// Separate from the one in auth.test.ts, which only interprets auth.ts's
// statements. Like that one, this throws on any SQL shape it does not recognise,
// so a future query change fails loudly instead of silently passing.

const OWNER = "C3VXH73X7P55T48R4CFHDED9CW";
const OTHER = "D4WYJ84Y8Q66V59S5DGJEFEAX0";
const SESSION_HASH_FOR: Record<string, string> = { "tok-owner": OWNER, "tok-other": OTHER };

interface Row {
  [k: string]: unknown;
}

class FakeD1 {
  profiles: Row[] = [];
  profile_stats: Row[] = [];
  friendships: Row[] = [];
  blocks: Row[] = [];
  /** token → user, stood in for the sessions table; expiry/revocation aren't under test here. */
  sessions = new Map<string, string>();

  prepare(sql: string) {
    return new FakeStmt(this, sql.replace(/\s+/g, " ").trim());
  }
  async batch(stmts: FakeStmt[]) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
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
    if (s.includes("FROM profiles WHERE user_id = ?")) {
      const row = this.db.profiles.find((p) => p.user_id === this.args[0]);
      if (!row) return null;
      return (s.startsWith("SELECT version") ? { version: row.version } : row) as T;
    }
    if (s.startsWith("SELECT stats FROM profile_stats")) {
      const row = this.db.profile_stats.find((p) => p.user_id === this.args[0]);
      return row ? ({ stats: row.stats } as T) : null;
    }
    if (s.startsWith("SELECT 1 AS hit FROM blocks")) {
      const [ba, bb, ca, cb] = this.args as string[];
      const hit = this.db.blocks.some(
        (b) =>
          (b.blocker_id === ba && b.blocked_id === bb) || (b.blocker_id === ca && b.blocked_id === cb),
      );
      return hit ? ({ hit: 1 } as T) : null;
    }
    if (s.startsWith("SELECT state FROM friendships")) {
      const [a, b] = this.args as string[];
      const row = this.db.friendships.find((f) => f.user_a === a && f.user_b === b && f.state === "accepted");
      return row ? ({ state: row.state } as T) : null;
    }
    throw new Error(`FakeD1: unhandled first() for ${s}`);
  }

  async run() {
    const s = this.sql;
    if (s.startsWith("INSERT INTO profiles")) {
      const [
        user_id,
        display_name,
        avatar_id,
        border_id,
        picture_url,
        header_color,
        header_backdrop_url,
        layout,
        bio,
        favourite_movies,
        favourite_shows,
        favourite_people,
        featured_achievements,
        personality_id,
        visibility,
        version,
        updated_at,
      ] = this.args;
      const row: Row = {
        user_id,
        display_name,
        avatar_id,
        border_id,
        picture_url,
        header_color,
        header_backdrop_url,
        layout,
        bio,
        favourite_movies,
        favourite_shows,
        favourite_people,
        featured_achievements,
        personality_id,
        visibility,
        version,
        updated_at,
      };
      const at = this.db.profiles.findIndex((p) => p.user_id === user_id);
      if (at >= 0) this.db.profiles[at] = row;
      else this.db.profiles.push(row);
      return { success: true };
    }
    if (s.startsWith("INSERT INTO profile_stats")) {
      const [user_id, stats, updated_at] = this.args;
      const at = this.db.profile_stats.findIndex((p) => p.user_id === user_id);
      const row = { user_id, stats, updated_at };
      if (at >= 0) this.db.profile_stats[at] = row;
      else this.db.profile_stats.push(row);
      return { success: true };
    }
    throw new Error(`FakeD1: unhandled run() for ${s}`);
  }
  async all() {
    return { results: [], success: true };
  }
}

const authed = (
  token: string,
  path: string,
  init: RequestInit = {},
): Request =>
  new Request(`https://flickto.app${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
  });

/**
 * A fresh env with both test sessions valid. `resolveSession` hashes the bearer
 * token with a real sha256, so the fake's session map has to be keyed on that same
 * digest rather than the raw token.
 */
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

// ── canView ──────────────────────────────────────────────────────────────────
describe("canView", () => {
  it("always allows the owner, without touching blocks or friendships", async () => {
    const env = await env0();
    env.DB.blocks.push({ blocker_id: OWNER, blocked_id: OWNER, created_at: 1 });
    expect(await canView(env, OWNER, OWNER, "private")).toBe(true);
  });

  it("allows a stranger to read a public profile", async () => {
    expect(await canView(await env0(), OTHER, OWNER, "public")).toBe(true);
  });

  it("denies a stranger on a friends-only profile", async () => {
    expect(await canView(await env0(), OTHER, OWNER, "friends")).toBe(false);
  });

  it("allows an accepted friend on a friends-only profile", async () => {
    const env = await env0();
    const [a, b] = friendshipKey(OWNER, OTHER);
    env.DB.friendships.push({ user_a: a, user_b: b, state: "accepted" });
    expect(await canView(env, OTHER, OWNER, "friends")).toBe(true);
  });

  it("treats a pending request as NOT a friend", async () => {
    const env = await env0();
    const [a, b] = friendshipKey(OWNER, OTHER);
    env.DB.friendships.push({ user_a: a, user_b: b, state: "pending" });
    expect(await canView(env, OTHER, OWNER, "friends")).toBe(false);
  });

  it("denies an accepted friend on a private profile", async () => {
    const env = await env0();
    const [a, b] = friendshipKey(OWNER, OTHER);
    env.DB.friendships.push({ user_a: a, user_b: b, state: "accepted" });
    expect(await canView(env, OTHER, OWNER, "private")).toBe(false);
  });

  // The ordering test that matters: blocks are evaluated before visibility, so a
  // public profile is still denied. Getting this backwards is the classic leak.
  it("denies a blocked viewer even on a PUBLIC profile", async () => {
    const env = await env0();
    env.DB.blocks.push({ blocker_id: OWNER, blocked_id: OTHER, created_at: 1 });
    expect(await canView(env, OTHER, OWNER, "public")).toBe(false);
  });

  it("denies when the VIEWER blocked the owner, not just the reverse", async () => {
    const env = await env0();
    env.DB.blocks.push({ blocker_id: OTHER, blocked_id: OWNER, created_at: 1 });
    expect(await canView(env, OTHER, OWNER, "public")).toBe(false);
  });

  it("blocks override an accepted friendship", async () => {
    const env = await env0();
    const [a, b] = friendshipKey(OWNER, OTHER);
    env.DB.friendships.push({ user_a: a, user_b: b, state: "accepted" });
    env.DB.blocks.push({ blocker_id: OWNER, blocked_id: OTHER, created_at: 1 });
    expect(await canView(env, OTHER, OWNER, "friends")).toBe(false);
  });
});

describe("parseVisibility", () => {
  it("keeps the three known values and never widens an unknown one", () => {
    expect(parseVisibility("public")).toBe("public");
    expect(parseVisibility("private")).toBe("private");
    expect(parseVisibility("friends")).toBe("friends");
    // Anything unrecognised must land on `friends`, never `public`.
    for (const bad of ["", null, undefined, "PUBLIC", "everyone", "world"]) {
      expect(parseVisibility(bad as any)).toBe("friends");
    }
  });

  it("orders the friendship key canonically regardless of argument order", () => {
    expect(friendshipKey("B", "A")).toEqual(["A", "B"]);
    expect(friendshipKey("A", "B")).toEqual(["A", "B"]);
  });
});

// ── Owner profile CRUD ───────────────────────────────────────────────────────
const put = (token: string, body: unknown, ifMatch?: string) =>
  authed(token, "/api/me/profile", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: ifMatch == null ? {} : { "If-Match": ifMatch },
  });

describe("owner profile", () => {
  it("401s without a session", async () => {
    const env = await env0();
    const res = await handleGetMyProfile(new Request("https://flickto.app/api/me/profile"), env);
    expect(res.status).toBe(401);
  });

  it("returns a null profile before the first write", async () => {
    const env = await env0();
    const body = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
    expect(body).toEqual({ profile: null, stats: null });
  });

  it("creates on first PUT, then reads back what was written", async () => {
    const env = await env0();
    const created = await handlePutMyProfile(put("tok-owner", { displayName: "Pear", bio: "hi" }), env);
    expect(created.status).toBe(200);
    expect((await created.json()).version).toBe(1);
    expect(created.headers.get("ETag")).toBe('"1"');

    const got = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
    expect(got.profile.displayName).toBe("Pear");
    expect(got.profile.bio).toBe("hi");
    expect(got.profile.version).toBe(1);
    expect(got.profile.visibility).toBe("friends"); // default, not public
    expect(got.profile.favouriteMovies).toEqual([]); // absent → empty, never null
  });

  it("increments the version on each accepted write", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { displayName: "a" }), env);
    const second = await handlePutMyProfile(put("tok-owner", { displayName: "b" }, "1"), env);
    expect((await second.json()).version).toBe(2);
  });

  it("409s a stale If-Match and reports the current version", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { displayName: "a" }), env);
    await handlePutMyProfile(put("tok-owner", { displayName: "b" }, "1"), env);
    const stale = await handlePutMyProfile(put("tok-owner", { displayName: "c" }, "1"), env);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "version_conflict", version: 2 });
  });

  // Without this, a device with no idea of the current state silently overwrites
  // another device's edit — the exact bug the version column exists to prevent.
  it("409s a PUT with no If-Match once a profile exists", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { displayName: "a" }), env);
    const clobber = await handlePutMyProfile(put("tok-owner", { displayName: "b" }), env);
    expect(clobber.status).toBe(409);
  });

  it("accepts a quoted ETag-style If-Match", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { displayName: "a" }), env);
    expect((await handlePutMyProfile(put("tok-owner", { displayName: "b" }, '"1"'), env)).status).toBe(200);
  });

  it("rejects an oversize layout", async () => {
    const env = await env0();
    const huge = Array.from({ length: 40 }, () => ({ type: "X".repeat(400) }));
    expect((await handlePutMyProfile(put("tok-owner", { layout: huge }), env)).status).toBe(413);
  });

  it("clamps an overlong bio instead of rejecting it", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { bio: "z".repeat(5000) }), env);
    const got = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
    expect(got.profile.bio.length).toBe(500);
  });

  it("never stores an unrecognised visibility as public", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { visibility: "everyone" }), env);
    const got = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
    expect(got.profile.visibility).toBe("friends");
  });

  // Android versions in the wild always lag the API. A client that has never heard
  // of `bio` must not blank it just by saving its own fields.
  describe("partial updates", () => {
    it("carries omitted fields forward instead of blanking them", async () => {
      const env = await env0();
      await handlePutMyProfile(
        put("tok-owner", { displayName: "Pear", bio: "kept", personalityId: "p1", layout: [{ type: "BIO" }] }),
        env,
      );
      // An older client that only knows about displayName saves its change.
      await handlePutMyProfile(put("tok-owner", { displayName: "Pear II" }, "1"), env);

      const got = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
      expect(got.profile.displayName).toBe("Pear II");
      expect(got.profile.bio).toBe("kept");
      expect(got.profile.personalityId).toBe("p1");
      expect(got.profile.layout).toEqual([{ type: "BIO" }]);
    });

    it("still lets a present-but-empty value clear a field", async () => {
      const env = await env0();
      await handlePutMyProfile(put("tok-owner", { displayName: "Pear", bio: "temporary" }), env);
      await handlePutMyProfile(put("tok-owner", { bio: "" }, "1"), env);

      const got = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
      expect(got.profile.bio).toBe("");
      expect(got.profile.displayName).toBe("Pear"); // untouched
    });

    it("preserves visibility when the client omits it", async () => {
      const env = await env0();
      await handlePutMyProfile(put("tok-owner", { visibility: "private" }), env);
      await handlePutMyProfile(put("tok-owner", { displayName: "x" }, "1"), env);

      const got = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
      expect(got.profile.visibility).toBe("private");
    });
  });

  it("400s malformed JSON", async () => {
    const env = await env0();
    const bad = authed("tok-owner", "/api/me/profile", { method: "PUT", body: "{not json" });
    expect((await handlePutMyProfile(bad, env)).status).toBe(400);
  });
});

// ── Stats ────────────────────────────────────────────────────────────────────
describe("owner stats", () => {
  it("round-trips through the split table", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { displayName: "a" }), env);
    const res = await handlePutMyStats(
      authed("tok-owner", "/api/me/stats", { method: "PUT", body: JSON.stringify({ uniqueShows: 12 }) }),
      env,
    );
    expect(res.status).toBe(200);
    const got = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
    expect(got.stats).toEqual({ uniqueShows: 12 });
  });

  it("rejects oversize stats", async () => {
    const env = await env0();
    const huge = { blob: "x".repeat(20_000) };
    const res = await handlePutMyStats(
      authed("tok-owner", "/api/me/stats", { method: "PUT", body: JSON.stringify(huge) }),
      env,
    );
    expect(res.status).toBe(413);
  });
});

// ── Foreign profile reads ────────────────────────────────────────────────────
describe("foreign profile", () => {
  const seedOwner = async (env: any, visibility: string) => {
    await handlePutMyProfile(put("tok-owner", { displayName: "Pear", visibility }), env);
  };

  it("serves a public profile to a stranger", async () => {
    const env = await env0();
    await seedOwner(env, "public");
    const res = await handleGetProfile(OWNER, authed("tok-other", `/api/profile/${OWNER}`), env);
    expect(res.status).toBe(200);
    expect((await res.json()).profile.displayName).toBe("Pear");
  });

  // The non-enumeration property: these two responses must be indistinguishable.
  it("returns an IDENTICAL response for private and nonexistent", async () => {
    const env = await env0();
    await seedOwner(env, "private");
    const denied = await handleGetProfile(OWNER, authed("tok-other", `/api/profile/${OWNER}`), env);
    const missing = await handleGetProfile(OTHER, authed("tok-other", `/api/profile/${OTHER}`), env);

    expect(denied.status).toBe(missing.status);
    expect(await denied.text()).toBe(await missing.text());
  });

  it("404s a blocked viewer on a public profile", async () => {
    const env = await env0();
    await seedOwner(env, "public");
    env.DB.blocks.push({ blocker_id: OWNER, blocked_id: OTHER, created_at: 1 });
    expect((await handleGetProfile(OWNER, authed("tok-other", `/api/profile/${OWNER}`), env)).status).toBe(404);
  });

  it("lets the owner read their own profile through the foreign route", async () => {
    const env = await env0();
    await seedOwner(env, "private");
    expect((await handleGetProfile(OWNER, authed("tok-owner", `/api/profile/${OWNER}`), env)).status).toBe(200);
  });

  it("404s a malformed user id without hitting the database", async () => {
    const env = await env0();
    expect((await handleGetProfile("not-an-id", authed("tok-other", "/api/profile/x"), env)).status).toBe(404);
  });

  it("401s without a session", async () => {
    const env = await env0();
    const res = await handleGetProfile(OWNER, new Request(`https://flickto.app/api/profile/${OWNER}`), env);
    expect(res.status).toBe(401);
  });
});

// ── Bootstrap ────────────────────────────────────────────────────────────────
describe("bootstrap", () => {
  it("returns profile, stats and empty friend collections in one response", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { displayName: "Pear" }), env);
    const body = (await (await handleBootstrap(authed("tok-owner", "/api/me/bootstrap"), env)).json()) as any;

    expect(body.userId).toBe(OWNER);
    expect(body.profile.displayName).toBe("Pear");
    // Present-but-empty until Phase 3. Clients must tolerate this, not error on it.
    expect(body.friends).toEqual([]);
    expect(body.pending).toEqual([]);
    expect(typeof body.serverTime).toBe("number");
  });

  it("returns a null profile for a signed-in user who has none", async () => {
    const env = await env0();
    const body = (await (await handleBootstrap(authed("tok-owner", "/api/me/bootstrap"), env)).json()) as any;
    expect(body.profile).toBeNull();
    expect(body.stats).toBeNull();
    expect(body.userId).toBe(OWNER);
  });

  it("401s without a session", async () => {
    const env = await env0();
    expect((await handleBootstrap(new Request("https://flickto.app/api/me/bootstrap"), env)).status).toBe(401);
  });
});
