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
import { loadSharedLists, type ListsEnv } from "./lists";
import { loadMatches, sweepOnceMatchPayloads, sweepTerminalMatches, type MatchEnv } from "./match";
import { readProfileRow, toWire, type ProfileEnv } from "./profiles";

export type SyncEnv = FeedEnv & ProfileEnv & ListsEnv & MatchEnv & RetirementEnv;

export interface RetirementEnv {
}


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
  /**
   * Opt in to the shared-list and Friend Match handshakes. Both are bounded by
   * friend count and both used to be read every pass through the inbox, so they add
   * rows to a request rather than a request.
   *
   * **Flags, not always-on**, for the same reason `relay` is: a field the client did
   * not ask for is bytes on every sync forever, and a client that renders neither
   * should not pay for them.
   */
  lists?: boolean;
  match?: boolean;
}

export interface RelayRequest {
  /** The caller's own device friendId — needed to seal a rotated access slot. */
  requesterId?: string;
  friends?: Array<{ friendId: string; readToken: string; since?: number; keyEpoch?: number }>;
  /**
   * Blind-index key for the live friends+block record. Possession of the key IS the
   * authorization here — it is derived from a secret only the owner's devices hold —
   * so this needs no separate check, exactly as `GET /api/social/self/{key}` doesn't.
   */
  selfLookupKey?: string;
}

export interface RelayResponse {
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

  // Has this account claimed a device friendId? It is the ONLY route from an account
  // to a push topic (topics are keyed by friendId, and the record lives in R2), so
  // without it `notifyAccount` finds nothing and every push silently does not happen.
  //
  // Asked here, on a request the client already makes, because the alternatives are
  // worse: claiming on sign-in alone never retries after a transient failure and never
  // reaches an account that signed in before the code existed, and a debug-only button
  // reaches no real user at all. One PK lookup, and the client acts only when told to.
  // 3. The D1 replacements for the last two inbox message types. Null when not
  //    asked for, which is also what a client on an older Worker sees — so the
  //    absent case must mean "fall back", never "you have none".
  const lists = body.lists ? await loadSharedLists(env, session.userId) : null;
  const match = body.match ? await loadMatches(env, session.userId) : null;

  // 4. R2, if the caller asked for it. This half now carries ONLY the live friends+block
  //    record. The E2EE inbox went with the last message type it carried (Part C), and the
  //    freshness scan went at step 7 with the profile.json it reported on — so `friends`
  //    below is vestigial and kept solely to cap what an older client may still send.
  let relay: RelayResponse | null = null;
  if (body.relay && loadRelay) {
    relay = await loadRelay(env, session.userId, {
      ...body.relay,
      friends: (body.relay.friends ?? []).slice(0, MAX_RELAY_FRIENDS),
    });
  }

  // Backstop deletes riding ambient sync traffic, because this account has no cron
  // budget left — same reason the orphan-profile reaper is opportunistic. Neither
  // blocks the response.
  //
  // The payload sweep catches `once` blobs nobody collected; the terminal sweep drops
  // handshake tombstones once every device has long since converged on them. Without
  // the second one, `match_requests` grows for the life of an account — nothing else
  // prunes it but account deletion.
  if (body.match) {
    ctx?.waitUntil(sweepOnceMatchPayloads(env).catch(() => {}));
    ctx?.waitUntil(sweepTerminalMatches(env).catch(() => {}));
  }

  return json({
    written,
    feed: { events, cursor },
    friends,
    profile,
    lists,
    match,
    relay,
    // Server-controlled so the date can move without an app release — a date baked
    // into a build cannot be corrected for anyone who never updates. Null until one
    // is set, which is the default, so this changes nothing until you schedule it.
    serverTime: Date.now(),
  });
}
