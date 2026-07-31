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

const req = (key?: string) =>
  new Request("https://flickto.app/api/insights", key ? { headers: { "X-Admin-Key": key } } : undefined);

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

const body = async () => (await handleInsights(req(KEY), env)).json() as any;

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
    expect(b.featureCounts.find((f: any) => f.key === "watched")).toEqual({ key: "watched", sum: 40, devices: 2 });
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
