// ── Firebase App Check (Play Integrity) ──────────────────────────────────────
// Binds a request to a genuine, unmodified install of the app. This is the only
// control here that a scripted client cannot satisfy: a session token proves
// *who* is calling, App Check proves *what* is calling. Everything else on the
// comment write path (session, hourly cap, burst limiter) throttles an attacker;
// this one excludes them.
//
// A THIRD verifier in this Worker, and deliberately so. `verifyFirebaseIdToken`
// (auth.ts) reads X.509 PEM certs; `verifyGoogleIdToken` (account.ts) reads
// Google's OAuth JWKS; App Check publishes its own JWK set at a third URL with
// different `iss`/`aud` rules. Sharing code between them has repeatedly been
// judged not worth the coupling — see the note at the top of auth.ts.
//
// ⚠️ The claim trap: App Check's `iss`/`aud` carry the Firebase project
// **NUMBER** (e.g. 468641021144). A Firebase *ID token*'s `aud` is the project
// **ID** (e.g. "flickto-cf7b6"), which is what FIREBASE_PROJECT_ID holds. They
// are not interchangeable, and swapping them fails every verification with a
// claim mismatch that reads like a signing bug.

export interface AppCheckEnv {
  /** Firebase project **number**, not the id. Absent ⇒ verification always fails. */
  FIREBASE_PROJECT_NUMBER?: string;
  /** "off" (skip), "log" (verify and record, never reject), "enforce" (reject). */
  APPCHECK_MODE?: string;
  /**
   * Lowest `X-App-Version` that is expected to send the header. Clients below it
   * are skipped even under `enforce`, so turning enforcement on never locks out a
   * build that shipped before the header existed.
   */
  APPCHECK_MIN_VERSION?: string;
}

export const APPCHECK_HEADER = "X-Firebase-AppCheck";

const JWKS_URL = "https://firebaseappcheck.googleapis.com/v1/jwks";
const JWKS_TTL_MS = 3600_000;

/**
 * Per-isolate JWK cache.
 *
 * Cached as imported `CryptoKey`s rather than raw JWKs: `importKey` is the
 * expensive half, and the 10 ms CPU budget is the binding constraint on this
 * Worker. Same reasoning as the cert cache in auth.ts.
 */
let keyCache: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

/** Test seam — mirrors `__setKeyCacheForTest` in auth.ts. */
export function __setAppCheckKeyCacheForTest(keys: Map<string, CryptoKey> | null, fetchedAt = Date.now()): void {
  keyCache = keys ? { keys, fetchedAt } : null;
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadKeys(): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (keyCache && now - keyCache.fetchedAt < JWKS_TTL_MS) return keyCache.keys;

  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`appcheck jwks ${res.status}`);
  const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid) continue;
    try {
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      );
    } catch {
      // One unusable key must not poison the whole set — Google rotates these.
    }
  }
  keyCache = { keys, fetchedAt: now };
  return keys;
}

/**
 * True only for a genuine, unexpired App Check token minted for this project.
 *
 * Returns false rather than throwing: every caller's next move is the same
 * regardless of *why* it failed, and a thrown error on the comment write path
 * would turn a bad token into a 500.
 */
export async function verifyAppCheckToken(token: string, env: AppCheckEnv): Promise<boolean> {
  try {
    const projectNumber = env.FIREBASE_PROJECT_NUMBER;
    if (!projectNumber) return false;

    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as { alg?: string; kid?: string };
    // Allow-list the algorithm before touching a key: this is what refuses
    // `alg: none` and an HMAC-confusion token signed with the public key.
    if (header.alg !== "RS256" || !header.kid) return false;

    const key = (await loadKeys()).get(header.kid);
    if (!key) return false;

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return false;

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
    };
    if (claims.iss !== `https://firebaseappcheck.googleapis.com/${projectNumber}`) return false;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(`projects/${projectNumber}`)) return false;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return false;

    return true;
  } catch {
    return false;
  }
}

export type AppCheckOutcome = "pass" | "fail" | "absent" | "skipped";

/**
 * Evaluate App Check for one request.
 *
 * Split from the reject decision on purpose: `log` mode has to do the full
 * verification and then *not* act on it, which is the whole point of the
 * staged rollout — the logs tell you whether real traffic would survive
 * enforcement before enforcement can lock anyone out.
 */
export async function evaluateAppCheck(
  req: Request,
  env: AppCheckEnv,
  appVersion: number,
): Promise<{ outcome: AppCheckOutcome; enforced: boolean }> {
  const mode = env.APPCHECK_MODE ?? "off";
  if (mode !== "log" && mode !== "enforce") return { outcome: "skipped", enforced: false };

  // A build that predates the header can never pass, so under `enforce` it is
  // exempt rather than broken. `X-App-Version` is attached to every FlickTo
  // request by the Android client's appVersionInterceptor.
  const minVersion = Number(env.APPCHECK_MIN_VERSION ?? "0");
  if (minVersion > 0 && appVersion < minVersion) return { outcome: "skipped", enforced: false };

  const token = req.headers.get(APPCHECK_HEADER) ?? "";
  const outcome: AppCheckOutcome = !token ? "absent" : (await verifyAppCheckToken(token, env)) ? "pass" : "fail";

  return { outcome, enforced: mode === "enforce" && outcome !== "pass" };
}

/**
 * One structured line per evaluated request, so adoption is countable in the
 * dashboard before `enforce` is switched on. Observability is enabled in
 * wrangler.toml, so this needs no storage of its own.
 *
 * Never logs the token or anything derived from it.
 */
export function logAppCheck(outcome: AppCheckOutcome, appVersion: number, mode: string): void {
  if (outcome === "skipped") return;
  console.log(JSON.stringify({ appcheck: outcome, appVersion, mode }));
}
