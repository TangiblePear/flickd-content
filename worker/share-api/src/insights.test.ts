import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { handleInsights } from "./insights";

// Same real-SQLite harness as `telemetry.test.ts`, and for the same reason: this
// endpoint's whole job is aggregation, and a fake that reimplements COUNT(DISTINCT …)
// would be testing the fake. See that file's header for why `createRequire` is used.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = InstanceType<typeof DatabaseSync>;

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../migrations/0016_user_telemetry.sql", import.meta.url)),
  "utf8",
);

class Stmt {
  private args: unknown[] = [];
  constructor(
    private db: DatabaseSync,
    private sql: string,
  ) {}
  bind(...a: unknown[]) {
    this.args = a;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.args as never[])) ?? null) as T | null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}
class D1 {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
}

const ME = "AAAAH73X7P55T48R4CFHDED9CW";
const YOU = "BBBBJ84Y8Q66V59S5DGJEFEAX0";
const KEY = "admin-key-for-tests";

let raw: DatabaseSync;
let env: any;

const req = (key?: string, query = "") =>
  new Request(
    `https://flickto.app/api/insights${query}`,
    key ? { headers: { "X-Admin-Key": key } } : undefined,
  );

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  // The tables `handleInsights` reads beyond its own. Minimal shapes — only the
  // columns the scalar subqueries touch.
  raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active')");
  raw.exec("CREATE TABLE friendships (user_a TEXT, user_b TEXT, state TEXT)");
  raw.exec("CREATE TABLE profiles (user_id TEXT PRIMARY KEY)");
  raw.exec("CREATE TABLE feed_events (id TEXT PRIMARY KEY)");
  raw.exec("CREATE TABLE comments (id TEXT PRIMARY KEY)");
  raw.exec("CREATE TABLE episode_votes (user_id TEXT)");
  raw.exec("CREATE TABLE shared_lists (id TEXT PRIMARY KEY)");
  raw.exec("CREATE TABLE reports (id TEXT PRIMARY KEY, state TEXT)");
  // The server-side history pointer (migration 0020). One row per user, never per event —
  // the events are an R2 document, so "has this account uploaded" is only answerable here.
  raw.exec("CREATE TABLE history_meta (user_id TEXT PRIMARY KEY, event_count INTEGER NOT NULL DEFAULT 0)");
  raw.exec(MIGRATION);
  for (const id of [ME, YOU]) {
    raw.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(id, Date.now());
  }
  env = { DB: new D1(raw), ADMIN_KEY: KEY, MIN_SOCIAL_VERSION: "32" };
});

const device = (o: Partial<Record<string, unknown>>) => {
  const row = {
    user_id: ME,
    device_id: "d1",
    platform: "android",
    version_code: 34,
    country: "GB",
    last_seen_at: Date.now(),
    reported_on: new Date().toISOString().slice(0, 10),
    version_name: "1.4.6",
    build_type: "release",
    os_api: 34,
    manufacturer: "Google",
    model: "Pixel 8",
    language: "en",
    installer: "play",
    premium: 0,
    gate_outcome: "not_applicable",
    ads_consent: "not_required",
    integrations: JSON.stringify({ plex: true, trakt: false }),
    features: JSON.stringify({ used: ["discover"], counts: { watched: 100 } }),
    ...o,
  };
  raw
    .prepare(
      `INSERT INTO user_telemetry (user_id, device_id, platform, version_code, country, last_seen_at,
         reported_on, version_name, build_type, os_api, manufacturer, model, language, installer,
         premium, gate_outcome, ads_consent, integrations, features)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(...(Object.values(row) as never[]));
};

const body = async (query = "") => (await handleInsights(req(KEY, query), env)).json() as any;

describe("handleInsights", () => {
  it("refuses without the admin key", async () => {
    expect((await handleInsights(req(), env)).status).toBe(401);
    expect((await handleInsights(req("wrong"), env)).status).toBe(401);
  });

  it("refuses when no ADMIN_KEY is configured, rather than opening up", async () => {
    // The unset case must CLOSE the endpoint. A misconfigured deploy that silently
    // published fleet stats would be the worst possible failure mode here.
    expect((await handleInsights(req(KEY), { ...env, ADMIN_KEY: undefined })).status).toBe(401);
  });

  it("counts devices and accounts separately", async () => {
    device({ device_id: "phone" });
    device({ device_id: "tablet", version_code: 31, version_name: null });
    device({ user_id: YOU, device_id: "phone" });

    const b = await body();
    expect(b.totals.devices).toBe(3);
    expect(b.totals.telemetryAccounts).toBe(2);
    // The adoption marker: only rows with a version_name came from a telemetry build.
    expect(b.totals.reportingNewClient).toBe(2);
  });

  it("counts devices below the social floor", async () => {
    device({ device_id: "old", version_code: 31 });
    device({ device_id: "new", version_code: 34 });

    const b = await body();
    expect(b.minSocialVersion).toBe(32);
    expect(b.belowFloor).toBe(1);
  });

  it("reports no floor as zero rather than blocking everyone", async () => {
    device({});
    const b = await handleInsights(req(KEY), { ...env, MIN_SOCIAL_VERSION: "0" }).then((r) => r.json() as any);
    expect(b.minSocialVersion).toBe(0);
    expect(b.belowFloor).toBe(0);
  });

  /**
   * A browser as `handleWebTelemetry` writes it: no `X-App-Version` (so `version_code`
   * is 0, NOT null), no build, no API level, and the browser's name and major version
   * in the handset columns.
   */
  const browser = (o: Partial<Record<string, unknown>> = {}) =>
    device({
      device_id: "web-1",
      platform: "web",
      version_code: 0,
      version_name: null,
      build_type: null,
      os_api: null,
      manufacturer: "Chrome",
      model: "142",
      installer: null,
      ...o,
    });

  /**
   * The regression this guards is silent and expensive. `version_code` is 0 for every
   * browser, so an unfiltered `belowFloor` counts all of them as ancient clients — and
   * that number is what the legacy-relay purge decision rests on. It would never have
   * reached zero, and nothing on the page would have said why.
   */
  it("does not count browsers as clients below the social floor", async () => {
    device({ device_id: "phone", version_code: 34 });
    browser();
    browser({ user_id: YOU });

    const b = await body();
    expect(b.totals.devices).toBe(3);
    expect(b.belowFloor).toBe(0);
    // And no phantom "version 0" bucket in the histogram beside it.
    expect(b.versions.map((v: any) => v.key)).toEqual(["34"]);
  });

  it("keeps browsers out of the handset tallies but in the fleet ones", async () => {
    device({ device_id: "phone" });
    browser();

    const b = await body();
    // "Chrome" is not a manufacturer, and these two panels answer handset questions.
    expect(b.manufacturers.map((m: any) => m.key)).toEqual(["Google"]);
    expect(b.models.map((m: any) => m.key)).toEqual(["Google Pixel 8"]);
    // But it is a real device used by a real person, so it counts where that matters.
    expect(b.totals.devices).toBe(2);
    expect(Object.fromEntries(b.platforms.map((p: any) => [p.key, p.devices]))).toEqual({ android: 1, web: 1 });
    expect(b.roster.find((r: any) => r.deviceId === "web-1")).toMatchObject({
      platform: "web",
      device: "Chrome 142",
    });
  });

  /**
   * A debug build can force premium from the developer menu, so counting it would
   * inflate conversion with our own testing.
   */
  it("computes monetisation on release builds only", async () => {
    device({ device_id: "a", build_type: "release", premium: 1 });
    device({ device_id: "b", build_type: "release", premium: 0 });
    device({ device_id: "c", build_type: "debug", premium: 1, gate_outcome: "paid" });

    const b = await body();
    expect(b.totals.releaseDevices).toBe(2);
    expect(b.totals.premiumRelease).toBe(1);
    // The debug device's "paid" must not appear in the gate histogram.
    expect(b.monetisation.gate.find((g: any) => g.key === "paid")).toBeUndefined();
  });

  it("folds the JSON columns, counting only what is truly configured", async () => {
    device({ device_id: "a", integrations: JSON.stringify({ plex: true, trakt: true, simkl: false }) });
    device({ device_id: "b", integrations: JSON.stringify({ plex: true, aiProvider: "gemini" }) });

    const b = await body();
    const map = Object.fromEntries(b.integrations.map((i: any) => [i.key, i.devices]));
    expect(map.plex).toBe(2);
    expect(map.trakt).toBe(1);
    // `false` means NOT configured and must never be counted as a connection.
    expect(map.simkl).toBeUndefined();
    // A string value keeps the choice rather than flattening to "configured".
    expect(map["aiProvider:gemini"]).toBe(1);
  });

  it("sums feature counts and keeps the device denominator", async () => {
    device({ device_id: "a", features: JSON.stringify({ used: ["discover", "saved"], counts: { watched: 10 } }) });
    device({ device_id: "b", features: JSON.stringify({ used: ["discover"], counts: { watched: 30 } }) });

    const b = await body();
    expect(Object.fromEntries(b.featuresUsed.map((f: any) => [f.key, f.devices]))).toEqual({
      discover: 2,
      saved: 1,
    });
    // `values` carries every device's own figure, ascending. The sum and the denominator
    // are kept too, but the panel draws the values: a mean over a library-size column is
    // not describable when most devices are 0 and one has imported a back catalogue.
    expect(b.featureCounts.find((f: any) => f.key === "watched")).toEqual({
      key: "watched",
      sum: 40,
      devices: 2,
      values: [10, 30],
    });
  });

  it("survives a malformed JSON blob instead of failing the whole page", async () => {
    device({ device_id: "good" });
    device({ device_id: "bad", integrations: "{not json", features: "also not json" });

    const res = await handleInsights(req(KEY), env);
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    expect(b.totals.devices).toBe(2);
    // The good device still contributes.
    expect(b.integrations.find((i: any) => i.key === "plex").devices).toBe(1);
  });

  it("answers with empty distributions rather than throwing on an empty fleet", async () => {
    const b = await body();
    expect(b.totals.devices).toBe(0);
    expect(b.versions).toEqual([]);
    expect(b.integrations).toEqual([]);
    expect(b.totals.accounts).toBe(2);
  });

  it("counts accounts with at least one friend from BOTH sides of the pair", async () => {
    // Stored once in canonical order, so counting only user_a would halve it.
    raw.prepare("INSERT INTO friendships (user_a, user_b, state) VALUES (?,?,?)").run(ME, YOU, "accepted");
    const b = await body();
    expect(b.totals.accountsWithFriends).toBe(2);
    expect(b.totals.friendships).toBe(1);
  });
});

// ── Coverage ───────────────────────────────────────────────────────────────────
//
// The panel this feeds exists because the page used to print "Accounts 9" beside
// distributions totalling 6 and explain the difference in a footnote. A reader had no way
// to tell a real zero from an absent one.

describe("handleInsights: coverage", () => {
  it("separates accounts, reporting, rich and active", async () => {
    device({ user_id: ME, device_id: "rich" });
    // Header-only: the row a client lands before it ever sends the telemetry block.
    device({
      user_id: YOU,
      device_id: "",
      version_name: null,
      language: null,
      build_type: null,
      os_api: null,
      manufacturer: null,
      model: null,
      installer: null,
      integrations: null,
      features: null,
    });

    const b = await body();
    expect(b.coverage.accounts).toBe(2);
    expect(b.coverage.reporting).toBe(2);
    // Only the row carrying a versionName counts as rich.
    expect(b.coverage.rich).toBe(1);
  });

  it("counts an account ONCE however many devices it has", async () => {
    // The bug this guards: `reporting` measured off row count would exceed `accounts`
    // the moment one person used a phone and a tablet, and a coverage bar above 100%
    // reads as a rendering fault rather than as the real shape.
    device({ user_id: ME, device_id: "phone" });
    device({ user_id: ME, device_id: "tablet" });

    const b = await body();
    expect(b.totals.devices).toBe(2);
    expect(b.coverage.reporting).toBe(1);
    expect(b.coverage.reporting).toBeLessThanOrEqual(b.coverage.accounts);
  });

  it("lists accounts that have never reported", async () => {
    device({ user_id: ME, device_id: "d" });
    const b = await body();
    // YOU signed in and never synced.
    expect(b.orphanAccounts).toHaveLength(1);
    expect(b.orphanAccounts[0].acct).toBe(YOU.slice(0, 6));
    // Never the full id — the page has no reason to address an account.
    expect(b.orphanAccounts[0].acct).not.toBe(YOU);
  });
});

describe("handleInsights: roster", () => {
  it("returns one row per device, most recently seen first", async () => {
    device({ user_id: ME, device_id: "old", model: "Old", last_seen_at: 1000 });
    device({ user_id: YOU, device_id: "new", model: "New", last_seen_at: 9000 });

    const b = await body();
    expect(b.roster.map((d: any) => d.deviceId)).toEqual(["new", "old"]);
    expect(b.roster[0]).toMatchObject({ acct: YOU.slice(0, 6), device: "Google New", country: "GB" });
  });

  it("carries each device's own integrations and counts, not the fleet's", async () => {
    device({
      user_id: ME,
      device_id: "a",
      integrations: JSON.stringify({ plex: true, trakt: false }),
      features: JSON.stringify({ used: ["discover"], counts: { watched: 7 } }),
    });
    device({ user_id: YOU, device_id: "b", integrations: JSON.stringify({ trakt: true }), features: null });

    const b = await body();
    const a = b.roster.find((d: any) => d.deviceId === "a");
    const bb = b.roster.find((d: any) => d.deviceId === "b");
    expect(a.integrations).toEqual(["plex"]); // false is not "configured"
    expect(a.counts).toEqual({ watched: 7 });
    expect(bb.integrations).toEqual(["trakt"]);
    expect(bb.counts).toEqual({});
  });

  it("reports server-side history per ACCOUNT, null when nothing was ever uploaded", async () => {
    device({ user_id: ME, device_id: "a" });
    device({ user_id: YOU, device_id: "b" });
    raw.prepare("INSERT INTO history_meta (user_id, event_count) VALUES (?,?)").run(ME, 2921);

    const b = await body();
    expect(b.roster.find((d: any) => d.deviceId === "a").serverEvents).toBe(2921);
    expect(b.roster.find((d: any) => d.deviceId === "b").serverEvents).toBeNull();
  });
});

describe("handleInsights: health", () => {
  it("flags a device with a local library whose account has uploaded nothing", async () => {
    device({ user_id: ME, device_id: "a", features: JSON.stringify({ used: [], counts: { watched: 16461 } }) });
    device({ user_id: YOU, device_id: "b", features: JSON.stringify({ used: [], counts: { watched: 0 } }) });

    const b = await body();
    // Only the one with something to upload counts — an empty library is not a backlog.
    expect(b.health.historyNotUploaded).toBe(1);
    expect(b.health.historyAccounts).toBe(0);
  });

  it("counts ghost rows keyed on the empty device id", async () => {
    // A device that reported before it sent a deviceId keeps that row forever, so once it
    // updates the account holds two rows and is double-counted in every distribution.
    device({ user_id: ME, device_id: "" });
    device({ user_id: ME, device_id: "real" });

    const b = await body();
    expect(b.health.ghostDeviceRows).toBe(1);
  });
});

describe("handleInsights: the daily series", () => {
  it("returns a contiguous axis with null on days that were never rolled up", async () => {
    // `maybeRollup` only ever computes YESTERDAY, so a day nobody synced is skipped and
    // never backfilled. Handing over only the days that exist lets the chart space them
    // evenly and draw a gap as an unbroken line — the one thing it must not do.
    const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    raw
      .prepare("INSERT INTO telemetry_daily (day, active, devices, new_users, snapshot, computed_at) VALUES (?,?,?,?,?,?)")
      .run(day(2), 5, 5, 2, "{}", Date.now());

    const b = await body();
    const at = (d: string) => b.series.daily.find((x: any) => x.day === d);

    expect(at(day(2))).toMatchObject({ active: 5, devices: 5 });
    // Yesterday has no row at all — absent, not zero.
    expect(at(day(1)).active).toBeNull();
    // Exactly the one hole BETWEEN the first rollup and today. The 87 days before the
    // first rollup are not gaps — nothing was recording yet.
    expect(b.health.missingRollupDays).toBe(1);
  });

  it("does not count the days before the first rollup as gaps", async () => {
    // The window is 90 days and the feature is younger, so counting every absent day
    // would report ~86 holes forever and make the health row a warning that can never
    // be cleared.
    const b = await body();
    expect(b.series.daily.filter((d: any) => d.active === null).length).toBeGreaterThan(80);
    expect(b.health.missingRollupDays).toBe(0);
  });

  it("drops debug builds from every panel when asked, and says it did", async () => {
    device({ device_id: "mine", build_type: "debug", country: "IE", version_code: 40 });
    device({ user_id: YOU, device_id: "theirs", build_type: "release", country: "BR" });

    const all = await body();
    expect(all.excludeDebug).toBe(false);
    expect(all.totals.devices).toBe(2);

    const b = await body("?excludeDebug=1");
    expect(b.excludeDebug).toBe(true);
    expect(b.totals.devices).toBe(1);
    // Every dimension is folded from the same filtered rows, not just the headline.
    expect(b.roster.map((r: any) => r.deviceId)).toEqual(["theirs"]);
    expect(b.countries.map((c: any) => c.key)).toEqual(["BR"]);
    expect(b.versions.some((v: any) => v.key === "40")).toBe(false);
  });

  it("moves a debug-only account into the orphan list rather than losing it", async () => {
    // Otherwise it leaves `coverage.reporting` while appearing nowhere, and the honesty
    // rail (accounts - reporting) names a gap the page cannot show.
    device({ device_id: "mine", build_type: "debug" });
    device({ user_id: YOU, device_id: "theirs", build_type: "release" });

    const b = await body("?excludeDebug=1");
    expect(b.coverage.reporting).toBe(1);
    expect(b.orphanAccounts.map((o: any) => o.acct)).toEqual([ME.slice(0, 6)]);
  });

  it("keeps a legacy row with no build type — unknown is not ours", async () => {
    device({ device_id: "legacy", build_type: null, version_name: null });

    const b = await body("?excludeDebug=1");
    expect(b.totals.devices).toBe(1);
  });

  it("reports a real zero for a signup-free day", async () => {
    // Signups come from users.created_at, so absence there IS zero — the opposite of the
    // daily rollup, and the reason the two series are built differently.
    const b = await body();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(b.series.signups.find((s: any) => s.day === yesterday).n).toBe(0);
  });
});
