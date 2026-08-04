import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { maybeRollup, recordTelemetry, utcDay } from "./telemetry";

// Required, not imported: this Vite version's builtin list predates `node:sqlite`, so
// a static `import` is rewritten to a bare `sqlite` specifier and the suite dies at
// load with "Failed to load url sqlite". `createRequire` resolves at runtime, in Node,
// where the module genuinely exists — and it keeps the fix inside the one file that
// needs it rather than in the shared vitest config.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = InstanceType<typeof DatabaseSync>;

// ── A REAL SQLite, running the REAL migration ────────────────────────────────
//
// Deliberately not the hand-written FakeD1 the other suites use. The whole write
// path here is one statement whose correctness lives entirely in
// `ON CONFLICT ... DO UPDATE ... WHERE reported_on <> excluded.reported_on`, and a
// fake that reimplements that guard would be testing the fake. Node 22+ ships
// `node:sqlite`, so the guard, the COALESCEs and the schema get exercised for real —
// and applying `migrations/0016_user_telemetry.sql` verbatim means a column renamed
// in the migration and not in the code fails here rather than in production.

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../migrations/0016_user_telemetry.sql", import.meta.url)),
  "utf8",
);

class SqliteStmt {
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

class SqliteD1 {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string) {
    return new SqliteStmt(this.db, sql);
  }
  async batch(stmts: SqliteStmt[]) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

const ME = "AAAAH73X7P55T48R4CFHDED9CW";
const YOU = "BBBBJ84Y8Q66V59S5DGJEFEAX0";

let raw: DatabaseSync;
let env: any;

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  // `user_telemetry` references it, and the rollup counts new accounts from it.
  // Foreign keys are enforced here exactly as D1 enforces them, so a telemetry row
  // for an account that does not exist fails in this suite rather than in production.
  raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
  raw.exec(MIGRATION);
  for (const id of [ME, YOU]) {
    raw.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(id, Date.parse("2026-07-20T00:00:00Z"));
  }
  env = { DB: new SqliteD1(raw) };
});

/** `cf` is not settable on a real Request in Node, so this is the minimum the code reads. */
const req = (version: string | null, country?: string): Request => {
  const headers = new Headers();
  if (version) headers.set("X-App-Version", version);
  return { headers, cf: country ? { country } : undefined } as unknown as Request;
};

const rows = () => raw.prepare("SELECT * FROM user_telemetry ORDER BY user_id, device_id").all() as any[];
const one = () => {
  const all = rows();
  expect(all.length).toBe(1);
  return all[0];
};

const DAY1 = Date.parse("2026-08-01T09:00:00.000Z");
const DAY1_LATER = Date.parse("2026-08-01T21:30:00.000Z");
const DAY2 = Date.parse("2026-08-02T08:00:00.000Z");

const richBlock = {
  deviceId: "dev-1",
  platform: "android",
  versionName: "1.4.0",
  buildType: "release",
  osApi: 34,
  manufacturer: "Google",
  model: "Pixel 8",
  language: "de",
  installer: "play",
  premium: true,
  gate: "consented",
  adsConsent: "obtained",
  integrations: { plex: true, trakt: true, simkl: false },
  aiProvider: "gemini",
  features: { used: ["discover", "catchup"], counts: { watched: 412, saved: 30 } },
};

describe("utcDay", () => {
  it("buckets by UTC, not by local time", () => {
    expect(utcDay(Date.parse("2026-08-01T23:59:59.999Z"))).toBe("2026-08-01");
    expect(utcDay(Date.parse("2026-08-02T00:00:00.000Z"))).toBe("2026-08-02");
  });
});

describe("recordTelemetry", () => {
  /**
   * The property the whole rollout rests on: a client that has never heard of the
   * telemetry block still lands a row, because version and country are read off the
   * request. Without this, fleet version data would only start on the next release.
   */
  it("records version and country from the request alone, with no block", async () => {
    await recordTelemetry(env, ME, req("31", "GB"), undefined, DAY1);

    const r = one();
    expect(r.device_id).toBe("");
    expect(r.version_code).toBe(31);
    expect(r.country).toBe("GB");
    expect(r.reported_on).toBe("2026-08-01");
    // NULL is the adoption marker — a build that sends the block sets this.
    expect(r.version_name).toBeNull();
    expect(r.integrations).toBeNull();
  });

  it("records the full block under its device id", async () => {
    await recordTelemetry(env, ME, req("32", "DE"), richBlock, DAY1);

    const r = one();
    expect(r.device_id).toBe("dev-1");
    expect(r.version_code).toBe(32);
    expect(r.version_name).toBe("1.4.0");
    expect(r.os_api).toBe(34);
    expect(r.model).toBe("Pixel 8");
    expect(r.premium).toBe(1);
    expect(r.gate_outcome).toBe("consented");
    expect(JSON.parse(r.integrations)).toEqual({ plex: true, trakt: true, simkl: false, aiProvider: "gemini" });
    expect(JSON.parse(r.features)).toEqual({
      used: ["discover", "catchup"],
      counts: { watched: 412, saved: 30 },
    });
  });

  /**
   * THE test for this design. If the guard does not hold, `/api/sync` becomes a D1
   * write on every refresh from every device — which is the reason this is safe to
   * hang off the hottest authenticated path in the Worker.
   */
  it("writes at most once per device per UTC day", async () => {
    await recordTelemetry(env, ME, req("32"), richBlock, DAY1);
    const wrote = await recordTelemetry(env, ME, req("99"), { ...richBlock, versionName: "9.9.9" }, DAY1_LATER);

    expect(wrote).toBeUndefined();
    const r = one();
    // Still the morning's values: the second report of the day changed nothing.
    expect(r.version_code).toBe(32);
    expect(r.version_name).toBe("1.4.0");
    expect(r.last_seen_at).toBe(DAY1);
  });

  /**
   * The exception the throttle above has to make, and the bug it was hiding.
   *
   * `/api/history/sync` runs every 15 minutes with only a device id; `/api/sync` carries
   * the rich block once a day. The thin caller therefore usually claims the day first, and
   * with the throttle alone the rich write was discarded for the rest of that day — and
   * the next, and the next. Two real devices sat at `version_name = NULL` for 11 hours,
   * showing neither their model nor their build.
   */
  it("lets the rich block land on a day a thin write already claimed", async () => {
    await recordTelemetry(env, ME, req("32"), { deviceId: "dev-1" }, DAY1);
    expect(one().version_name).toBeNull();

    await recordTelemetry(env, ME, req("32"), richBlock, DAY1_LATER);

    const r = one();
    expect(r.version_name).toBe("1.4.0");
    expect(r.model).toBe("Pixel 8");
    expect(r.last_seen_at).toBe(DAY1_LATER);
  });

  it("does not reopen the day once the rich half is there", async () => {
    // The catch-up is one write, not a licence to write all day: with version_name
    // already set, the second clause is false and the throttle governs again.
    await recordTelemetry(env, ME, req("32"), richBlock, DAY1);
    await recordTelemetry(env, ME, req("99"), { ...richBlock, versionName: "9.9.9" }, DAY1_LATER);

    expect(one().version_name).toBe("1.4.0");
  });

  it("a thin write cannot reopen a day it did not complete", async () => {
    await recordTelemetry(env, ME, req("32"), { deviceId: "dev-1" }, DAY1);
    await recordTelemetry(env, ME, req("99"), { deviceId: "dev-1" }, DAY1_LATER);

    // excluded.version_name is NULL for a thin caller, so the second clause is false.
    expect(one().last_seen_at).toBe(DAY1);
  });

  it("writes again once the UTC day rolls over", async () => {
    await recordTelemetry(env, ME, req("32"), richBlock, DAY1);
    await recordTelemetry(env, ME, req("33"), { ...richBlock, versionName: "1.5.0" }, DAY2);

    const r = one();
    expect(r.version_code).toBe(33);
    expect(r.version_name).toBe("1.5.0");
    expect(r.reported_on).toBe("2026-08-02");
    expect(r.last_seen_at).toBe(DAY2);
  });

  /**
   * A thin report must never erase a rich one. The client only builds the expensive
   * half on the first sync of a day, so this should not arise — but a NULLed-out row
   * would look exactly like a client that stopped sending the field, which is the
   * kind of false signal that gets acted on.
   */
  it("a thin report keeps the previous day's rich columns", async () => {
    await recordTelemetry(env, ME, req("32"), richBlock, DAY1);
    await recordTelemetry(env, ME, req("33"), { deviceId: "dev-1" }, DAY2);

    const r = one();
    expect(r.version_code).toBe(33); // the header half still moves
    expect(r.version_name).toBe("1.4.0"); // the rich half is preserved, not nulled
    expect(r.model).toBe("Pixel 8");
    expect(JSON.parse(r.integrations).plex).toBe(true);
  });

  it("keeps one row per device, and one account can hold several", async () => {
    await recordTelemetry(env, ME, req("31"), { ...richBlock, deviceId: "phone" }, DAY1);
    await recordTelemetry(env, ME, req("28"), { ...richBlock, deviceId: "tablet", versionName: "1.0.0" }, DAY1);
    await recordTelemetry(env, YOU, req("32"), { ...richBlock, deviceId: "phone" }, DAY1);

    // Three devices, two accounts — which is exactly why the version histogram is
    // per-device: a per-user row would have shown only one of ME's two versions.
    expect(rows().map((r) => [r.user_id, r.device_id, r.version_code])).toEqual([
      [ME, "phone", 31],
      [ME, "tablet", 28],
      [YOU, "phone", 32],
    ]);
  });

  /** A legacy header-only write must not collide with a real device's row. */
  it("keeps the header-only row separate from a device's row", async () => {
    await recordTelemetry(env, ME, req("31"), undefined, DAY1);
    await recordTelemetry(env, ME, req("32"), richBlock, DAY1);

    expect(rows().map((r) => [r.device_id, r.version_code])).toEqual([
      ["", 31],
      ["dev-1", 32],
    ]);
  });

  it("drops hostile or malformed fields instead of throwing", async () => {
    await recordTelemetry(
      env,
      ME,
      req("32"),
      {
        deviceId: "dev-1",
        osApi: "thirty-four",
        premium: "yes",
        integrations: {
          plex: true,
          // A credential-shaped value. Over-length strings are REJECTED, not
          // truncated — storing 24 characters of a token is still storing a token.
          trakt: "a".repeat(64),
          "bad-key!": true,
          nested: { a: 1 },
        },
        aiProvider: "gemini",
        features: {
          used: ["discover", "not a key", "discover", 7],
          counts: { watched: 10, broken: -5, alsoBroken: "many" },
        },
      },
      DAY1,
    );

    const r = one();
    expect(r.os_api).toBeNull();
    expect(r.premium).toBeNull();
    expect(JSON.parse(r.integrations)).toEqual({ plex: true, aiProvider: "gemini" });
    // Duplicates collapse; a negative lifetime total would poison the rollup's sum.
    expect(JSON.parse(r.features)).toEqual({ used: ["discover"], counts: { watched: 10 } });
  });

  it("treats a missing version header as 0 rather than failing", async () => {
    await recordTelemetry(env, ME, req(null), undefined, DAY1);
    expect(one().version_code).toBe(0);
  });
});

describe("maybeRollup", () => {
  const seed = async () => {
    // ME signed up inside the day being rolled up; YOU predates it (see beforeEach).
    raw.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(DAY1, ME);

    await recordTelemetry(env, ME, req("32", "GB"), { ...richBlock, deviceId: "phone" }, DAY1);
    await recordTelemetry(
      env,
      ME,
      req("31", "GB"),
      {
        ...richBlock,
        deviceId: "tablet",
        premium: false,
        language: "en",
        integrations: { plex: true, jellyfin: true },
        aiProvider: undefined,
        features: { used: ["discover"], counts: { watched: 88 } },
      },
      DAY1,
    );
    await recordTelemetry(
      env,
      YOU,
      req("32", "DE"),
      { ...richBlock, deviceId: "phone", gate: "paid" },
      DAY1,
    );
  };

  it("folds a day into one immutable row", async () => {
    await seed();
    expect(await maybeRollup(env, DAY2)).toBe("2026-08-01");

    const row = raw.prepare("SELECT * FROM telemetry_daily WHERE day = ?").get("2026-08-01") as any;
    expect(row.active).toBe(2); // accounts
    expect(row.devices).toBe(3); // devices
    expect(row.new_users).toBe(1); // only ME was created inside the day

    const s = JSON.parse(row.snapshot);
    expect(s.version).toEqual({ "31": 1, "32": 2 });
    expect(s.country).toEqual({ GB: 2, DE: 1 });
    expect(s.language).toEqual({ de: 2, en: 1 });
    expect(s.premium).toBe(2);
    expect(s.gate).toEqual({ consented: 2, paid: 1 });
    // A false integration is NOT counted as configured, and a string value keeps the
    // choice rather than flattening to "configured".
    expect(s.integrations).toEqual({
      plex: 3,
      trakt: 2,
      jellyfin: 1,
      "aiProvider:gemini": 2,
    });
    expect(s.featuresUsed).toEqual({ discover: 3, catchup: 2 });
    expect(s.featureCounts.watched).toEqual({ sum: 412 + 88 + 412, n: 3 });
  });

  it("is a no-op once the day is computed", async () => {
    await seed();
    expect(await maybeRollup(env, DAY2)).toBe("2026-08-01");
    expect(await maybeRollup(env, DAY2)).toBeNull();

    expect((raw.prepare("SELECT COUNT(*) AS n FROM telemetry_daily").get() as any).n).toBe(1);
  });

  it("records a zero day rather than skipping it, so the series has no holes", async () => {
    expect(await maybeRollup(env, DAY2)).toBe("2026-08-01");

    const row = raw.prepare("SELECT * FROM telemetry_daily WHERE day = ?").get("2026-08-01") as any;
    expect(row.active).toBe(0);
    expect(row.devices).toBe(0);
    expect(JSON.parse(row.snapshot).version).toEqual({});
  });

  it("does not fold today, which is still accumulating", async () => {
    await seed();
    // Called during DAY1 itself: it rolls up 2026-07-31, and DAY1 stays open.
    expect(await maybeRollup(env, DAY1_LATER)).toBe("2026-07-31");
    expect(raw.prepare("SELECT day FROM telemetry_daily").all().map((r: any) => r.day)).toEqual(["2026-07-31"]);
  });
});
