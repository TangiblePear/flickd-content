// ── Firebase Auth + server sessions (Phase 1) ────────────────────────────────
// Firebase Auth owns identity; this Worker verifies the Firebase ID token once
// and mints its OWN opaque session token, so every subsequent authenticated
// request costs one indexed D1 read (usually zero — see the Cache API below)
// instead of an RSA verification.
//
// This is NOT the same as `verifyGoogleIdToken` in account.ts. That verifies
// *legacy Google Sign-In* tokens against Google's JWKS and is live in
// production; leave it alone. Firebase publishes its signing keys as X.509 PEM
// certificates, not as a JWK set, so the two paths share no code deliberately.
//
// Never log the token, the uid, the session token or the email.

export interface AuthEnv {
  DB: D1Database;
  // Firebase project **id** (e.g. "flickto-cf7b6"), not the project number. A
  // Firebase ID token's `aud` is the project id. Absent → 503 not_configured.
  FIREBASE_PROJECT_ID?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Revoke-Session",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const FIREBASE_CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

/** Fixed session lifetime. Never slid forward — that would be a D1 write per request. */
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Upper bound on how long a validated session may live in the edge cache (revocation lag). */
const SESSION_CACHE_MAX_TTL_S = 300;
/** Fallback key TTL when the cert response carries no usable `Cache-Control: max-age`. */
const KEY_TTL_FALLBACK_MS = 3600_000;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

// ── base64url / hex ──────────────────────────────────────────────────────────
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64ToBytes(s);
}
function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// ── Minimal DER walk: X.509 certificate → SubjectPublicKeyInfo ───────────────
// `crypto.subtle.importKey("spki", …)` wants the SPKI, not the whole
// certificate, and Firebase publishes only certificates. An X.509 Certificate
// is SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }, and
// inside tbsCertificate the fields are, in order: optional [0] version,
// serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo.

interface Tlv {
  tag: number;
  start: number; // first byte of the tag (so start..end is the full TLV)
  contentStart: number;
  contentEnd: number;
  end: number;
}

function readTlv(buf: Uint8Array, offset: number): Tlv {
  if (offset + 2 > buf.length) throw new Error("der_truncated");
  const tag = buf[offset];
  let i = offset + 1;
  let len = buf[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || i + n > buf.length) throw new Error("der_bad_length");
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[i++];
  }
  const contentStart = i;
  const end = contentStart + len;
  if (end > buf.length) throw new Error("der_overrun");
  return { tag, start: offset, contentStart, contentEnd: end, end };
}

function derChildren(buf: Uint8Array, el: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let o = el.contentStart;
  while (o < el.contentEnd) {
    const c = readTlv(buf, o);
    out.push(c);
    o = c.end;
  }
  return out;
}

/**
 * Extract the SubjectPublicKeyInfo TLV from an X.509 certificate in DER form.
 * Exported for tests — it is the fiddliest part of the verification path.
 * Throws on anything that is not a well-formed certificate.
 */
export function extractSpkiFromCertificate(der: Uint8Array): Uint8Array {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error("not_a_certificate");
  const tbs = readTlv(der, cert.contentStart);
  if (tbs.tag !== 0x30) throw new Error("not_a_tbs_certificate");
  const fields = derChildren(der, tbs);
  // [0] EXPLICIT version is optional (absent on v1 certs); everything after it
  // is positional: serialNumber, signature, issuer, validity, subject, SPKI.
  const idx = (fields.length > 0 && fields[0].tag === 0xa0 ? 1 : 0) + 5;
  const spki = fields[idx];
  if (!spki || spki.tag !== 0x30) throw new Error("spki_not_found");
  return der.subarray(spki.start, spki.end);
}

/** Strip PEM armour and whitespace, then base64-decode to DER. */
export function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return b64ToBytes(b64);
}

// ── Firebase signing keys (imported CryptoKeys, cached per isolate) ──────────
// §12: re-parsing and re-importing certs on every request eats meaningfully
// into the 10 ms CPU budget, so the cache holds CryptoKey objects, not PEM text.

let keyCache: { keys: Map<string, CryptoKey>; exp: number } | null = null;

async function getFirebaseKeys(): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (keyCache && keyCache.exp > now) return keyCache.keys;
  const resp = await fetch(FIREBASE_CERT_URL);
  if (!resp.ok) throw new Error("firebase_certs_fetch_failed");
  const body = (await resp.json()) as Record<string, string>;
  const keys = new Map<string, CryptoKey>();
  for (const [kid, pem] of Object.entries(body)) {
    if (typeof pem !== "string") continue;
    try {
      const spki = extractSpkiFromCertificate(pemToDer(pem));
      keys.set(
        kid,
        await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      );
    } catch {
      // One malformed cert must not poison the whole key set.
    }
  }
  if (keys.size === 0) throw new Error("firebase_certs_empty");
  const m = (resp.headers.get("cache-control") ?? "").match(/max-age=(\d+)/);
  keyCache = { keys, exp: now + (m ? Number(m[1]) * 1000 : KEY_TTL_FALLBACK_MS) };
  return keys;
}

/** Test seam: seed (or with `null`, clear) the imported-key cache. Tests only. */
export function __setKeyCacheForTest(keys: Map<string, CryptoKey> | null, ttlMs = KEY_TTL_FALLBACK_MS): void {
  keyCache = keys ? { keys, exp: Date.now() + ttlMs } : null;
}

/**
 * Verify a Firebase ID token and return `{ uid, email? }`, or null if anything
 * about it is wrong. Asserts header `alg === "RS256"` and a known `kid`,
 * `aud === FIREBASE_PROJECT_ID`, `iss === https://securetoken.google.com/<id>`,
 * a non-empty `sub` (the Firebase uid), a future `exp` and a past `iat`.
 * `auth_time` is not required. Never throws and never logs the token.
 */
export async function verifyFirebaseIdToken(token: string, env: AuthEnv): Promise<{ uid: string; email?: string } | null> {
  try {
    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as { alg?: string; kid?: string };
    // Explicit allow-list, not a deny-list: "none" and any HMAC alg must die here.
    if (header.alg !== "RS256" || !header.kid) return null;

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as {
      iss?: string;
      aud?: string;
      sub?: string;
      email?: string;
      exp?: number;
      iat?: number;
    };
    if (claims.aud !== projectId) return null;
    if (claims.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
    const now = Date.now();
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
    if (typeof claims.iat !== "number" || claims.iat * 1000 > now) return null;

    const key = (await getFirebaseKeys()).get(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    return typeof claims.email === "string" && claims.email ? { uid: claims.sub, email: claims.email } : { uid: claims.sub };
  } catch {
    return null;
  }
}

// ── Ids, hashing, session cache ──────────────────────────────────────────────
function bearer(req: Request): string {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** A fresh opaque `users.id`: 128 random bits in Crockford base32 (26 chars). */
function newUserId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** 32 random bytes, base64url, unpadded. Only the sha256 of this is ever stored. */
function newSessionToken(): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
}

// Synthetic cache key — the hash never appears in a real URL or a log line.
const sessionCacheKey = (hash: string) => new Request(`https://session.invalid/${hash}`);

/** `caches.default` where it exists (Workers). Node/vitest has no Cache API. */
function edgeCache(): Cache | null {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/session — exchange a Firebase ID token (Bearer) for a FlickTo
 * session token. Creates the `users` + `identities` rows on first sight of a
 * uid. Returns `{ sessionToken, userId, expiresAt, created }` where `expiresAt`
 * is epoch MILLISECONDS. 503 not_configured / 401 unauthorized / 403 forbidden.
 *
 * `created` reports which branch this call took: true when the account was made
 * here and now, false when the uid was already known. With Google as the only
 * provider, registering and signing in are the SAME call — this flag is the only
 * thing that can tell them apart, and without it the web has no way to greet a
 * first-time account differently from a returning one. Additive: the Android
 * client parses with `ignoreUnknownKeys` and never sees it.
 *
 * `X-Revoke-Session: <old session token>` retires the caller's outgoing session
 * in the same request. A client renewing its session MUST send this: without it
 * the replaced token stays valid for its full 90 days with no device holding it,
 * so nothing can ever revoke it and signing out does not end it.
 */
export async function handleAuthSession(req: Request, env: AuthEnv): Promise<Response> {
  if (!env.FIREBASE_PROJECT_ID) return json({ error: "not_configured" }, 503);
  const verified = await verifyFirebaseIdToken(bearer(req), env);
  if (!verified) return json({ error: "unauthorized" }, 401);

  const now = Date.now();
  const identity = await env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?")
    .bind("firebase", verified.uid)
    .first<{ user_id: string }>();

  let userId: string;
  let created = false;
  if (identity) {
    userId = identity.user_id;
    const user = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(userId).first<{ status: string }>();
    if (!user || user.status !== "active") return json({ error: "forbidden" }, 403);
  } else {
    userId = newUserId();
    created = true;
    // One batch so a user never exists without its identity, or vice versa.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, created_at, status) VALUES (?, ?, 'active')").bind(userId, now),
      env.DB
        .prepare("INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind("firebase", verified.uid, userId, verified.email ?? null, now),
    ]);
  }

  const token = newSessionToken();
  const expiresAt = now + SESSION_TTL_MS;
  const statements = [
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
      await sha256Hex(token),
      userId,
      now,
      expiresAt,
    ),
    // Drop this user's already-dead sessions. Bounded (one user, uses
    // idx_sessions_user) and it runs on a write, never on a read, so it keeps the
    // table from growing forever without needing a cron we have no budget for.
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").bind(userId, now),
  ];

  // Retire the session being replaced, scoped to this user so holding a Firebase
  // token can never revoke somebody else's.
  const outgoing = req.headers.get("X-Revoke-Session")?.trim();
  if (outgoing) {
    statements.push(
      env.DB.prepare(
        "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL",
      ).bind(now, await sha256Hex(outgoing), userId),
    );
  }
  await env.DB.batch(statements);
  if (outgoing) await edgeCache()?.delete(sessionCacheKey(await sha256Hex(outgoing)));

  return json({ sessionToken: token, userId, expiresAt, created });
}

/**
 * POST /api/auth/logout — revoke the session in the Bearer header and drop its
 * edge-cache entry. Always 204 with no body: an unknown, already-revoked or
 * expired token is indistinguishable from a live one to the caller.
 */
export async function handleAuthLogout(req: Request, env: AuthEnv): Promise<Response> {
  const token = bearer(req);
  if (token) {
    const hash = await sha256Hex(token);
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(Date.now(), hash)
      .run();
    await edgeCache()?.delete(sessionCacheKey(hash));
  }
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Resolve the Bearer session token on an authenticated request to its `userId`,
 * or null. Checks the Workers Cache API first so the common case costs no D1
 * read at all; a positive result is cached for at most SESSION_CACHE_MAX_TTL_S
 * (and never past the session's own expiry), which is also the revocation lag.
 * Negatives are never cached. Called by every Phase 2+ authenticated handler.
 */
export async function resolveSession(
  req: Request,
  env: AuthEnv,
  ctx?: ExecutionContext,
): Promise<{ userId: string } | null> {
  const token = bearer(req);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const cache = edgeCache();
  const key = sessionCacheKey(hash);

  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const cached = (await hit.json().catch(() => null)) as { userId?: string } | null;
      if (cached?.userId) return { userId: cached.userId };
    }
  }

  const row = await env.DB.prepare("SELECT user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?")
    .bind(hash)
    .first<{ user_id: string; expires_at: number; revoked_at: number | null }>();
  if (!row) return null;
  if (row.revoked_at != null) return null;
  const now = Date.now();
  if (!(row.expires_at > now)) return null;

  const ttl = Math.min(SESSION_CACHE_MAX_TTL_S, Math.floor((row.expires_at - now) / 1000));
  if (cache && ttl > 0) {
    const stored = new Response(JSON.stringify({ userId: row.user_id }), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` },
    });
    const put = cache.put(key, stored);
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return { userId: row.user_id };
}
