import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { maybeRollup, parseBrowser, recordTelemetry, utcDay } from "./telemetry";

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

/** Exactly what `/api/history/sync` forwards: identity plus build, never the expensive half. */
const thinBlock = { deviceId: "dev-1", versionName: "1.4.0", buildType: "debug" };

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

// Real User-Agents, captured rather than invented: the whole point of the table this
// exercises is that these strings overlap, and a plausible-looking fake would not.
const UA = {
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.3595.60",
  opera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  safariIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.60 Mobile/15E148 Safari/604.1",
  firefoxIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
};

describe("parseBrowser", () => {
  /**
   * The one test that matters here. Every string above except Firefox-on-desktop
   * contains `Safari/`, and Edge, Opera and Samsung all contain `Chrome/` — so a table
   * in the wrong order does not fail loudly, it silently records the whole fleet as
   * Chrome and Safari. Each of these would pass against a more general entry too;
   * what is being pinned is that the SPECIFIC one wins.
   */
  it("picks the specific browser over the general token it also carries", () => {
    expect(parseBrowser(UA.edge)).toEqual({ name: "Edge", version: "142" });
    expect(parseBrowser(UA.opera)).toEqual({ name: "Opera", version: "125" });
    expect(parseBrowser(UA.samsung)).toEqual({ name: "Samsung Internet", version: "27" });
    expect(parseBrowser(UA.chrome)).toEqual({ name: "Chrome", version: "142" });
    expect(parseBrowser(UA.safariMac)).toEqual({ name: "Safari", version: "18" });
  });

  // On iOS every browser is WebKit and says so. Chrome and Firefox there are still
  // Chrome and Firefox to a person reading the panel, so they must not read "Safari".
  it("names the iOS browsers by their wrapper, not by WebKit", () => {
    expect(parseBrowser(UA.chromeIos)).toEqual({ name: "Chrome", version: "142" });
    expect(parseBrowser(UA.firefoxIos)).toEqual({ name: "Firefox", version: "143" });
    expect(parseBrowser(UA.safariIos)).toEqual({ name: "Safari", version: "18" });
  });

  it("keeps the major version only", () => {
    // "142.0.3595.60" would give the models histogram a row per patch release.
    expect(parseBrowser(UA.edge)?.version).toBe("142");
    expect(parseBrowser(UA.firefox)).toEqual({ name: "Firefox", version: "143" });
  });

  it("returns null rather than guessing", () => {
    expect(parseBrowser(null)).toBeNull();
    expect(parseBrowser("")).toBeNull();
    expect(parseBrowser("curl/8.4.0")).toBeNull();
    expect(parseBrowser("FlickTo/1.4.0 okhttp/4.12.0")).toBeNull();
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
   * `/api/history/sync` runs on every app open, on an FCM wake and 6-hourly; `/api/sync`
   * carries the rich block and is effectively once a day. The thin caller therefore claims
   * the day first on essentially every device, and with the throttle alone the rich write
   * was discarded for the rest of that day — and the next, and the next. Two real devices
   * sat with no model and no build for 11 hours while in active use.
   */
  it("lets the rich block land on a day a thin write already claimed", async () => {
    await recordTelemetry(env, ME, req("32"), thinBlock, DAY1);
    expect(one().model).toBeNull();

    await recordTelemetry(env, ME, req("32"), richBlock, DAY1_LATER);

    const r = one();
    expect(r.model).toBe("Pixel 8");
    expect(JSON.parse(r.features).counts.watched).toBe(412);
    expect(r.last_seen_at).toBe(DAY1_LATER);
  });

  /**
   * THE trap in the line above, and the reason the marker is `model`.
   *
   * The thin caller sends `versionName` and `buildType` so a row knows what it is running
   * from its first write of the day. Keying the catch-up on `version_name` would therefore
   * let the thin write satisfy its own condition and block the rich block all over again —
   * the same bug, one column further along.
   */
  it("a thin write carrying a version still does not complete the row", async () => {
    await recordTelemetry(env, ME, req("32"), thinBlock, DAY1);
    // It DID record what it carries...
    expect(one().version_name).toBe("1.4.0");
    expect(one().build_type).toBe("debug");

    await recordTelemetry(env, ME, req("32"), richBlock, DAY1_LATER);

    // ...and the expensive half still landed behind it.
    expect(one().model).toBe("Pixel 8");
    expect(one().build_type).toBe("release");
  });

  it("does not reopen the day once the rich half is there", async () => {
    // The catch-up is one write, not a licence to write all day: with model already set,
    // the second clause is false and the throttle governs again.
    await recordTelemetry(env, ME, req("32"), richBlock, DAY1);
    await recordTelemetry(env, ME, req("99"), { ...richBlock, versionName: "9.9.9" }, DAY1_LATER);

    expect(one().version_name).toBe("1.4.0");
  });

  it("a thin write cannot reopen a day it did not complete", async () => {
    await recordTelemetry(env, ME, req("32"), thinBlock, DAY1);
    await recordTelemetry(env, ME, req("99"), thinBlock, DAY1_LATER);

    // excluded.model is NULL for a thin caller, so the second clause is false.
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

/**
 * The block `handleWebTelemetry` builds, written through the same statement Android
 * uses. The handler itself is not exercised here — it needs a `sessions` row and this
 * suite deliberately runs only the telemetry migration — so what is pinned is the part
 * that would be wrong silently: which COLUMNS a browser lands in.
 */
describe("a browser's row", () => {
  const webBlock = (ua: string) => {
    const b = parseBrowser(ua);
    return { deviceId: "web-uuid-1", language: "en-GB", platform: "web", manufacturer: b?.name, model: b?.version };
  };

  it("lands where the roster already looks for a device name", async () => {
    await recordTelemetry(env, ME, req(null, "GB"), webBlock(UA.chrome), DAY1);

    const r = one();
    // insights.ts draws `${manufacturer} ${model}` — so this row reads "Chrome 142"
    // in the Device column with no change to the code that renders handsets.
    expect(r.manufacturer).toBe("Chrome");
    expect(r.model).toBe("142");
    expect(r.platform).toBe("web");
    expect(r.language).toBe("en-GB");
    expect(r.country).toBe("GB");
    // No X-App-Version from a browser, and none of the Android-only half.
    expect(r.version_code).toBe(0);
    expect(r.version_name).toBeNull();
    expect(r.os_api).toBeNull();
    expect(r.installer).toBeNull();
  });

  it("is one row per browser, not per account", async () => {
    await recordTelemetry(env, ME, req(null), webBlock(UA.chrome), DAY1);
    await recordTelemetry(env, ME, req(null), { ...webBlock(UA.firefox), deviceId: "web-uuid-2" }, DAY1);

    expect(rows().length).toBe(2);
    expect(rows().map((r) => `${r.manufacturer} ${r.model}`).sort()).toEqual(["Chrome 142", "Firefox 143"]);
  });

  /**
   * The daily guard applies to browsers exactly as it does to handsets, which is what
   * makes "report on every tab" affordable — the site can call the endpoint freely and
   * still cost one write a day.
   */
  it("writes once a day however often the browser reports", async () => {
    await recordTelemetry(env, ME, req(null), webBlock(UA.chrome), DAY1);
    await recordTelemetry(env, ME, req(null), webBlock(UA.chrome), DAY1_LATER);
    expect(one().last_seen_at).toBe(DAY1);

    await recordTelemetry(env, ME, req(null), webBlock(UA.chrome), DAY2);
    expect(one().last_seen_at).toBe(DAY2);
  });

  /**
   * A browser we cannot name must still produce a row. It is one `Unknown` line in the
   * panel; dropping the write instead would take the account back to "no device", which
   * is the exact hole this endpoint was built to close.
   */
  it("still records a device we cannot name", async () => {
    await recordTelemetry(env, ME, req(null), webBlock("curl/8.4.0"), DAY1);

    const r = one();
    expect(r.device_id).toBe("web-uuid-1");
    expect(r.platform).toBe("web");
    expect(r.manufacturer).toBeNull();
    expect(r.model).toBeNull();
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
