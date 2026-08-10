// ── The admin Devices panel ──────────────────────────────────────────────────
// The fleet, with the account each device belongs to, and a way to delete rows for
// devices that no longer exist.
//
// `user_telemetry` only ever accumulates. Nothing has cleaned it up, and two documented
// mechanisms create rows for handsets that are gone:
//
//   GHOST ROWS. `device_id = ''` is the header-only write from a client predating the
//   telemetry block. Harmless until the same handset later reports properly, at which
//   point the account holds a permanent second row that double-counts it. insights.ts
//   already surfaces the count as `health.ghostDeviceRows`; this is where it gets fixed.
//
//   WIPED-STORE DUPLICATES. `device_id` was originally a random UUID in DataStore, which
//   made it INSTALL-scoped: anything that emptied the store minted a new one.
//   TelemetryDeviceId.kt records the finding of 2026-08-04 — eight rows for one account
//   across two handsets, every duplicate reporting `watched: 0` and no integrations. That
//   fingerprint is the detection rule below.
//
// ⚠️ **A UUID-shaped id is NOT evidence of staleness**, and treating it as such would
// delete live handsets. `TelemetryDeviceId.get()` returns a cached id when one exists, so
// an install that already minted a UUID keeps it forever; a null SSAID (emulators, a
// freshly-provisioned device before unlock) mints one too. Shape is INFORMATION here, never
// a deletion criterion.

import { adminAuthorized } from "./commentsAdmin";
import { minSocialVersion } from "./profiles";
import { deviceLabel, integrationList, type UsersAdminEnv } from "./usersAdmin";
import { actorOf, recordAdminAction } from "./adminAudit";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-Admin-Actor",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const DAY_MS = 86_400_000;

/** A salted SHA-256 of the SSAID: 64 lowercase hex characters. See TelemetryDeviceId.kt. */
const DERIVED_ID = /^[a-f0-9]{64}$/;
/** The install-scoped random UUID, still legitimately in use — see the header note. */
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IdShape = "derived" | "uuid" | "ghost" | "other";

export function idShape(deviceId: string): IdShape {
  if (deviceId === "") return "ghost";
  if (DERIVED_ID.test(deviceId)) return "derived";
  if (UUID_ID.test(deviceId)) return "uuid";
  return "other";
}

export type Staleness = "live" | "quiet" | "dormant" | "stale" | "abandoned";

/** Buckets, not a raw age, so the filter rail can offer them and count them. */
export function staleness(lastSeenAt: number, now: number): Staleness {
  const days = (now - lastSeenAt) / DAY_MS;
  if (days <= 7) return "live";
  if (days <= 30) return "quiet";
  if (days <= 90) return "dormant";
  if (days <= 180) return "stale";
  return "abandoned";
}

interface DeviceRow {
  user_id: string;
  device_id: string;
  platform: string | null;
  version_code: number | null;
  version_name: string | null;
  build_type: string | null;
  country: string | null;
  language: string | null;
  os_api: number | null;
  manufacturer: string | null;
  model: string | null;
  installer: string | null;
  premium: number | null;
  gate_outcome: string | null;
  ads_consent: string | null;
  integrations: string | null;
  features: string | null;
  last_seen_at: number;
  reported_on: string;
  display_name: string | null;
  email: string | null;
}

// ── GET /api/devices ─────────────────────────────────────────────────────────

export async function handleDevicesList(req: Request, env: UsersAdminEnv): Promise<Response> {
  if (!adminAuthorized(req, env as never)) return json({ error: "unauthorized" }, 401);

  const now = Date.now();
  const floor = minSocialVersion(env);

  // The account columns are the whole difference from the Insights roster, which carries
  // only a six-character id prefix by design.
  const { results } = await env.DB.prepare(
    `SELECT t.user_id, t.device_id, t.platform, t.version_code, t.version_name, t.build_type,
            t.country, t.language, t.os_api, t.manufacturer, t.model, t.installer, t.premium,
            t.gate_outcome, t.ads_consent, t.integrations, t.features, t.last_seen_at,
            t.reported_on, p.display_name, i.email
       FROM user_telemetry t
       LEFT JOIN profiles   p ON p.user_id = t.user_id
       LEFT JOIN identities i ON i.user_id = t.user_id
      ORDER BY t.last_seen_at DESC`,
  ).all<DeviceRow>();
  const rows = results ?? [];

  // Per-account context, needed for the duplicate fingerprint: a row only looks like a
  // wiped store if the SAME account also has a row that carries real data.
  const rich = new Set<string>();
  const perAccount = new Map<string, number>();
  for (const r of rows) {
    perAccount.set(r.user_id, (perAccount.get(r.user_id) ?? 0) + 1);
    const counts = parseCounts(r.features);
    if ((counts.watched ?? 0) > 0 || integrationList(r.integrations).length > 0) rich.add(r.user_id);
  }

  const devices = rows.map((r) => {
    const counts = parseCounts(r.features);
    const integrations = integrationList(r.integrations);
    const empty = (counts.watched ?? 0) === 0 && integrations.length === 0;
    return {
      userId: r.user_id,
      displayName: r.display_name,
      email: r.email,
      deviceId: r.device_id,
      idShape: idShape(r.device_id),
      device: deviceLabel(r),
      platform: r.platform,
      versionName: r.version_name,
      versionCode: r.version_code,
      buildType: r.build_type,
      osApi: r.os_api,
      country: r.country,
      language: r.language,
      installer: r.installer,
      premium: r.premium == null ? null : r.premium === 1,
      gate: r.gate_outcome,
      adsConsent: r.ads_consent,
      integrations,
      watched: counts.watched ?? 0,
      lastSeenAt: r.last_seen_at,
      reportedOn: r.reported_on,
      staleness: staleness(r.last_seen_at, now),
      /** The account has more than one row, so this one may be a duplicate of another. */
      accountDevices: perAccount.get(r.user_id) ?? 1,
      flags: {
        ghost: r.device_id === "",
        /** Never sent the client telemetry block — a header-only row. */
        headerOnly: r.version_name == null,
        /**
         * The documented wiped-store fingerprint: no library, no integrations, and a
         * sibling row on the same account that HAS data. Without the sibling test this
         * would flag every genuinely new device on its first day.
         */
        wipedStoreSuspect: empty && (perAccount.get(r.user_id) ?? 1) > 1 && rich.has(r.user_id),
        /** App rows only — a browser sends no `X-App-Version` and would sit here forever. */
        belowFloor: floor > 0 && r.platform !== "web" && (r.version_code ?? 0) < floor,
      },
    };
  });

  return json({ generatedAt: now, minSocialVersion: floor, total: devices.length, devices });
}

function parseCounts(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { counts?: Record<string, number> };
    return parsed?.counts ?? {};
  } catch {
    return {};
  }
}

// ── POST /api/devices/act ────────────────────────────────────────────────────

/**
 * `{ action: "delete", userId, deviceId }` or
 * `{ action: "deleteMatching", filter, expectCount }`.
 *
 * ⚠️ Four things about deleting a telemetry row that the panel must also state, because
 * none of them is obvious from the button:
 *
 *  1. **It is self-correcting, not permanent.** A still-installed device rewrites its row
 *     on the next launch (subject to the once-per-UTC-day `reported_on` guard). This
 *     clears records of devices that are GONE; it cannot remove a live one. A mistake
 *     therefore heals within a day, which is what makes this safe to offer at all.
 *  2. **It cannot sign a device out.** `sessions` has no `device_id`, so no device↔session
 *     link exists and there is no per-device revocation. The only sign-out is
 *     all-sessions, on the Accounts page.
 *  3. **Deleting an account's LAST row moves it into Insights' `orphanAccounts`**, which
 *     renders as "signed in, never reported" — false once you deleted the report. The
 *     response reports `accountsEmptied` so the panel can say so.
 *  4. `telemetry_daily` is untouched: it is immutable, holds no user ids, and is where the
 *     trend series lives. Distributions and `coverage.*` on Insights WILL move, which is
 *     the point of a cleanup.
 *
 * A HARD delete, not a tombstone: this is regenerable current state, and the history is
 * already preserved in the rollup.
 */
export async function handleDevicesAct(req: Request, env: UsersAdminEnv): Promise<Response> {
  if (!adminAuthorized(req, env as never)) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const action = String(body.action ?? "");
  const actor = actorOf(req);

  if (action === "delete") {
    const userId = typeof body.userId === "string" ? body.userId : "";
    // `''` is a VALID device id — the ghost row — so this checks the type, not the truth.
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : null;
    if (!userId || deviceId == null) return json({ error: "bad_request" }, 400);

    const row = await env.DB.prepare(
      "SELECT last_seen_at FROM user_telemetry WHERE user_id = ? AND device_id = ?",
    )
      .bind(userId, deviceId)
      .first<{ last_seen_at: number }>();
    if (!row) return json({ error: "not_found" }, 404);

    await env.DB.prepare("DELETE FROM user_telemetry WHERE user_id = ? AND device_id = ?")
      .bind(userId, deviceId)
      .run();
    const left = await countFor(env, userId);
    await recordAdminAction(env.DB, actor, "device_delete", userId, {
      deviceId,
      lastSeenAt: row.last_seen_at,
      devicesLeft: left,
    });
    return json({ ok: true, deleted: 1, accountsEmptied: left === 0 ? 1 : 0 });
  }

  if (action !== "deleteMatching") return json({ error: "unsupported_action" }, 400);

  /**
   * Bulk delete, re-derived server-side.
   *
   * `expectCount` is the count the panel PREVIEWED. If the set has changed since — a
   * device reported in, someone else deleted a row — the request is refused rather than
   * deleting a different set than the one the operator looked at. The panel re-reads and
   * shows the new count.
   */
  const filter = (body.filter ?? {}) as { staleness?: unknown; ghost?: unknown; wipedStoreSuspect?: unknown };
  const expectCount = Number(body.expectCount);
  if (!Number.isInteger(expectCount) || expectCount < 0) return json({ error: "bad_request" }, 400);

  const wantGhost = filter.ghost === true;
  const wantWiped = filter.wipedStoreSuspect === true;
  const STALENESS: Staleness[] = ["live", "quiet", "dormant", "stale", "abandoned"];
  const wantStaleness = STALENESS.find((s) => s === filter.staleness) ?? null;

  // ⚠️ An empty filter would match the WHOLE FLEET. Refused up front rather than falling
  // through to a delete: a typo'd field name would otherwise silently become "everything",
  // and `expectCount` alone cannot catch that if the panel computed it the same wrong way.
  if (!wantGhost && !wantWiped && !wantStaleness) return json({ error: "empty_filter" }, 400);

  // Reuses the list endpoint's own classification rather than a second SQL predicate, so
  // the preview and the delete can never disagree about what a filter means.
  const listed = (await (await handleDevicesList(req, env)).json()) as {
    devices: Array<{
      userId: string;
      deviceId: string;
      staleness: string;
      flags: { ghost: boolean; wipedStoreSuspect: boolean };
    }>;
  };
  const matched = listed.devices.filter((d) => {
    if (wantGhost && !d.flags.ghost) return false;
    if (wantWiped && !d.flags.wipedStoreSuspect) return false;
    if (wantStaleness && d.staleness !== wantStaleness) return false;
    return true;
  });

  if (matched.length === 0) return json({ error: "no_matches" }, 404);
  if (matched.length !== expectCount) {
    return json({ error: "count_changed", expected: expectCount, actual: matched.length }, 409);
  }

  const touched = new Set(matched.map((d) => d.userId));
  await env.DB.batch(
    matched.map((d) =>
      env.DB.prepare("DELETE FROM user_telemetry WHERE user_id = ? AND device_id = ?").bind(d.userId, d.deviceId),
    ),
  );

  let emptied = 0;
  for (const userId of touched) {
    if ((await countFor(env, userId)) === 0) emptied++;
  }

  await recordAdminAction(env.DB, actor, "device_delete", "*", {
    bulk: true,
    filter,
    deleted: matched.length,
    accountsTouched: touched.size,
    accountsEmptied: emptied,
  });
  return json({ ok: true, deleted: matched.length, accountsEmptied: emptied });
}

/** Rows left for one account, to report the orphan consequence honestly. */
async function countFor(env: UsersAdminEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_telemetry WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
