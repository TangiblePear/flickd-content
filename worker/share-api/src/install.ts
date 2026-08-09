// ── First-install date, and the beta-tester latch derived from it ────────────
//
// The device is the only thing that knows when FlickTo was first installed
// (`PackageManager.firstInstallTime`), and until migration 0030 nothing ever asked it.
// This route is where that fact reaches the account, so it survives a reinstall, a new
// handset, and a sign-out — none of which the device-local copy does.
//
// See migration 0030 for why the merge is MIN and why the latch is one-way.

import { resolveSession } from "./auth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export interface InstallEnv {
  DB: D1Database;
}

/**
 * Installed before this ⇒ beta tester. 2026-08-01 00:00 UTC, so the whole of 31 July
 * qualifies and nothing installed in August ever does.
 *
 * Lives here rather than on the client because a rule the client owns is a rule the
 * client can lie about. The client reports its install date; this decides what it means.
 */
export const BETA_CUTOFF_MS = 1785542400000;

/** Row shape for the two columns, for read paths that surface them. */
export interface InstallRow {
  first_install_at?: number | null;
  beta_tester?: number | null;
}

export function isBetaTester(row: InstallRow | null | undefined): boolean {
  return (row?.beta_tester ?? 0) !== 0;
}

/**
 * POST /api/me/install — body `{ firstInstallAt }` (epoch millis).
 *
 * Idempotent and safe to call on every launch; the client throttles it anyway. Returns
 * the account's merged answer so the caller can stop guessing locally.
 */
export async function handlePutInstall(
  req: Request,
  env: InstallEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  let body: { firstInstallAt?: unknown };
  try {
    body = (await req.json()) as { firstInstallAt?: unknown };
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const reported = Number(body.firstInstallAt);
  // A date in the future, or before the app could possibly have existed, is not evidence
  // of anything. Rejected rather than clamped: silently accepting nonsense and storing a
  // corrected value would make the stored date untraceable to what was reported.
  const now = Date.now();
  if (!Number.isFinite(reported) || reported <= 0 || reported > now || reported < EARLIEST_PLAUSIBLE_MS) {
    return json({ error: "invalid_date" }, 400);
  }
  const installedAt = Math.floor(reported);

  // MIN over non-zero, in one statement so two devices reporting at once cannot
  // interleave a read and a write and lose the earlier value.
  // ⚠️ Beta is derived from the MERGED date, not the reported one. Deriving it from the
  // report was wrong and a device caught it: a phone reinstalled in August reports August,
  // while the account already knew about July — and the account's own knowledge is what
  // the rule is about. Both branches recompute the same MIN expression; SQLite evaluates
  // every SET against the pre-update row, so they agree.
  const mergedInstall = `CASE WHEN first_install_at = 0 OR ? < first_install_at THEN ? ELSE first_install_at END`;
  await env.DB
    .prepare(
      `UPDATE users
          SET first_install_at = ${mergedInstall},
              -- Latch: once 1, always 1. A reinstall reports today's date and would
              -- otherwise revoke a badge the account had legitimately earned.
              beta_tester =
                CASE WHEN beta_tester = 1 THEN 1
                     WHEN (${mergedInstall}) < ? THEN 1
                     ELSE 0 END
        WHERE id = ?`,
    )
    .bind(installedAt, installedAt, installedAt, installedAt, BETA_CUTOFF_MS, session.userId)
    .run();

  const row = await env.DB
    .prepare("SELECT first_install_at, beta_tester FROM users WHERE id = ?")
    .bind(session.userId)
    .first<{ first_install_at: number; beta_tester: number }>();

  return json({
    firstInstallAt: row?.first_install_at ?? installedAt,
    betaTester: isBetaTester(row),
  });
}

/**
 * 2020-01-01. Anything earlier is a broken clock or a hostile client, not a very early
 * adopter — the app did not exist.
 */
const EARLIEST_PLAUSIBLE_MS = 1577836800000;
