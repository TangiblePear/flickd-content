import { describe, expect, it } from "vitest";
import { TestD1, adminPost, adminReq, seedDevice, seedSession, seedUser, testEnv, uid } from "./testD1";
import { compUntil, foldTelemetry, handleUserDetail, handleUsersAct, handleUsersList } from "./usersAdmin";
import { PERMANENT_UNTIL } from "./suspension";

const DAY = 86_400_000;

const list = async (db: TestD1, env = testEnv(db)) => {
  const res = await handleUsersList(adminReq("/api/users"), env);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    total: number;
    truncated: boolean;
    users: Array<Record<string, any>>;
  };
};

const act = (db: TestD1, body: unknown, env = testEnv(db)) => handleUsersAct(adminPost("/api/users/act", body), env);

// The shim runs the real migrations, so a failure here means the schema and the queries
// disagree — which is the whole point of not using a string-matching double.
describe("the test harness itself", () => {
  it("builds production's schema from the migration files", () => {
    const db = new TestD1();
    const cols = db.rows<{ name: string }>("SELECT name FROM pragma_table_info('users')").map((r) => r.name);
    expect(cols).toContain("premiere_comp_until");
    expect(cols).toContain("posting_suspended_until");
    expect(db.count("admin_actions")).toBe(0);
  });
});

describe("authorization", () => {
  it("401s without a matching ADMIN_KEY, and fails CLOSED when none is set", async () => {
    const db = new TestD1();
    expect((await handleUsersList(adminReq("/api/users", "wrong"), testEnv(db))).status).toBe(401);
    // No ADMIN_KEY configured at all must not mean "no gate".
    expect((await handleUsersList(adminReq("/api/users"), testEnv(db, { ADMIN_KEY: undefined }))).status).toBe(401);
    expect((await act(db, { userId: uid(1), action: "ban" }, testEnv(db, { ADMIN_KEY: undefined }))).status).toBe(401);
  });
});

describe("GET /api/users", () => {
  it("returns an account with no profile, identity, history or device", async () => {
    const db = new TestD1();
    seedUser(db, { id: uid(1), email: null, displayName: null });

    const { users, total } = await list(db);
    expect(total).toBe(1);
    expect(users).toHaveLength(1);
    const u = users[0];
    // The LEFT JOINs are load-bearing: an INNER JOIN anywhere would drop exactly this
    // account, which is the one most worth looking at.
    expect(u.id).toBe(uid(1));
    expect(u.email).toBeNull();
    expect(u.displayName).toBeNull();
    expect(u.devices).toBe(0);
    expect(u.serverEvents).toBeNull();
    expect(u.flags.orphan).toBe(true);
    expect(u.flags.noProfile).toBe(true);
    expect(u.flags.noEmail).toBe(true);
  });

  it("carries full identity — the whole difference from the Insights roster", async () => {
    const db = new TestD1();
    seedUser(db, { id: uid(2), email: "jamie@example.com", displayName: "Jamie R" });

    const u = (await list(db)).users[0];
    expect(u.id).toBe(uid(2)); // full id, not a 6-char prefix
    expect(u.email).toBe("jamie@example.com");
    expect(u.displayName).toBe("Jamie R");
    expect(u.firebaseUid).toBe(`uid-${uid(2)}`);
  });

  /**
   * The friendship count is stored once in canonical order, so counting one column halves
   * it. This is the assertion a string-matching double cannot make at all.
   */
  it("counts a friendship from BOTH sides", async () => {
    const db = new TestD1();
    const [a, b] = [uid(3), uid(4)];
    seedUser(db, { id: a });
    seedUser(db, { id: b });
    // Canonical order: user_a < user_b.
    const [lo, hi] = [a, b].sort();
    db.exec(
      `INSERT INTO friendships (user_a, user_b, state, requested_by, created_at, updated_at)
       VALUES ('${lo}', '${hi}', 'accepted', '${lo}', 1, 1)`,
    );

    const { users } = await list(db);
    expect(users.find((u) => u.id === a)!.friends).toBe(1);
    expect(users.find((u) => u.id === b)!.friends).toBe(1);
  });

  it("separates comments from their hidden and deleted subsets", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(5) });
    // ⚠️ A DIFFERENT tmdb_id each time. `idx_comments_author_subject` is UNIQUE on
    // (author_id, tmdb_id, media_type, season, episode) — one comment per person per
    // subject — so three comments on one title is a state that cannot exist. Caught by
    // running against the real schema; a hand-written double would have accepted it and
    // the test would have "passed" against an impossible fixture.
    const row = (n: number, extra?: "hidden_at" | "deleted_at") =>
      `INSERT INTO comments (id, tmdb_id, media_type, season, episode, author_id, body, visibility,
                             spoiler, created_at, updated_at${extra ? `, ${extra}` : ""})
       VALUES ('C${n}', ${n}, 'movie', -1, -1, '${a}', 'hi', 'public', 0, 1, 1${extra ? `, ${Date.now()}` : ""})`;
    db.exec(row(1));
    db.exec(row(2, "hidden_at"));
    db.exec(row(3, "deleted_at"));

    const u = (await list(db)).users[0];
    // Live comments exclude the deleted one but INCLUDE the hidden one — hidden is a
    // moderation state, not an absence.
    expect(u.comments).toBe(2);
    expect(u.commentsHidden).toBe(1);
    expect(u.commentsDeleted).toBe(1);
  });

  it("reads pre-computed history and list totals rather than counting rows", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(6) });
    db.exec(
      `INSERT INTO history_meta (user_id, version, event_count, title_count, last_watched_at, updated_at)
       VALUES ('${a}', 4, 412, 96, 1700, 1700)`,
    );
    db.exec(`INSERT INTO lists_meta (user_id, version, list_count, item_count, updated_at)
             VALUES ('${a}', 2, 7, 130, 1700)`);

    const u = (await list(db)).users[0];
    expect(u.serverEvents).toBe(412);
    expect(u.titleCount).toBe(96);
    expect(u.lists).toBe(7);
    expect(u.listItems).toBe(130);
  });

  it("counts achievements from the JSON payload, and survives a malformed one", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(7) });
    const b = seedUser(db, { id: uid(8) });
    db.exec(
      `INSERT INTO user_achievements (user_id, payload, rules_version, version, updated_at)
       VALUES ('${a}', '[{"id":"x"},{"id":"y"},{"id":"z"}]', 5, 1, 1)`,
    );
    // Not JSON at all. One bad row must not fail the whole query for everyone.
    db.exec(
      `INSERT INTO user_achievements (user_id, payload, rules_version, version, updated_at)
       VALUES ('${b}', 'not json', 5, 1, 1)`,
    );

    const { users } = await list(db);
    expect(users.find((u) => u.id === a)!.achievements).toBe(3);
    expect(users.find((u) => u.id === a)!.achievementsRulesVersion).toBe(5);
    expect(users.find((u) => u.id === b)!.achievements).toBe(0);
  });

  it("flags a library that exists on the device and not on the server", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(9) });
    seedDevice(db, { userId: a, watched: 240 });

    const u = (await list(db)).users[0];
    expect(u.clientCounts.watched).toBe(240);
    expect(u.serverEvents).toBeNull();
    expect(u.flags.historyNotUploaded).toBe(true);
  });

  it("does not flag an uploaded library", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(10) });
    seedDevice(db, { userId: a, watched: 240 });
    db.exec(
      `INSERT INTO history_meta (user_id, version, event_count, title_count, updated_at)
       VALUES ('${a}', 1, 240, 80, 1)`,
    );

    expect((await list(db)).users[0].flags.historyNotUploaded).toBe(false);
  });

  it("reports the entitling SOURCE, so paid and comped can be told apart", async () => {
    const db = new TestD1();
    const soon = Date.now() + 30 * DAY;
    seedUser(db, { id: uid(11), premiereUntil: soon });
    seedUser(db, { id: uid(12), premiereCompUntil: soon });
    seedUser(db, { id: uid(13), premiereUntil: soon, premiereCompUntil: soon });
    seedUser(db, { id: uid(14) });
    // Expired on both sides.
    seedUser(db, { id: uid(15), premiereUntil: Date.now() - DAY, premiereCompUntil: Date.now() - DAY });

    const { users } = await list(db);
    const src = (id: string) => users.find((u) => u.id === id)!;
    expect(src(uid(11)).premiereSource).toBe("paid");
    expect(src(uid(12)).premiereSource).toBe("comp");
    expect(src(uid(13)).premiereSource).toBe("both");
    expect(src(uid(14)).premiereSource).toBeNull();
    expect(src(uid(15)).premiereSource).toBeNull();
    expect(src(uid(12)).isPremiere).toBe(true);
    expect(src(uid(15)).isPremiere).toBe(false);
  });

  it("flags a device that disagrees with the server about premium", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(16) });
    seedDevice(db, { userId: a, premium: 1 }); // device says yes, server says no
    expect((await list(db)).users[0].flags.premiumMismatch).toBe(true);
  });

  it("only counts a version below the social floor for an APP, never a browser", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(17) });
    const b = seedUser(db, { id: uid(18) });
    seedDevice(db, { userId: a, versionCode: 20 });
    // A browser sends no X-App-Version, so version_code is 0 — not "an app on version 0".
    seedDevice(db, {
      userId: b,
      platform: "web",
      versionCode: 0,
      versionName: null,
      buildType: null,
      manufacturer: "Chrome",
      model: "142",
    });

    const { users } = await list(db, testEnv(db, { MIN_SOCIAL_VERSION: "32" }));
    expect(users.find((u) => u.id === a)!.flags.belowFloor).toBe(true);
    expect(users.find((u) => u.id === b)!.flags.belowFloor).toBe(false);
  });

  it("says when it truncated", async () => {
    const db = new TestD1();
    for (let i = 0; i < 3; i++) seedUser(db, { id: uid(100 + i) });
    const { truncated, total } = await list(db);
    expect(total).toBe(3);
    expect(truncated).toBe(false);
  });

  /**
   * ⚠️ The fan-out this LEFT JOIN chain is one provider away from. `identities` is joined
   * on user_id alone, so a second provider row would duplicate the ACCOUNT in the list.
   * Documented in BASE_SQL; asserted here so the day it happens, a test says so.
   */
  it("returns one row per account today, with one identity per account", async () => {
    const db = new TestD1();
    seedUser(db, { id: uid(19) });
    const { users } = await list(db);
    expect(users.filter((u) => u.id === uid(19))).toHaveLength(1);
  });
});

describe("foldTelemetry", () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      user_id: "u",
      device_id: "d",
      platform: "android",
      version_code: 100,
      version_name: "2.4.1",
      build_type: "release",
      country: "GB",
      language: "en",
      os_api: 34,
      manufacturer: "Google",
      model: "Pixel 8",
      installer: "play",
      premium: null,
      gate_outcome: null,
      ads_consent: null,
      integrations: null,
      features: null,
      last_seen_at: 1000,
      reported_on: "2026-08-01",
      ...over,
    }) as never;

  it("takes the NEWEST device for point-in-time facts, not the first row", () => {
    const f = foldTelemetry([
      row({ device_id: "old", last_seen_at: 1, version_name: "1.0.0", version_code: 10, model: "Pixel 4" }),
      row({ device_id: "new", last_seen_at: 999, version_name: "2.4.1", version_code: 100, model: "Pixel 8" }),
    ]);
    expect(f.versionName).toBe("2.4.1");
    expect(f.device).toBe("Google Pixel 8");
    expect(f.devices).toBe(2);
    expect(f.lastSeenAt).toBe(999);
  });

  /**
   * Lifetime counters over one synced library. Summing two devices would report that a
   * person with a phone and a tablet watched twice as much as they did.
   */
  it("takes the MAXIMUM of a lifetime counter, never the sum", () => {
    const f = foldTelemetry([
      row({ device_id: "a", features: JSON.stringify({ counts: { watched: 400 } }) }),
      row({ device_id: "b", features: JSON.stringify({ counts: { watched: 412 } }) }),
    ]);
    expect(f.counts.watched).toBe(412);
  });

  it("unions integrations and surfaces across devices", () => {
    const f = foldTelemetry([
      row({ device_id: "a", integrations: JSON.stringify({ plex: true }), features: JSON.stringify({ used: ["discover"] }) }),
      row({ device_id: "b", integrations: JSON.stringify({ trakt: true, aiProvider: "gemini" }), features: JSON.stringify({ used: ["watch"] }) }),
    ]);
    expect(f.integrations).toEqual(["aiProvider:gemini", "plex", "trakt"]);
    expect(f.features).toEqual(["discover", "watch"]);
  });

  it("reads Android-shaped columns off the newest APP row, ignoring a newer browser", () => {
    const f = foldTelemetry([
      row({ device_id: "app", last_seen_at: 1, version_code: 100, version_name: "2.4.1", os_api: 34 }),
      row({
        device_id: "web",
        last_seen_at: 999,
        platform: "web",
        version_code: 0,
        version_name: null,
        os_api: null,
        manufacturer: "Chrome",
        model: "142",
        build_type: null,
      }),
    ]);
    // The browser is newer, so it names the device — but it must not set the app version.
    expect(f.device).toBe("Chrome 142");
    expect(f.versionCode).toBe(100);
    expect(f.versionName).toBe("2.4.1");
    expect(f.osApi).toBe(34);
    expect(f.platforms).toEqual(["android", "web"]);
  });

  it("survives a malformed JSON blob", () => {
    const f = foldTelemetry([row({ integrations: "{oops", features: "nope" })]);
    expect(f.integrations).toEqual([]);
    expect(f.counts).toEqual({});
  });

  it("notices a ghost row", () => {
    expect(foldTelemetry([row({ device_id: "" })]).ghostRow).toBe(true);
    expect(foldTelemetry([row({ device_id: "abc" })]).ghostRow).toBe(false);
  });
});

describe("POST /api/users/act", () => {
  it("400s on an unknown action and 404s on an unknown account", async () => {
    const db = new TestD1();
    seedUser(db, { id: uid(20) });
    expect((await act(db, { userId: uid(20), action: "explode" })).status).toBe(400);
    expect((await act(db, { userId: "nope", action: "ban" })).status).toBe(404);
    expect((await act(db, { action: "ban" })).status).toBe(400);
  });

  /**
   * ⚠️ The ban assertion that matters. `users.status` alone leaves live sessions working
   * for their full 90 days, so a ban MUST also revoke them.
   */
  it("ban flips status AND ends every live session", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(21) });
    seedSession(db, a, "hash-1");
    seedSession(db, a, "hash-2");
    seedSession(db, a, "hash-3", true); // already revoked

    const res = await act(db, { userId: a, action: "ban", reason: "spam" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionsEnded: 2 });

    expect(db.one<{ status: string }>(`SELECT status FROM users WHERE id = ?`, a)!.status).toBe("suspended");
    expect(db.count("sessions", "user_id = ? AND revoked_at IS NULL", a)).toBe(0);
  });

  it("does not touch another account's sessions", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(22) });
    const b = seedUser(db, { id: uid(23) });
    seedSession(db, a, "mine");
    seedSession(db, b, "theirs");

    await act(db, { userId: a, action: "ban" });
    expect(db.count("sessions", "user_id = ? AND revoked_at IS NULL", b)).toBe(1);
  });

  it("unban restores sign-in but deliberately does not resurrect sessions", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(24), status: "suspended" });
    seedSession(db, a, "dead", true);

    await act(db, { userId: a, action: "unban" });
    expect(db.one<{ status: string }>(`SELECT status FROM users WHERE id = ?`, a)!.status).toBe("active");
    // A revoked token is gone. The next launch mints a fresh one.
    expect(db.count("sessions", "user_id = ? AND revoked_at IS NULL", a)).toBe(0);
  });

  it("signout ends sessions without banning", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(25) });
    seedSession(db, a, "h1");

    const res = await act(db, { userId: a, action: "signout" });
    expect(await res.json()).toEqual({ ok: true, sessionsEnded: 1 });
    expect(db.one<{ status: string }>(`SELECT status FROM users WHERE id = ?`, a)!.status).toBe("active");
  });

  it("suspend accepts only the preset durations", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(26) });

    expect((await act(db, { userId: a, action: "suspend", durationMs: 12_345 })).status).toBe(400);
    expect((await act(db, { userId: a, action: "suspend" })).status).toBe(400);

    const res = await act(db, { userId: a, action: "suspend", durationMs: 7 * DAY });
    expect(res.status).toBe(200);
    const until = db.one<{ u: number }>(`SELECT posting_suspended_until AS u FROM users WHERE id = ?`, a)!.u;
    expect(until).toBeGreaterThan(Date.now() + 6 * DAY);

    // 0 means permanent, expressed as the shared sentinel.
    await act(db, { userId: a, action: "suspend", durationMs: 0 });
    expect(db.one<{ u: number }>(`SELECT posting_suspended_until AS u FROM users WHERE id = ?`, a)!.u).toBe(
      PERMANENT_UNTIL,
    );

    await act(db, { userId: a, action: "unsuspend" });
    expect(db.one<{ u: number | null }>(`SELECT posting_suspended_until AS u FROM users WHERE id = ?`, a)!.u).toBeNull();
  });

  /**
   * ⚠️ The regression the whole comp column exists for. A comp must land in
   * `premiere_comp_until` and leave BOTH Play-owned columns untouched — `premiere_until`
   * because the verifier overwrites it, `premiere_since` because its guard fires once and
   * would record a freebie as the date they started paying.
   */
  it("comp_grant writes only premiere_comp_until", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(27) });

    const res = await act(db, { userId: a, action: "comp_grant", durationMs: 30 * DAY });
    expect(res.status).toBe(200);

    const row = db.one<{ until: number; comp: number; since: number }>(
      `SELECT premiere_until AS until, premiere_comp_until AS comp, premiere_since AS since
         FROM users WHERE id = ?`,
      a,
    )!;
    expect(row.comp).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(row.until).toBe(0);
    expect(row.since).toBe(0);
  });

  it("comp_grant does not disturb a real subscription", async () => {
    const db = new TestD1();
    const paidUntil = Date.now() + 10 * DAY;
    const a = seedUser(db, { id: uid(28), premiereUntil: paidUntil });
    db.exec(`UPDATE users SET premiere_since = 12345 WHERE id = '${a}'`);

    await act(db, { userId: a, action: "comp_grant", durationMs: 365 * DAY });
    const row = db.one<{ until: number; since: number }>(
      `SELECT premiere_until AS until, premiere_since AS since FROM users WHERE id = ?`,
      a,
    )!;
    expect(row.until).toBe(paidUntil);
    expect(row.since).toBe(12345);
  });

  it("comp accepts only preset durations, and permanent is the shared sentinel", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(29) });
    expect((await act(db, { userId: a, action: "comp_grant", durationMs: 999 })).status).toBe(400);
    expect(compUntil(999)).toBeNull();
    expect(compUntil(0)).toBe(PERMANENT_UNTIL);

    await act(db, { userId: a, action: "comp_grant", durationMs: 0 });
    expect(db.one<{ c: number }>(`SELECT premiere_comp_until AS c FROM users WHERE id = ?`, a)!.c).toBe(
      PERMANENT_UNTIL,
    );

    await act(db, { userId: a, action: "comp_revoke" });
    expect(db.one<{ c: number }>(`SELECT premiere_comp_until AS c FROM users WHERE id = ?`, a)!.c).toBe(0);
  });

  it("beta_grant is grant-only — the latch has no revoke", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(30) });
    await act(db, { userId: a, action: "beta_grant" });
    expect(db.one<{ b: number }>(`SELECT beta_tester AS b FROM users WHERE id = ?`, a)!.b).toBe(1);
    expect((await act(db, { userId: a, action: "beta_revoke" })).status).toBe(400);
  });

  describe("delete", () => {
    it("refuses without a confirmation echoing the id", async () => {
      const db = new TestD1();
      const a = seedUser(db, { id: uid(31) });
      expect((await act(db, { userId: a, action: "delete" })).status).toBe(400);
      expect((await act(db, { userId: a, action: "delete", confirm: "yes" })).status).toBe(400);
      expect(db.count("users")).toBe(1);
    });

    it("runs the real erasure path", async () => {
      const db = new TestD1();
      const a = seedUser(db, { id: uid(32) });
      seedSession(db, a, "h");
      seedDevice(db, { userId: a, watched: 10 });
      db.exec(`INSERT INTO history_meta (user_id, version, event_count, title_count, updated_at)
               VALUES ('${a}', 1, 10, 4, 1)`);

      const res = await act(db, { userId: a, action: "delete", confirm: a });
      expect(res.status).toBe(200);

      // Not "the endpoint returned ok" — the rows are actually gone.
      expect(db.count("users")).toBe(0);
      expect(db.count("identities")).toBe(0);
      expect(db.count("profiles")).toBe(0);
      expect(db.count("sessions")).toBe(0);
      expect(db.count("user_telemetry")).toBe(0);
      expect(db.count("history_meta")).toBe(0);
    });

    /** The record must outlive its subject, or it is not a record of the deletion. */
    it("leaves an audit row behind after the account is gone", async () => {
      const db = new TestD1();
      const a = seedUser(db, { id: uid(33) });
      await act(db, { userId: a, action: "delete", confirm: a, reason: "user request" });

      expect(db.count("users")).toBe(0);
      const rows = db.rows<{ action: string; target_id: string; detail: string }>(
        "SELECT action, target_id, detail FROM admin_actions",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("delete");
      expect(rows[0].target_id).toBe(a);
      expect(JSON.parse(rows[0].detail)).toMatchObject({ irreversible: true, reason: "user request" });
    });
  });

  describe("the audit trail", () => {
    it("records the actor, action and detail for every control", async () => {
      const db = new TestD1();
      const a = seedUser(db, { id: uid(34) });
      await act(db, { userId: a, action: "suspend", durationMs: DAY, reason: "abuse" });
      await act(db, { userId: a, action: "unsuspend" });
      await act(db, { userId: a, action: "comp_grant", durationMs: 30 * DAY });
      await act(db, { userId: a, action: "ban" });

      const rows = db.rows<{ actor: string; action: string; detail: string | null }>(
        "SELECT actor, action, detail FROM admin_actions ORDER BY rowid",
      );
      expect(rows.map((r) => r.action)).toEqual(["suspend", "unsuspend", "comp_grant", "ban"]);
      expect(rows.every((r) => r.actor === "tester")).toBe(true);
      expect(JSON.parse(rows[0].detail!)).toMatchObject({ durationMs: DAY, reason: "abuse" });
      expect(JSON.parse(rows[3].detail!)).toMatchObject({ sessionsEnded: 0 });
    });

    it("records 'unknown' rather than blank when no actor header is sent", async () => {
      const db = new TestD1();
      const a = seedUser(db, { id: uid(35) });
      const req = new Request("https://flickto.app/api/users/act", {
        method: "POST",
        headers: { "X-Admin-Key": "test-admin-key", "Content-Type": "application/json" },
        body: JSON.stringify({ userId: a, action: "unban" }),
      });
      await handleUsersAct(req, testEnv(db));
      expect(db.one<{ actor: string }>("SELECT actor FROM admin_actions")!.actor).toBe("unknown");
    });

    it("a failed action leaves no audit row", async () => {
      const db = new TestD1();
      const a = seedUser(db, { id: uid(36) });
      await act(db, { userId: a, action: "suspend", durationMs: 5 });
      expect(db.count("admin_actions")).toBe(0);
    });
  });
});

describe("GET /api/users/{id}", () => {
  it("404s for an unknown account", async () => {
    const db = new TestD1();
    const res = await handleUserDetail(adminReq(`/api/users/${uid(90)}`), testEnv(db), uid(90));
    expect(res.status).toBe(404);
  });

  it("returns the per-person lists the roster cannot carry", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(37), displayName: "Dee" });
    seedDevice(db, { userId: a, deviceId: "dev-1", watched: 5 });
    seedSession(db, a, "h1");
    db.exec(
      `INSERT INTO comments (id, tmdb_id, media_type, season, episode, author_id, body, visibility,
                             spoiler, created_at, updated_at)
       VALUES ('C1', 1396, 'show', 3, 7, '${a}', 'great ep', 'public', 0, 5, 5)`,
    );
    db.exec(`INSERT INTO feedback (id, user_id, topic, message, state, created_at, updated_at)
             VALUES ('F1', '${a}', 'bug', 'it broke', 'new', 6, 6)`);
    db.exec(
      `INSERT INTO lists (user_id, id, name, kind, version, created_at, updated_at)
       VALUES ('${a}', 'L1', 'Watchlist', 'BUILTIN_WATCHLIST', 1, 1, 1)`,
    );
    db.exec(`INSERT INTO list_items (user_id, list_id, tmdb_id, type, position, added_at, updated_at)
             VALUES ('${a}', 'L1', 550, 'MOVIE', 0, 1, 1)`);
    db.exec(`INSERT INTO user_integrations (user_id, target, connected, updated_at)
             VALUES ('${a}', 'TRAKT', 1, 1)`);

    const res = await handleUserDetail(adminReq(`/api/users/${a}`), testEnv(db), a);
    expect(res.status).toBe(200);
    const d = (await res.json()) as Record<string, any>;

    expect(d.id).toBe(a);
    expect(d.devices).toHaveLength(1);
    expect(d.devices[0].deviceId).toBe("dev-1");
    expect(d.devices[0].features.counts.watched).toBe(5);
    expect(d.sessions).toHaveLength(1);
    expect(d.comments).toHaveLength(1);
    expect(d.feedback).toHaveLength(1);
    expect(d.lists).toHaveLength(1);
    expect(d.lists[0].items).toBe(1);
    expect(d.integrations).toHaveLength(1);
  });

  it("resolves a friend's name from the other side of the pair, whichever side that is", async () => {
    const db = new TestD1();
    const [a, b] = [uid(38), uid(39)];
    seedUser(db, { id: a, displayName: "Ay" });
    seedUser(db, { id: b, displayName: "Bee" });
    const [lo, hi] = [a, b].sort();
    db.exec(
      `INSERT INTO friendships (user_a, user_b, state, requested_by, created_at, updated_at)
       VALUES ('${lo}', '${hi}', 'accepted', '${lo}', 1, 1)`,
    );

    for (const [self, other, otherName] of [
      [a, b, "Bee"],
      [b, a, "Ay"],
    ] as const) {
      const res = await handleUserDetail(adminReq(`/api/users/${self}`), testEnv(db), self);
      const d = (await res.json()) as Record<string, any>;
      expect(d.friends).toHaveLength(1);
      expect(d.friends[0].friend_id).toBe(other);
      expect(d.friends[0].display_name).toBe(otherName);
    }
  });

  it("includes the admin action history for that target", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(40) });
    await act(db, { userId: a, action: "suspend", durationMs: DAY, reason: "spoilers" });

    const res = await handleUserDetail(adminReq(`/api/users/${a}`), testEnv(db), a);
    const d = (await res.json()) as Record<string, any>;
    expect(d.adminActions).toHaveLength(1);
    expect(d.adminActions[0]).toMatchObject({ actor: "tester", action: "suspend" });
    expect(d.adminActions[0].detail).toMatchObject({ reason: "spoilers" });
  });
});
