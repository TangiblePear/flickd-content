import { describe, expect, it } from "vitest";
import { TestD1, adminPost, adminReq, seedDevice, seedUser, testEnv, uid } from "./testD1";
import { handleDevicesAct, handleDevicesList, idShape, staleness } from "./devicesAdmin";

const DAY = 86_400_000;
const SHA = "a".repeat(64);
const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const list = async (db: TestD1, env = testEnv(db)) => {
  const res = await handleDevicesList(adminReq("/api/devices"), env);
  expect(res.status).toBe(200);
  return (await res.json()) as { total: number; devices: Array<Record<string, any>> };
};

const act = (db: TestD1, body: unknown, env = testEnv(db)) =>
  handleDevicesAct(adminPost("/api/devices/act", body), env);

describe("idShape", () => {
  it("tells the three id generations apart", () => {
    expect(idShape(SHA)).toBe("derived");
    expect(idShape(UUID)).toBe("uuid");
    expect(idShape("")).toBe("ghost");
    expect(idShape("legacy-nonsense")).toBe("other");
  });
});

describe("staleness", () => {
  it("buckets by age rather than reporting a raw number", () => {
    const now = Date.now();
    expect(staleness(now, now)).toBe("live");
    expect(staleness(now - 3 * DAY, now)).toBe("live");
    expect(staleness(now - 20 * DAY, now)).toBe("quiet");
    expect(staleness(now - 60 * DAY, now)).toBe("dormant");
    expect(staleness(now - 120 * DAY, now)).toBe("stale");
    expect(staleness(now - 400 * DAY, now)).toBe("abandoned");
  });
});

describe("GET /api/devices", () => {
  it("401s without the admin key", async () => {
    const db = new TestD1();
    expect((await handleDevicesList(adminReq("/api/devices", "wrong"), testEnv(db))).status).toBe(401);
  });

  it("carries the ACCOUNT for each device — the difference from the Insights roster", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(1), displayName: "Jamie R", email: "jamie@example.com" });
    seedDevice(db, { userId: a, deviceId: SHA });

    const { devices } = await list(db);
    expect(devices).toHaveLength(1);
    expect(devices[0].userId).toBe(a);
    expect(devices[0].displayName).toBe("Jamie R");
    expect(devices[0].email).toBe("jamie@example.com");
    expect(devices[0].device).toBe("Google Pixel 8");
    expect(devices[0].idShape).toBe("derived");
  });

  it("flags a ghost row", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(2) });
    seedDevice(db, { userId: a, deviceId: "", versionName: null, buildType: null });

    const { devices } = await list(db);
    expect(devices[0].flags.ghost).toBe(true);
    expect(devices[0].flags.headerOnly).toBe(true);
    expect(devices[0].idShape).toBe("ghost");
  });

  /**
   * The documented wiped-store fingerprint from TelemetryDeviceId.kt: an empty row
   * alongside a sibling on the same account that HAS data.
   */
  it("flags a wiped-store duplicate, but only with a rich sibling present", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(3) });
    seedDevice(db, { userId: a, deviceId: "real", watched: 412, integrations: { plex: true }, lastSeenAt: Date.now() });
    seedDevice(db, { userId: a, deviceId: "ghost-1", watched: 0, integrations: null, lastSeenAt: Date.now() - DAY });

    const { devices } = await list(db);
    const dup = devices.find((d) => d.deviceId === "ghost-1")!;
    const real = devices.find((d) => d.deviceId === "real")!;
    expect(dup.flags.wipedStoreSuspect).toBe(true);
    expect(real.flags.wipedStoreSuspect).toBe(false);
    expect(dup.accountDevices).toBe(2);
  });

  /**
   * ⚠️ Without the sibling test this would fire on every genuinely new device on its first
   * day — someone who installed the app an hour ago has no library and no integrations.
   */
  it("does NOT flag a lone empty device as a duplicate", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(4) });
    seedDevice(db, { userId: a, deviceId: SHA, watched: 0, integrations: null });

    const { devices } = await list(db);
    expect(devices[0].flags.wipedStoreSuspect).toBe(false);
  });

  /**
   * ⚠️ A UUID-shaped id is not evidence of anything. `TelemetryDeviceId.get()` returns a
   * cached id when one exists, so a live handset keeps its UUID forever. Shape is
   * information, never a deletion criterion — this asserts the panel treats it that way.
   */
  it("reports a UUID shape without treating it as stale or suspect", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(5) });
    seedDevice(db, { userId: a, deviceId: UUID, watched: 300, lastSeenAt: Date.now() });

    const { devices } = await list(db);
    expect(devices[0].idShape).toBe("uuid");
    expect(devices[0].staleness).toBe("live");
    expect(devices[0].flags.wipedStoreSuspect).toBe(false);
  });

  it("counts a browser below the floor as fine, and an old app as below it", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(6) });
    seedDevice(db, { userId: a, deviceId: "app", versionCode: 20 });
    seedDevice(db, {
      userId: a,
      deviceId: "web",
      platform: "web",
      versionCode: 0,
      versionName: null,
      manufacturer: "Chrome",
      model: "142",
    });

    const { devices } = await list(db, testEnv(db, { MIN_SOCIAL_VERSION: "32" }));
    expect(devices.find((d) => d.deviceId === "app")!.flags.belowFloor).toBe(true);
    expect(devices.find((d) => d.deviceId === "web")!.flags.belowFloor).toBe(false);
  });
});

describe("POST /api/devices/act — single delete", () => {
  it("deletes one row and reports whether it emptied the account", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(7) });
    seedDevice(db, { userId: a, deviceId: "d1", lastSeenAt: 500 });
    seedDevice(db, { userId: a, deviceId: "d2", lastSeenAt: 600 });

    const first = await act(db, { action: "delete", userId: a, deviceId: "d1" });
    expect(await first.json()).toEqual({ ok: true, deleted: 1, accountsEmptied: 0 });
    expect(db.count("user_telemetry")).toBe(1);

    // ⚠️ Removing the LAST row moves the account into Insights' orphanAccounts, where it
    // renders as "signed in, never reported" — false once you deleted the report. The
    // response has to say so, or the panel cannot warn.
    const second = await act(db, { action: "delete", userId: a, deviceId: "d2" });
    expect(await second.json()).toEqual({ ok: true, deleted: 1, accountsEmptied: 1 });
    expect(db.count("user_telemetry")).toBe(0);
  });

  /** `''` is a real device id — the ghost row — so it must be deletable. */
  it("can delete the ghost row, whose id is the empty string", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(8) });
    seedDevice(db, { userId: a, deviceId: "" });

    const res = await act(db, { action: "delete", userId: a, deviceId: "" });
    expect(res.status).toBe(200);
    expect(db.count("user_telemetry")).toBe(0);
  });

  it("404s on a row that is not there, and 400s without a device id", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(9) });
    expect((await act(db, { action: "delete", userId: a, deviceId: "nope" })).status).toBe(404);
    expect((await act(db, { action: "delete", userId: a })).status).toBe(400);
    expect((await act(db, { action: "sabotage" })).status).toBe(400);
  });

  it("records the deletion, with what was lost", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(10) });
    seedDevice(db, { userId: a, deviceId: "d1", lastSeenAt: 1234 });

    await act(db, { action: "delete", userId: a, deviceId: "d1" });
    const row = db.one<{ action: string; target_id: string; detail: string }>(
      "SELECT action, target_id, detail FROM admin_actions",
    )!;
    expect(row.action).toBe("device_delete");
    expect(row.target_id).toBe(a);
    expect(JSON.parse(row.detail)).toMatchObject({ deviceId: "d1", lastSeenAt: 1234, devicesLeft: 0 });
  });

  /**
   * `telemetry_daily` is immutable and holds no user ids, so the trend series must survive
   * a cleanup untouched. Distributions moving is the point; history moving would be a bug.
   */
  it("leaves the daily rollup alone", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(11) });
    seedDevice(db, { userId: a, deviceId: "d1" });
    db.exec(
      `INSERT INTO telemetry_daily (day, active, devices, new_users, snapshot, computed_at)
       VALUES ('2026-08-01', 5, 7, 2, '{}', 1)`,
    );

    await act(db, { action: "delete", userId: a, deviceId: "d1" });
    expect(db.count("telemetry_daily")).toBe(1);
    expect(db.one<{ devices: number }>("SELECT devices FROM telemetry_daily")!.devices).toBe(7);
  });

  /**
   * ⚠️ Deleting a telemetry row must not touch the account or its session. It is a
   * cleanup of a REPORT, not a sign-out — `sessions` has no device_id, so per-device
   * revocation does not exist at all.
   */
  it("does not touch the account, its profile or its sessions", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(12) });
    seedDevice(db, { userId: a, deviceId: "d1" });

    await act(db, { action: "delete", userId: a, deviceId: "d1" });
    expect(db.count("users")).toBe(1);
    expect(db.count("profiles")).toBe(1);
    expect(db.count("identities")).toBe(1);
  });
});

describe("POST /api/devices/act — bulk delete", () => {
  const seedFleet = (db: TestD1) => {
    const a = seedUser(db, { id: uid(20) });
    const b = seedUser(db, { id: uid(21) });
    // Two ghosts and one abandoned handset, plus two live rows that must survive.
    seedDevice(db, { userId: a, deviceId: "", lastSeenAt: Date.now() });
    seedDevice(db, { userId: b, deviceId: "", lastSeenAt: Date.now() });
    seedDevice(db, { userId: a, deviceId: "old", lastSeenAt: Date.now() - 400 * DAY });
    seedDevice(db, { userId: a, deviceId: SHA, lastSeenAt: Date.now(), watched: 100 });
    seedDevice(db, { userId: b, deviceId: "b".repeat(64), lastSeenAt: Date.now(), watched: 5 });
    return { a, b };
  };

  it("deletes exactly the ghost rows when the previewed count matches", async () => {
    const db = new TestD1();
    seedFleet(db);
    expect(db.count("user_telemetry")).toBe(5);

    const res = await act(db, { action: "deleteMatching", filter: { ghost: true }, expectCount: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: 2 });
    expect(db.count("user_telemetry")).toBe(3);
    expect(db.count("user_telemetry", "device_id = ''")).toBe(0);
  });

  /**
   * ⚠️ The guard that stops a bulk delete removing a different set than the one the
   * operator looked at. If a device reported in between preview and commit, the count
   * moves and the request must be refused rather than "close enough".
   */
  it("refuses with 409 when the set changed since the preview", async () => {
    const db = new TestD1();
    seedFleet(db);

    const res = await act(db, { action: "deleteMatching", filter: { ghost: true }, expectCount: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "count_changed", expected: 1, actual: 2 });
    // Nothing deleted.
    expect(db.count("user_telemetry")).toBe(5);
  });

  /**
   * ⚠️ An empty filter would match the whole fleet. A typo'd field name must be refused,
   * not silently promoted to "everything" — expectCount alone cannot catch that if the
   * panel computed it the same wrong way.
   */
  it("refuses an empty or unrecognised filter rather than matching everything", async () => {
    const db = new TestD1();
    seedFleet(db);

    for (const filter of [{}, { ghost: false }, { nonsense: true }, { staleness: "very" }]) {
      const res = await act(db, { action: "deleteMatching", filter, expectCount: 5 });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "empty_filter" });
    }
    expect(db.count("user_telemetry")).toBe(5);
  });

  it("filters by staleness bucket", async () => {
    const db = new TestD1();
    seedFleet(db);

    const res = await act(db, { action: "deleteMatching", filter: { staleness: "abandoned" }, expectCount: 1 });
    expect(res.status).toBe(200);
    expect(db.count("user_telemetry", "device_id = 'old'")).toBe(0);
    expect(db.count("user_telemetry")).toBe(4);
  });

  it("404s when a valid filter matches nothing", async () => {
    const db = new TestD1();
    seedFleet(db);
    const res = await act(db, { action: "deleteMatching", filter: { staleness: "stale" }, expectCount: 0 });
    expect(res.status).toBe(404);
    expect(db.count("user_telemetry")).toBe(5);
  });

  it("reports how many accounts it emptied, and records the bulk action once", async () => {
    const db = new TestD1();
    const a = seedUser(db, { id: uid(22) });
    // This account's ONLY row is a ghost, so clearing ghosts empties it.
    seedDevice(db, { userId: a, deviceId: "" });

    const res = await act(db, { action: "deleteMatching", filter: { ghost: true }, expectCount: 1 });
    expect(await res.json()).toMatchObject({ deleted: 1, accountsEmptied: 1 });

    const rows = db.rows<{ action: string; target_id: string; detail: string }>(
      "SELECT action, target_id, detail FROM admin_actions",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("device_delete");
    expect(JSON.parse(rows[0].detail)).toMatchObject({ bulk: true, deleted: 1, accountsEmptied: 1 });
  });

  it("400s on a missing or negative expectCount", async () => {
    const db = new TestD1();
    seedFleet(db);
    expect((await act(db, { action: "deleteMatching", filter: { ghost: true } })).status).toBe(400);
    expect((await act(db, { action: "deleteMatching", filter: { ghost: true }, expectCount: -1 })).status).toBe(400);
  });
});
