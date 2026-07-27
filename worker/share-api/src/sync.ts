// ── One chargeable request per refresh ───────────────────────────────────────
// Cloudflare bills the INBOUND request, not the work inside it: a Worker may fan
// out to D1 and R2 freely. A full client sync was nine round trips and a feed
// refresh two, purely because the endpoints accreted one storage object at a time.
// This folds them into one.
//
// The request cap is the binding constraint on the free plan, not D1 — see
// `loadFeed`'s `since` cursor, which is what makes the row budget stop mattering.
// Nine sequential round trips on a mobile network is also just slow and fragile,
// which is the better argument.
//
// **Every existing endpoint stays.** The fleet lags; this is purely additive, and
// the old ones can only be deleted once telemetry says nobody calls them.

import { resolveSession } from "./auth";
import { loadFeed, publishEvents, type FeedEnv } from "./feed";
import { loadFriendships } from "./friends";
import { readProfileRow, toWire, type ProfileEnv } from "./profiles";

export type SyncEnv = FeedEnv & ProfileEnv;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-Revoke-Session",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

/**
 * Friend fan-out cap **per request**. The free plan allows 50 subrequests per
 * request, and a rotating author costs two R2 gets (profile + access), so 20
 * friends is the most that can fit beside the inbox read and the D1 queries.
 * Above it the client chunks and pays 2 requests instead of 1 — which is fine.
 */
export const MAX_RELAY_FRIENDS = 20;

/** What the client already holds, plus anything it wants written. */
export interface SyncRequest {
  /** Newest feed event the client holds. Older than the 30-day floor is clamped. */
  feedSince?: number;
  /** Profile version last seen; the server answers only when it holds a newer one. */
  profileVersion?: number;
  /** Newly-watched events, same shape as `POST /api/me/feed`. */
  events?: unknown[];
  /**
   * The E2EE relay half. **Omit it entirely once the relay retires** — the shape is
   * deliberately separable so deleting it needs no client change, and once friend
   * comments move out of E2EE this handler becomes two D1 queries.
   */
  relay?: RelayRequest;
}

export interface RelayRequest {
  /** The caller's own device friendId — needed to seal a rotated access slot. */
  requesterId?: string;
  /** Owner secret for the inbox read. Absent ⇒ no inbox is returned. */
  feedSecret?: string;
  friends?: Array<{ friendId: string; readToken: string; since?: number; keyEpoch?: number }>;
  /** Present ⇒ read this device's inbox in the same request. */
  inbox?: boolean;
  /**
   * Blind-index key for the live friends+block record. Possession of the key IS the
   * authorization here — it is derived from a secret only the owner's devices hold —
   * so this needs no separate check, exactly as `GET /api/social/self/{key}` doesn't.
   */
  selfLookupKey?: string;
}

export interface RelayResponse {
  freshness: unknown[];
  inbox: { items: unknown[]; acks: unknown[]; ownerRecreated: boolean } | null;
  /** Null when not asked for, or when nothing has been published yet (the 404 case). */
  self: { ciphertext: string; version: number } | null;
}

/**
 * Reads the R2 half. Injected rather than imported so this module stays free of the
 * relay's crypto helpers (they live in `index.ts` alongside the object layout) and
 * so the tests can exercise the D1 half without an R2 binding.
 */
export type RelayLoader = (env: SyncEnv, requesterId: string, req: RelayRequest) => Promise<RelayResponse>;

/**
 * `POST /api/sync` — one session-authenticated request per refresh.
 *
 * The client sends its cursors and any pending writes; the Worker applies the
 * writes and returns everything new. Writes go first so the reads below observe
 * them — a device that has just watched something should see its own sync settle
 * in the same round trip.
 *
 * **Route trap:** the pattern must be `flickto.app/api/sync*`. Cloudflare matches
 * routes against the full URL *including* the query string, so a bare pattern lets
 * any query-carrying form fall through to the static site as a 404. That has now
 * caused a silent production outage twice, and it is invisible to both the test
 * suite and `wrangler deploy --dry-run`.
 */
export async function handleSync(
  req: Request,
  env: SyncEnv,
  ctx?: ExecutionContext,
  loadRelay?: RelayLoader,
): Promise<Response> {
  const session = await resolveSession(req, env as any, ctx);
  if (!session) return json({ error: "unauthorized" }, 401);

  let body: SyncRequest;
  try {
    body = (await req.json()) as SyncRequest;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "invalid_payload" }, 400);

  // 1. Writes, so the reads below see them.
  const written = Array.isArray(body.events) ? await publishEvents(env, session.userId, body.events) : 0;

  // 2. D1. All subrequests, all free.
  const friends = await loadFriendships(env as any, session.userId);
  const feedSince = typeof body.feedSince === "number" ? body.feedSince : 0;
  const events = await loadFeed(env, session.userId, DEFAULT_PAGE, undefined, feedSince);
  const cursor = events.reduce((newest, e) => Math.max(newest, e.createdAt), feedSince);

  // Only when the server copy is genuinely newer — a client that is already current
  // gets `null` and re-renders nothing.
  const held = typeof body.profileVersion === "number" ? body.profileVersion : -1;
  const row = await readProfileRow(env, session.userId);
  const profile = row && row.version > held ? toWire(row) : null;

  // 3. R2, if the caller asked for it.
  let relay: RelayResponse | null = null;
  if (body.relay && loadRelay) {
    relay = await loadRelay(env, session.userId, {
      ...body.relay,
      friends: (body.relay.friends ?? []).slice(0, MAX_RELAY_FRIENDS),
    });
  }

  return json({
    written,
    feed: { events, cursor },
    friends,
    profile,
    relay,
    serverTime: Date.now(),
  });
}
