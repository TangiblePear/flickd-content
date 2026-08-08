import { describe, it, expect } from "vitest";
import { canView, parseVisibility, friendshipKey } from "./authz";
import {
  appVersion,
  handleBootstrap,
  handleGetMyProfile,
  handleGetProfile,
  handlePutMyProfile,
  handlePutMyStats,
  minSocialVersion,
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
  /** Migration 0024. Bootstrap reads both, so the fake has to know them. */
  user_settings: Row[] = [];
  user_achievements: Row[] = [];
  friendships: Row[] = [];
  blocks: Row[] = [];
  /** Only `posting_suspended_until` is read from here; the rest of the row is irrelevant. */
  users: Row[] = [];
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
    if (s.includes("FROM profiles p LEFT JOIN users")) {
      const row = this.db.profiles.find((p) => p.user_id === this.args[0]);
      if (!row) return null;
      return (s.startsWith("SELECT version") ? { version: row.version } : row) as T;
    }
    if (s.includes("FROM user_settings WHERE user_id = ?")) {
      return (this.db.user_settings.find((r) => r.user_id === this.args[0]) ?? null) as T | null;
    }
    if (s.includes("FROM user_achievements WHERE user_id = ?")) {
      return (this.db.user_achievements.find((r) => r.user_id === this.args[0]) ?? null) as T | null;
    }
    if (s.startsWith("SELECT stats, public_stats FROM profile_stats")) {
      const row = this.db.profile_stats.find((p) => p.user_id === this.args[0]);
      return row ? ({ stats: row.stats, public_stats: row.public_stats ?? null } as T) : null;
    }
    if (s.startsWith("SELECT stats FROM profile_stats")) {
      const row = this.db.profile_stats.find((p) => p.user_id === this.args[0]);
      return row ? ({ stats: row.stats } as T) : null;
    }
    if (s.startsWith("SELECT public_stats FROM profile_stats")) {
      const row = this.db.profile_stats.find((p) => p.user_id === this.args[0]);
      return row ? ({ public_stats: row.public_stats ?? null } as T) : null;
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
    if (s.startsWith("SELECT posting_suspended_until")) {
      const row = this.db.users.find((u) => u.id === this.args[0]);
      return row ? ({ until: row.posting_suspended_until ?? null } as T) : null;
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
        friend_layout,
        public_layout,
        bio,
        favourite_movies,
        favourite_shows,
        favourite_people,
        featured_achievements,
        personality_id,
        visibility,
        version,
        updated_at,
        friend_sensitive_consent_at,
        public_sensitive_consent_at,
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
        friend_layout,
        public_layout,
        bio,
        favourite_movies,
        favourite_shows,
        favourite_people,
        featured_achievements,
        personality_id,
        visibility,
        version,
        updated_at,
        friend_sensitive_consent_at,
        public_sensitive_consent_at,
      };
      const at = this.db.profiles.findIndex((p) => p.user_id === user_id);
      if (at >= 0) this.db.profiles[at] = row;
      else this.db.profiles.push(row);
      return { success: true };
    }
    if (s.startsWith("INSERT INTO profile_stats (user_id, stats, public_stats, updated_at)")) {
      const [user_id, stats, public_stats, updated_at] = this.args;
      const at = this.db.profile_stats.findIndex((p) => p.user_id === user_id);
      const row = { user_id, stats, public_stats, updated_at };
      if (at >= 0) this.db.profile_stats[at] = row;
      else this.db.profile_stats.push(row);
      return { success: true };
    }
    if (s.startsWith("INSERT INTO profile_stats")) {
      const [user_id, stats, updated_at] = this.args;
      const at = this.db.profile_stats.findIndex((p) => p.user_id === user_id);
      // Legacy path: public_stats is left as it was, never blanked.
      const prev = this.db.profile_stats[at];
      const row = { user_id, stats, public_stats: prev?.public_stats ?? null, updated_at };
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

/** An unauthenticated request for a profile — what `/u/{id}` sends. */
const anonReq = (id: string = OWNER) => new Request(`https://flickto.app/api/profile/${id}`);

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
    expect(await canView(env, OWNER, OWNER, "private")).toBe("owner");
  });

  it("allows a stranger to read a public profile", async () => {
    expect(await canView(await env0(), OTHER, OWNER, "public")).toBe("public");
  });

  it("denies a stranger on a friends-only profile", async () => {
    expect(await canView(await env0(), OTHER, OWNER, "friends")).toBeNull();
  });

  it("allows an accepted friend on a friends-only profile", async () => {
    const env = await env0();
    const [a, b] = friendshipKey(OWNER, OTHER);
    env.DB.friendships.push({ user_a: a, user_b: b, state: "accepted" });
    expect(await canView(env, OTHER, OWNER, "friends")).toBe("friend");
  });

  /**
   * The friendship is checked BEFORE `public`, so a friend reading a public profile keeps
   * the friend-scoped layout instead of being downgraded to the stranger view. Getting
   * this backwards would silently strip friends of the blocks they are entitled to see the
   * moment the owner went public.
   */
  it("grants friend, not public, when a friend reads a PUBLIC profile", async () => {
    const env = await env0();
    const [a, b] = friendshipKey(OWNER, OTHER);
    env.DB.friendships.push({ user_a: a, user_b: b, state: "accepted" });
    expect(await canView(env, OTHER, OWNER, "public")).toBe("friend");
  });

  it("treats a pending request as NOT a friend", async () => {
    const env = await env0();
    const [a, b] = friendshipKey(OWNER, OTHER);
    env.DB.friendships.push({ user_a: a, user_b: b, state: "pending" });
    expect(await canView(env, OTHER, OWNER, "friends")).toBeNull();
  });

  it("denies an accepted friend on a private profile", async () => {
    const env = await env0();
    const [a, b] = friendshipKey(OWNER, OTHER);
    env.DB.friendships.push({ user_a: a, user_b: b, state: "accepted" });
    expect(await canView(env, OTHER, OWNER, "private")).toBeNull();
  });

  // The ordering test that matters: blocks are evaluated before visibility, so a
  // public profile is still denied. Getting this backwards is the classic leak.
  it("denies a blocked viewer even on a PUBLIC profile", async () => {
    const env = await env0();
    env.DB.blocks.push({ blocker_id: OWNER, blocked_id: OTHER, created_at: 1 });
    expect(await canView(env, OTHER, OWNER, "public")).toBeNull();
  });

  it("denies when the VIEWER blocked the owner, not just the reverse", async () => {
    const env = await env0();
    env.DB.blocks.push({ blocker_id: OTHER, blocked_id: OWNER, created_at: 1 });
    expect(await canView(env, OTHER, OWNER, "public")).toBeNull();
  });

  it("blocks override an accepted friendship", async () => {
    const env = await env0();
    const [a, b] = friendshipKey(OWNER, OTHER);
    env.DB.friendships.push({ user_a: a, user_b: b, state: "accepted" });
    env.DB.blocks.push({ blocker_id: OWNER, blocked_id: OTHER, created_at: 1 });
    expect(await canView(env, OTHER, OWNER, "friends")).toBeNull();
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

  /**
   * The clear path, and the reason `publicLayout` is always sent rather than omitted when
   * a profile stops being public. Omitting it would strand the stale public payload here,
   * ready to go live again the moment the owner flips back — possibly showing blocks they
   * have since removed.
   */
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

  const putStats = (env: any, body: unknown) =>
    handlePutMyStats(
      authed("tok-owner", "/api/me/stats", { method: "PUT", body: JSON.stringify(body) }),
      env,
    );

  it("stores both blobs from one envelope", async () => {
    const env = await env0();
    await putStats(env, { stats: { uniqueShows: 5 }, publicStats: { uniqueShows: 0 } });
    const row = env.DB.profile_stats[0];
    expect(JSON.parse(row.stats as string).uniqueShows).toBe(5);
    expect(JSON.parse(row.public_stats as string).uniqueShows).toBe(0);
  });

  it("clears public_stats when sent null", async () => {
    const env = await env0();
    await putStats(env, { stats: { uniqueShows: 5 }, publicStats: { uniqueShows: 0 } });
    await putStats(env, { stats: { uniqueShows: 5 }, publicStats: null });
    expect(env.DB.profile_stats[0].public_stats).toBeNull();
  });

  /**
   * Shipped Android builds send the bare snapshot and must keep working between the
   * worker deploy and the app release. It is the friend stats; public_stats stays
   * untouched, because those builds publish no public layout to match it to.
   */
  it("accepts a bare legacy body as the friend stats, leaving public_stats alone", async () => {
    const env = await env0();
    await putStats(env, { stats: { uniqueShows: 5 }, publicStats: { uniqueShows: 0 } });
    await putStats(env, { uniqueShows: 7 });
    const row = env.DB.profile_stats[0];
    expect(JSON.parse(row.stats as string).uniqueShows).toBe(7);
    expect(JSON.parse(row.public_stats as string).uniqueShows).toBe(0);
  });

  it("rejects an oversize publicStats", async () => {
    const env = await env0();
    const res = await putStats(env, { stats: { a: 1 }, publicStats: { blob: "x".repeat(20_000) } });
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

  // ── The friend / stranger split ────────────────────────────────────────────
  // A stranger and a friend read the same row and must receive different things.

  const seedBothLayouts = async (env: any) => {
    await handlePutMyProfile(
      put("tok-owner", {
        displayName: "Pear",
        visibility: "public",
        layout: [{ type: "bio" }, { type: "recent_activity" }, { type: "owner_secret" }],
        friendLayout: [{ type: "bio" }, { type: "recent_activity" }],
        publicLayout: [{ type: "bio" }],
      }),
      env,
    );
    await handlePutMyStats(
      authed("tok-owner", "/api/me/stats", {
        method: "PUT",
        body: JSON.stringify({
          stats: { uniqueShows: 42, recentWatches: [{ tmdbId: 1, mediaType: "SHOW" }] },
          publicStats: { uniqueShows: 0, recentWatches: [] },
        }),
      }),
      env,
    );
  };

  const foreignBody = async (env: any, token: string) =>
    (await (await handleGetProfile(OWNER, authed(token, `/api/profile/${OWNER}`), env)).json()) as any;

  /**
   * The owner needs both derived layouts back, because editing `layout` has to
   * republish them — an omitted key is carried over, so a client that sends
   * only `layout` freezes what everyone else sees.
   */
  it("still returns the legacy derived layouts to the OWNER", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { displayName: "Pear", layout: [{ type: "bio" }] }), env);
    // Set on the row, not through the body: the write path ignores them now.
    // They are a frozen rollback snapshot until the migration drops the columns,
    // and this pins that they are still handed back until then.
    env.DB.profiles[0].friend_layout = JSON.stringify([{ type: "bio" }]);
    env.DB.profiles[0].public_layout = JSON.stringify([{ type: "bio" }]);

    const mine = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
    expect(mine.profile.friendLayout).toEqual([{ type: "bio" }]);
    expect(mine.profile.publicLayout).toEqual([{ type: "bio" }]);
  });

  /**
   * …and NOBODY else does. `toOwnerWire` is deliberately separate from `toWire`
   * for this reason: a field added to the shared one reaches strangers, and
   * `friendLayout` would hand a stranger the friend-scoped arrangement the
   * public/friend split exists to keep apart.
   */
  it("never sends the derived layouts to a foreign reader", async () => {
    const env = await env0();
    await seedBothLayouts(env);
    for (const token of ["tok-other", null]) {
      const req = token ? authed(token, `/api/profile/${OWNER}`) : new Request(`https://x/api/profile/${OWNER}`);
      const body = (await (await handleGetProfile(OWNER, req, env)).json()) as any;
      expect(body.profile).not.toHaveProperty("friendLayout");
      expect(body.profile).not.toHaveProperty("publicLayout");
    }
  });

  /**
   * Production had it backwards: `public_stats` held the per-title keys and
   * `stats` held none. Consolidating onto `stats` alone deleted them from a
   * live profile, so the richer column backfills absent keys until the app
   * publishes them where they belong.
   */
  it("backfills per-title keys from the legacy public_stats when stats lacks them", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { displayName: "Pear", visibility: "public" }), env);
    env.DB.profiles[0].public_sensitive_consent_at = 1;
    env.DB.profile_stats.push({
      user_id: OWNER,
      stats: JSON.stringify({ uniqueShows: 9 }),
      public_stats: JSON.stringify({ uniqueShows: 0, recentWatches: [{ tmdbId: 1 }] }),
      updated_at: 1,
    });

    const body = (await (await handleGetProfile(OWNER, anonReq(), env)).json()) as any;
    expect(body.stats.recentWatches).toEqual([{ tmdbId: 1 }]);
    // The canonical column still wins where it HAS a value.
    expect(body.stats.uniqueShows).toBe(9);
  });

  it("stores the consent flags a client sends", async () => {
    const env = await env0();
    await handlePutMyProfile(
      put("tok-owner", { displayName: "Pear", visibility: "public", publicSensitiveConsentAt: 1712000000000 }),
      env,
    );
    expect(env.DB.profiles[0].public_sensitive_consent_at).toBe(1712000000000);
  });

  /**
   * Deployed builds still send all three layouts. Accepting one would reinstate
   * the drift read-time filtering exists to remove.
   */
  it("ignores friendLayout and publicLayout from an older client", async () => {
    const env = await env0();
    await handlePutMyProfile(
      put("tok-owner", {
        displayName: "Pear",
        visibility: "public",
        layout: [{ type: "bio" }],
        friendLayout: [{ type: "stat_mosaic" }],
        publicLayout: [{ type: "stat_mosaic" }],
      }),
      env,
    );
    env.DB.profiles[0].public_sensitive_consent_at = 1;
    const body = (await (await handleGetProfile(OWNER, anonReq(), env)).json()) as any;
    expect(body.profile.layout).toEqual([{ type: "bio" }]);
  });

  it("filters the CANONICAL layout instead of reading a stored copy", async () => {
    const env = await env0();
    // Only `layout` is written — no friendLayout, no publicLayout.
    await handlePutMyProfile(
      put("tok-owner", {
        displayName: "Pear",
        visibility: "public",
        layout: [{ type: "bio" }, { type: "stat_mosaic" }, { type: "trophy_case" }],
      }),
      env,
    );
    env.DB.profiles[0].public_sensitive_consent_at = 1;

    const body = (await (await handleGetProfile(OWNER, anonReq(), env)).json()) as any;
    // trophy_case is owner-only and must never appear; order is preserved.
    expect(body.profile.layout).toEqual([{ type: "bio" }, { type: "stat_mosaic" }]);
  });

  it("withholds the behavioural half from a stranger with no public consent", async () => {
    const env = await env0();
    await handlePutMyProfile(
      put("tok-owner", {
        displayName: "Pear",
        visibility: "public",
        layout: [{ type: "bio" }, { type: "stat_mosaic" }],
      }),
      env,
    );
    const body = (await (await handleGetProfile(OWNER, anonReq(), env)).json()) as any;
    expect(body.profile.layout).toEqual([{ type: "bio" }]);
  });

  it("serves ONE stats blob, stripped per audience", async () => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", { displayName: "Pear", visibility: "public" }), env);
    await handlePutMyStats(
      authed("tok-owner", "/api/me/stats", {
        method: "PUT",
        body: JSON.stringify({ stats: { uniqueShows: 9, recentWatches: [{ tmdbId: 1 }] } }),
      }),
      env,
    );

    const withheld = (await (await handleGetProfile(OWNER, anonReq(), env)).json()) as any;
    expect(withheld.stats).toEqual({ uniqueShows: 9 });

    env.DB.profiles[0].public_sensitive_consent_at = 1;
    const shared = (await (await handleGetProfile(OWNER, anonReq(), env)).json()) as any;
    expect(shared.stats.recentWatches).toEqual([{ tmdbId: 1 }]);
  });

  it("serves the curated half and stripped stats to a stranger", async () => {
    const env = await env0();
    await seedBothLayouts(env);
    // No public consent, so the behavioural blocks and per-title stats are
    // withheld — derived from the canonical layout, not a stored copy.
    const body = await foreignBody(env, "tok-other");
    expect(body.profile.layout).toEqual([{ type: "bio" }]);
    expect(body.stats.recentWatches).toBeUndefined();
    expect(body.stats.uniqueShows).toBe(42);
  });

  it("serves the friend view, with sensitive blocks, to a friend of a PUBLIC profile", async () => {
    const env = await env0();
    await seedBothLayouts(env);
    env.DB.profiles[0].friend_sensitive_consent_at = 1;
    env.DB.friendships.push({ user_a: OWNER < OTHER ? OWNER : OTHER, user_b: OWNER < OTHER ? OTHER : OWNER, state: "accepted" });
    const body = await foreignBody(env, "tok-other");
    // The friendship is checked BEFORE `public`, so a friend keeps the richer
    // view even on a public profile.
    expect(body.profile.layout).toEqual([{ type: "bio" }, { type: "recent_activity" }]);
    expect(body.stats.recentWatches).toEqual([{ tmdbId: 1, mediaType: "SHOW" }]);
  });

  it("never leaks the owner's unfiltered layout to a stranger", async () => {
    const env = await env0();
    await seedBothLayouts(env);
    expect(JSON.stringify(await foreignBody(env, "tok-other"))).not.toContain("owner_secret");
  });

  /**
   * NULL public_layout means "this client predates the field", so identity-only. Falling
   * back to friend_layout would serve strangers a layout filtered under a consent given
   * for FRIENDS — the exact thing the third column exists to prevent.
   */

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

  /**
   * Was `401s without a session`, until `flickto.app/u/{userId}` had to serve people
   * who do not have an account. A session is no longer required — but the profile
   * seeded here is the default `friends`, so a signed-out reader still gets nothing,
   * and gets it as the ordinary not-found rather than as a 401 that would confirm the
   * account exists. The signed-out contract is covered in "without a session" below.
   */
  it("404s, not 401s, for a signed-out reader who may not see the profile", async () => {
    const env = await env0();
    await seedOwner(env, "friends");
    const res = await handleGetProfile(OWNER, new Request(`https://flickto.app/api/profile/${OWNER}`), env);
    expect(res.status).toBe(404);
  });

  /**
   * The reason `friend_layout` exists at all. `layout` is the OWNER'S — it is the restore
   * source, so it cannot be filtered at the push without deleting their private blocks on
   * reinstall — and it contains the blocks `friendVisibleLayout` strips, including the
   * consent-gated sensitive trio. A foreign reader must receive the filtered one, under
   * the same field name, and must not receive the unfiltered one at all.
   */
  it("serves a friend the FILTERED layout, and never the owner's", async () => {
    const env = await env0();
    // OTHER must actually BE a friend now that the grant distinguishes them: a stranger
    // on a public profile would correctly receive `public_layout` instead.
    const [fa, fb] = friendshipKey(OWNER, OTHER);
    env.DB.friendships.push({ user_a: fa, user_b: fb, state: "accepted" });
    await handlePutMyProfile(
      put("tok-owner", {
        displayName: "Pear",
        visibility: "public",
        layout: [{ type: "stat_mosaic" }, { type: "top_rated" }],
        friendLayout: [{ type: "stat_mosaic" }],
      }),
      env,
    );

    const foreign = (await (await handleGetProfile(OWNER, authed("tok-other", `/api/profile/${OWNER}`), env)).json()) as any;
    expect(foreign.profile.layout).toEqual([{ type: "stat_mosaic" }]);
    // Not merely "filtered" — the unfiltered list must be absent from the body entirely,
    // so no caller can reach it by picking the wrong field.
    expect(JSON.stringify(foreign)).not.toContain("top_rated");

    // The owner still gets their own, unfiltered, through their own endpoint.
    const own = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
    expect(own.profile.layout).toEqual([{ type: "stat_mosaic" }, { type: "top_rated" }]);
  });

  /**
   * NULL is "this client predates the field", not "no blocks". Serving `[]` for it would
   * flip every friend of an un-updated client to the default layout, which looks like a
   * rendering bug and is really a wire-compat one.
   */
  it("sends null when nothing has ever been published, and [] when nothing is shareable", async () => {
    const env = await env0();
    // Never published a layout at all: the reader keeps whatever it had.
    await handlePutMyProfile(put("tok-owner", { displayName: "Pear", visibility: "public" }), env);
    expect(env.DB.profiles[0].layout).toBeNull();
    let body = await foreignBody(env, "tok-other");
    expect(body.profile.layout).toBeNull();

    // Published, but none of it is a stranger's to see. That is a real answer,
    // not "unchanged" — the old derived columns could not tell these apart.
    await handlePutMyProfile(
      put("tok-owner", { layout: [{ type: "stat_mosaic" }] }, "1"),
      env,
    );
    body = await foreignBody(env, "tok-other");
    expect(body.profile.layout).toEqual([]);
  });

  // ── Signed out: what flickto.app/u/{userId} serves ─────────────────────────
  // A reader with no session must reach the `public` audience and nothing else.
  describe("without a session", () => {
    const anon = (userId = OWNER) => new Request(`https://flickto.app/api/profile/${userId}`);

    it("serves a public profile to a reader with no session", async () => {
      const env = await env0();
      await seedOwner(env, "public");
      const res = await handleGetProfile(OWNER, anon(), env);
      expect(res.status).toBe(200);
      expect((await res.json()).profile.displayName).toBe("Pear");
    });

    it("serves the STRANGER view, never the friend view", async () => {
      const env = await env0();
      await seedBothLayouts(env);
      const body = (await (await handleGetProfile(OWNER, anon(), env)).json()) as any;
      expect(body.profile.layout).toEqual([{ type: "bio" }]);
      expect(body.stats.recentWatches).toBeUndefined();
    });

    /**
     * The no-oracle rule from authz.ts, now that the endpoint answers strangers.
     *
     * Signing out must reveal strictly LESS than signing in. If a friends-only
     * profile answered anything other than the not-found response — a 401, a
     * different body, even a different header — the endpoint would confirm that
     * an account exists, and `/u/{id}` would become an account enumerator that
     * needs no credentials at all.
     */
    it("cannot be used to tell a hidden profile from one that does not exist", async () => {
      const friendsEnv = await env0();
      await seedOwner(friendsEnv, "friends");
      const privateEnv = await env0();
      await seedOwner(privateEnv, "private");
      const emptyEnv = await env0();

      const [friends, priv, missing] = await Promise.all([
        handleGetProfile(OWNER, anon(), friendsEnv),
        handleGetProfile(OWNER, anon(), privateEnv),
        handleGetProfile(OWNER, anon(), emptyEnv),
      ]);

      for (const res of [friends, priv, missing]) expect(res.status).toBe(404);
      const bodies = await Promise.all([friends.text(), priv.text(), missing.text()]);
      expect(bodies[0]).toBe(bodies[2]);
      expect(bodies[1]).toBe(bodies[2]);
    });

    it("404s a malformed id without touching the database", async () => {
      const env = await env0();
      const res = await handleGetProfile("not-a-user-id", anon("not-a-user-id"), env);
      expect(res.status).toBe(404);
    });
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

  it("carries the social floor so the client can gate itself", async () => {
    const env = await env0();
    (env as any).MIN_SOCIAL_VERSION = "42";
    const body = (await (await handleBootstrap(authed("tok-owner", "/api/me/bootstrap"), env)).json()) as any;
    expect(body.minSocialVersion).toBe(42);
  });

  it("reports no floor when the var is unset", async () => {
    const env = await env0();
    const body = (await (await handleBootstrap(authed("tok-owner", "/api/me/bootstrap"), env)).json()) as any;
    expect(body.minSocialVersion).toBe(0);
  });
});

// ── The social version floor ─────────────────────────────────────────────────
// Both helpers exist to fail OPEN. A bad var or a missing header must never lock
// a user out of Friends, so every malformed input has to land on 0 ("no opinion")
// rather than on something that could be compared as "too old".
describe("minSocialVersion", () => {
  it("reads a configured floor", () => {
    expect(minSocialVersion({ MIN_SOCIAL_VERSION: "1234" })).toBe(1234);
  });

  it("is 0 when unset, empty, negative, or not a number", () => {
    expect(minSocialVersion({})).toBe(0);
    expect(minSocialVersion({ MIN_SOCIAL_VERSION: "" })).toBe(0);
    expect(minSocialVersion({ MIN_SOCIAL_VERSION: "-5" })).toBe(0);
    expect(minSocialVersion({ MIN_SOCIAL_VERSION: "banana" })).toBe(0);
    // A typo here would otherwise lock every user out of the social surface.
    expect(minSocialVersion({ MIN_SOCIAL_VERSION: "12 34" })).toBe(0);
  });

  it("floors a decimal rather than rejecting it", () => {
    expect(minSocialVersion({ MIN_SOCIAL_VERSION: "42.9" })).toBe(42);
  });
});

describe("appVersion", () => {
  const withHeader = (v: string) =>
    new Request("https://flickto.app/api/user/ABCDEF123456/profile", { headers: { "X-App-Version": v } });

  it("reads the header", () => {
    expect(appVersion(withHeader("77"))).toBe(77);
  });

  it("is 0 when the header is absent — the PWA and pre-gate builds send none", () => {
    expect(appVersion(new Request("https://flickto.app/api/user/ABCDEF123456/profile"))).toBe(0);
  });

  it("is 0 for junk, so a mangled header cannot read as 'too old'", () => {
    expect(appVersion(withHeader("banana"))).toBe(0);
    expect(appVersion(withHeader("-1"))).toBe(0);
    expect(appVersion(withHeader(""))).toBe(0);
  });
});

// ── Posting suspension, profile TEXT only ────────────────────────────────────
// The guard compares VALUES, it does not check for keys, and that distinction is the
// whole feature. Android's `ProfileWriteRequest` declares all 14 fields non-optional
// and sends every one on every save, so a presence check would also block avatar,
// border, layout and favourite edits — none of them abuse surfaces — turning a posting
// ban into an editing lockout.

/** A PUT body in the shape Android actually sends: every field, every time. */
const fullBody = (over: Record<string, unknown> = {}) => ({
  displayName: "Pear",
  avatarId: "a1",
  borderId: "",
  pictureUrl: "",
  headerColor: "",
  headerBackdropUrl: "",
  favouriteMovies: [],
  favouriteShows: [],
  featuredAchievements: [],
  layout: [],
  bio: "hello",
  favouritePeople: [],
  personalityId: "",
  visibility: "friends",
  ...over,
});

describe("posting suspension on the profile PUT", () => {
  /** A profile at version 1 holding displayName "Pear" and bio "hello". */
  const seeded = async (suspendedUntil: number | null) => {
    const env = await env0();
    await handlePutMyProfile(put("tok-owner", fullBody()), env);
    env.DB.users.push({ id: OWNER, posting_suspended_until: suspendedUntil });
    return env;
  };

  it("blocks a bio change while suspended", async () => {
    const env = await seeded(Date.now() + 86_400_000);
    const res = await handlePutMyProfile(put("tok-owner", fullBody({ bio: "something new" }), "1"), env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("posting_suspended");
    // The version must NOT move: a refused write is not a write.
    const got = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
    expect(got.profile.bio).toBe("hello");
    expect(got.profile.version).toBe(1);
  });

  it("blocks a display-name change while suspended", async () => {
    const env = await seeded(Date.now() + 86_400_000);
    const res = await handlePutMyProfile(put("tok-owner", fullBody({ displayName: "Mango" }), "1"), env);
    expect(res.status).toBe(403);
  });

  // The point of the whole task. Android resends bio and displayName unchanged on every
  // save; if that counted as "posting", changing an avatar would be blocked.
  it("permits an avatar-only edit that resends the same bio and name", async () => {
    const env = await seeded(Date.now() + 86_400_000);
    const res = await handlePutMyProfile(put("tok-owner", fullBody({ avatarId: "a2" }), "1"), env);
    expect(res.status).toBe(200);
    const got = (await (await handleGetMyProfile(authed("tok-owner", "/api/me/profile"), env)).json()) as any;
    expect(got.profile.avatarId).toBe("a2");
  });

  it("permits a bio change when not suspended", async () => {
    const env = await seeded(null);
    expect((await handlePutMyProfile(put("tok-owner", fullBody({ bio: "brand new" }), "1"), env)).status).toBe(200);
  });

  it("permits a bio change once the suspension has elapsed, with no manual step", async () => {
    const env = await seeded(Date.now() - 1_000);
    expect((await handlePutMyProfile(put("tok-owner", fullBody({ bio: "brand new" }), "1"), env)).status).toBe(200);
  });
});
