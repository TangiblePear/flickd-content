/**
 * The commsuni.tv upstream client.
 *
 * **This module is the only thing that holds the API key and the only thing that
 * ever mints `X-TVTA-Actor-ID`.** Everything else in the worker asks it for data.
 *
 * The actor ID is derived from `resolveSession(...).userId` and **never** from
 * anything the device sends — §2 is explicit that "an actor ID supplied by a user
 * device is not an identity". `users.id` is already stable across devices and
 * reinstalls, which is exactly the stability the header demands.
 */

const BASE = "https://api.commsuni.tv/v1";

/** §1: reads and writes both. A route whose scope we lack is 403 insufficient_scope. */
export interface CommsuniEnv {
  DB: D1Database;
  /** Issued out of band. Never in the APK — the device never sees it. */
  COMMSUNI_KEY?: string;
  /** Second valid key, for zero-downtime rotation. Tried only if the primary 401s. */
  COMMSUNI_KEY_NEXT?: string;
  /** HMAC key for the actor ID. Ours, not the operator's. */
  COMMSUNI_ACTOR_SECRET?: string;
  /** Our own slug in the catalogue. The dedup filter drops it. */
  COMMSUNI_SLUG?: string;
  HISTORY_STATS_KV?: KVNamespace;
}

/** Upstream is configured at all? Every caller should degrade rather than throw. */
export const commsuniEnabled = (env: CommsuniEnv): boolean => !!env.COMMSUNI_KEY;

/**
 * ⚠️ **5 seconds, and it is a budget, not a timeout for one call.** The archive fetch
 * rides `handleGetFriendComments`, which the user is waiting on. §7: a failed archive
 * call hides the comments section, it does not break the screen.
 */
const TIMEOUT_MS = 5_000;

/** Retries are for transient failures ONLY — see [shouldRetry]. */
const MAX_ATTEMPTS = 3;

// ── Circuit breaker ─────────────────────────────────────────────────────────
//
// ⚠️ Per-isolate and in memory, deliberately. A breaker in D1 would cost a read on
// every request to answer a question that is only worth asking when things are
// already broken. An isolate that has just seen the upstream fail is also the one
// most likely to be about to fail again, so local state is the useful state.
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30_000;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

const breakerOpen = () => Date.now() < breakerOpenUntil;

function recordFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    consecutiveFailures = 0;
    console.log(JSON.stringify({ msg: "commsuni breaker opened", cooldownMs: BREAKER_COOLDOWN_MS }));
  }
}

const recordSuccess = (): void => {
  consecutiveFailures = 0;
};

/** Test seam: the breaker is module state, so a test that trips it would poison the next. */
export function __resetBreaker(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

// ── Actor ID ────────────────────────────────────────────────────────────────

/**
 * `HMAC_SHA256(COMMSUNI_ACTOR_SECRET, users.id)`, hex.
 *
 * ⚠️ **Never rotate the secret once anything has been written.** Every actor ID moves
 * with it, so upstream we would become an entirely new set of users: every mirrored
 * comment orphaned from its author, and every block and report keyed to the old
 * actors stops matching. There is no migration path — the server stores only a keyed
 * hash of what we send.
 *
 * The output is 64 hex characters, inside §2's `[A-Za-z0-9][A-Za-z0-9._:@/-]*` and
 * well under the 128-byte cap.
 */
export async function actorId(env: CommsuniEnv, userId: string): Promise<string | null> {
  const secret = env.COMMSUNI_ACTOR_SECRET;
  if (!secret || !userId) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(userId));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Request ─────────────────────────────────────────────────────────────────

export interface CommsuniResult<T> {
  ok: boolean;
  data?: T;
  /** Upstream's `error.code`, or a synthetic one for transport failures. */
  code?: string;
  status?: number;
  /** True when a write was replayed rather than performed. */
  replayed?: boolean;
  /** `Report-Duplicate: true` — a bare 202 is NOT proof a report landed. */
  reportDuplicate?: boolean;
}

interface CallOptions {
  method?: string;
  body?: unknown;
  /** One key per user ACTION, reused verbatim on retry, never across bodies. */
  idempotencyKey?: string;
  /** Omit only for the sources catalog, which is not viewer-specific. */
  actor?: string | null;
}

/**
 * Retry only what can succeed on a second try.
 *
 * ⚠️ 4xx other than 429 is a statement about the request, not the network — retrying
 * it burns quota to be told the same thing. `write_unit` is charged on the REQUEST,
 * not the outcome, so a retried 400 costs real money for nothing.
 */
const shouldRetry = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

/** Full jitter. Fixed backoff synchronises every isolate onto the same retry instant. */
const backoffMs = (attempt: number): number => Math.floor(Math.random() * Math.min(1000 * 2 ** attempt, 4000));

/**
 * One upstream call, with the whole cross-cutting contract applied.
 *
 * ⚠️ **The header set is an allowlist, built here from nothing.** The incoming request
 * is never forwarded, in whole or in part — `Origin` in particular would make our
 * server-to-server call look like a browser's and can change how it is treated. The
 * only headers upstream sees are the ones written below.
 */
export async function commsuniCall<T>(
  env: CommsuniEnv,
  path: string,
  opts: CallOptions = {},
): Promise<CommsuniResult<T>> {
  if (!commsuniEnabled(env)) return { ok: false, code: "not_configured" };
  if (breakerOpen()) return { ok: false, code: "breaker_open" };

  const keys = [env.COMMSUNI_KEY, env.COMMSUNI_KEY_NEXT].filter(Boolean) as string[];
  let last: CommsuniResult<T> = { ok: false, code: "unknown" };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoffMs(attempt)));

    for (const key of keys) {
      const headers: Record<string, string> = {
        // ⚠️ `.trim()`: a pasted key routinely carries a trailing newline, which some
        // stacks accept and others reject — an asymmetry that reads as a code bug for
        // hours when it is purely the stored data.
        Authorization: `Bearer ${key.trim()}`,
        Accept: "application/json",
      };
      if (opts.actor) headers["X-TVTA-Actor-ID"] = opts.actor;
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

      let res: Response;
      try {
        res = await fetch(BASE + path, {
          method: opts.method ?? "GET",
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        // Timeout or transport failure. Counts toward the breaker and is retryable.
        last = { ok: false, code: "network" };
        recordFailure();
        break;
      }

      logRateLimit(res, path);

      // 401 on the primary is the one case worth trying the NEXT key for — that is
      // what makes rotation zero-downtime. Any other status is the answer.
      if (res.status === 401 && keys.length > 1 && key !== keys[keys.length - 1]) continue;

      if (res.ok) {
        recordSuccess();
        const parsed = await res.json().catch(() => null) as { data?: T } | null;
        return {
          ok: true,
          data: parsed?.data,
          status: res.status,
          replayed: res.headers.get("Idempotency-Replayed") === "true",
          reportDuplicate: res.headers.get("Report-Duplicate") === "true",
        };
      }

      const body = await res.json().catch(() => null) as { error?: { code?: string } } | null;
      last = { ok: false, code: body?.error?.code ?? `http_${res.status}`, status: res.status };

      if (!shouldRetry(res.status)) {
        // A definite answer. 404 not_archived is the common one and is an EMPTY
        // STATE, not a failure — the caller decides that, not us.
        recordSuccess();
        return last;
      }
      recordFailure();
      break;
    }
  }
  return last;
}

/**
 * Log the quota meters so they can be watched before they bite.
 *
 * Three independent meters (`read_units`, `media_grants`, `write_units`), and
 * `X-RateLimit-Metric` says which one this response is reporting on. When reads trend
 * toward zero we should refetch less; when writes do, throttle the outbox drain
 * rather than failing the user's action.
 */
function logRateLimit(res: Response, path: string): void {
  const remaining = res.headers.get("RateLimit-Remaining");
  if (remaining == null) return;
  console.log(
    JSON.stringify({
      msg: "commsuni ratelimit",
      path,
      metric: res.headers.get("X-RateLimit-Metric"),
      remaining,
      limit: res.headers.get("RateLimit-Limit"),
      status: res.status,
    }),
  );
}

// ── Source catalog ──────────────────────────────────────────────────────────

export interface CommsuniSource {
  slug: string;
  displayName?: string;
  iconUrl?: string;
  accentColor?: string;
  status?: string;
}

const SOURCES_KV_KEY = "commsuni:sources:v1";
const SOURCES_TTL_S = 86_400;

/**
 * In-isolate memory cache in front of KV.
 *
 * The catalog changes about never, and a KV read per request to learn that is waste.
 * Most requests never touch KV at all because of this.
 */
let sourcesMemo: { at: number; value: CommsuniSource[] } | null = null;
const SOURCES_MEMO_MS = 600_000;

/** Test seam — module-level memo would otherwise leak between cases. */
export function __resetSources(): void {
  sourcesMemo = null;
}

/**
 * The branding table, keyed by slug: 1 `read_unit` per 24h.
 *
 * ⚠️ **Never hard-code icons or names from this.** §5 requires attribution rendered
 * from the live catalog, and a partner that rebrands would otherwise show stale
 * branding in our UI indefinitely.
 */
export async function loadSources(env: CommsuniEnv): Promise<CommsuniSource[]> {
  if (sourcesMemo && Date.now() - sourcesMemo.at < SOURCES_MEMO_MS) return sourcesMemo.value;

  const cached = await env.HISTORY_STATS_KV?.get(SOURCES_KV_KEY, "json").catch(() => null);
  if (cached) {
    sourcesMemo = { at: Date.now(), value: cached as CommsuniSource[] };
    return sourcesMemo.value;
  }

  const res = await commsuniCall<CommsuniSource[]>(env, "/sources");
  if (!res.ok || !Array.isArray(res.data)) return sourcesMemo?.value ?? [];

  sourcesMemo = { at: Date.now(), value: res.data };
  await env.HISTORY_STATS_KV?.put(SOURCES_KV_KEY, JSON.stringify(res.data), {
    expirationTtl: SOURCES_TTL_S,
  }).catch(() => {});
  return res.data;
}

/**
 * Every active slug except ours — the `?source=` filter for a read.
 *
 * ⚠️ **This is the primary dedup, and it is server-side and first-class.** The guide
 * explicitly forbids the alternative of fetching pages and discarding our own rows:
 * that pays a `read_unit` for content we throw away and produces short pages.
 *
 * Returns null when the catalog is unavailable — the caller must then skip the read
 * rather than fetch unfiltered, because unfiltered means our own comments come back
 * and render twice.
 */
export function foreignSlugs(env: CommsuniEnv, sources: CommsuniSource[]): string[] | null {
  const ours = (env.COMMSUNI_SLUG ?? "").trim().toLowerCase();
  if (!ours) return null;
  if (sources.length === 0) return null;
  const out = sources
    .filter((s) => (s.status ?? "active") === "active")
    .map((s) => s.slug)
    .filter((slug) => slug && slug.toLowerCase() !== ours);
  return out.length > 0 ? out : null;
}
