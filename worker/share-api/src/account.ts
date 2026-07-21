// ── Google account linking (Part 1) ──────────────────────────────────────────
// A second, friendlier door to the portable identity: link it to a Google
// account so a new device can pull the same identity by signing in. Deliberately
// NOT zero-knowledge (unlike the recovery-code path) — the operator *could*
// decrypt, stated plainly in the privacy policy. The recovery-code door stays.
//
// The identity bundle for the account path is encrypted client-side under a random
// DEK; the Worker wraps that DEK under HKDF(sub ‖ ACCOUNT_PEPPER) so it is not
// stored in the clear, and unwraps it on resolve for the authenticated device.
//
// Never log `sub`, the token, or a lookup key next to a `friendId`.

export interface AccountEnv {
  BUCKET: R2Bucket;
  GOOGLE_WEB_CLIENT_ID?: string;
  ACCOUNT_PEPPER?: string;
  RATE_LIMIT_PER_HOUR?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const FRIEND_ID_RE = /^[A-Z0-9]{12,40}$/;
const accountKey = (lookupKey: string) => `account/${lookupKey}.json`;
const accountPointerKey = (friendId: string) => `${friendId}/account.json`;

interface AccountRecord {
  ciphertext: string; // identity bundle, AEAD-encrypted client-side under the DEK
  wrappedDek: string; // the DEK, AES-GCM-wrapped under HKDF(sub ‖ pepper)
  friendId: string;
  friendCount: number;
  linkedAt: number;
  updatedAt: number;
}

// ── Minimal R2 json helpers (self-contained, no import from index) ──
async function getJson<T>(env: AccountEnv, key: string): Promise<T | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    return (await obj.json()) as T;
  } catch {
    return null;
  }
}
async function putJson(env: AccountEnv, key: string, value: unknown): Promise<void> {
  await env.BUCKET.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

async function rateLimited(env: AccountEnv, scope: string, ip: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const key = `rl/${scope}/${ip}/${new Date().toISOString().slice(0, 13)}.json`;
  const rec = await getJson<{ n: number }>(env, key);
  const count = rec?.n ?? 0;
  if (count >= limit) return true;
  await putJson(env, key, { n: count + 1 });
  return false;
}

// ── base64 / base64url ──
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64ToBytes(s);
}

// ── Google ID token verification (RS256 vs cached JWKS) ──
interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  n: string;
  e: string;
}
let jwksCache: { keys: Jwk[]; exp: number } | null = null;

async function getGoogleJwks(): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.exp > now) return jwksCache.keys;
  const resp = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!resp.ok) throw new Error("jwks_fetch_failed");
  const body = (await resp.json()) as { keys: Jwk[] };
  const m = (resp.headers.get("cache-control") ?? "").match(/max-age=(\d+)/);
  const ttlMs = m ? Number(m[1]) * 1000 : 3600_000;
  jwksCache = { keys: body.keys, exp: now + ttlMs };
  return body.keys;
}

/**
 * Verify a Google ID token and return its `sub`, or null. Asserts RS256, a known
 * `kid`, `iss ∈ {accounts.google.com, https://accounts.google.com}`, `aud ==
 * GOOGLE_WEB_CLIENT_ID`, a future `exp`, and a present `sub`. Never keys off email.
 */
export async function verifyGoogleIdToken(token: string, env: AccountEnv): Promise<{ sub: string } | null> {
  try {
    if (!env.GOOGLE_WEB_CLIENT_ID) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as { kid?: string; alg?: string };
    if (header.alg !== "RS256" || !header.kid) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as {
      iss?: string;
      aud?: string;
      sub?: string;
      exp?: number;
    };
    if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") return null;
    if (claims.aud !== env.GOOGLE_WEB_CLIENT_ID) return null;
    if (!claims.sub) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;

    const jwk = (await getGoogleJwks()).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as unknown as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return ok ? { sub: claims.sub } : null;
  } catch {
    return null;
  }
}

function bearer(req: Request): string {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

// ── Server-side key derivation (worker-only; the client never computes these) ──
async function hkdf(ikm: Uint8Array, info: string, len = 32): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    base,
    len * 8,
  );
  return new Uint8Array(bits);
}

/** Blind index locating an account record — `HKDF(sub, "flickto-account-lookup")` hex. */
async function accountLookupKey(sub: string): Promise<string> {
  const h = await hkdf(new TextEncoder().encode(sub), "flickto-account-lookup", 32);
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** AES-GCM key that wraps the DEK: `HKDF(sub ‖ ACCOUNT_PEPPER, "flickto-account-wrap")`. */
async function wrapKey(sub: string, pepper: string): Promise<CryptoKey> {
  const raw = await hkdf(new TextEncoder().encode(sub + pepper), "flickto-account-wrap", 32);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToB64(out);
}
async function aesGcmDecrypt(key: CryptoKey, b64: string): Promise<Uint8Array> {
  const all = b64ToBytes(b64);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, key, all.slice(12)));
}

// ── Handlers ──

/**
 * POST /api/account/link — create/overwrite the mapping for the token's `sub`.
 * Body `{ ciphertext, dek, friendId, friendCount }`. If a mapping already exists
 * and `?force=1` is absent, returns 409 + `{ existingFriendId, friendCount }`.
 * With `?force=1`, purges a *different* previous identity via [purgeFriend].
 */
export async function handleAccountLink(
  req: Request,
  env: AccountEnv,
  url: URL,
  purgeFriend: (friendId: string) => Promise<unknown>,
): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  if (await rateLimited(env, "acctlink", ip, Number(env.RATE_LIMIT_PER_HOUR ?? "10"))) {
    return json({ error: "rate_limited" }, 429);
  }
  if (!env.ACCOUNT_PEPPER || !env.GOOGLE_WEB_CLIENT_ID) return json({ error: "not_configured" }, 503);
  const v = await verifyGoogleIdToken(bearer(req), env);
  if (!v) return json({ error: "unauthorized" }, 401);

  let body: { ciphertext?: unknown; dek?: unknown; friendId?: unknown; friendCount?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const ciphertext = typeof body.ciphertext === "string" ? body.ciphertext : "";
  const dek = typeof body.dek === "string" ? body.dek : "";
  const friendId = typeof body.friendId === "string" ? body.friendId : "";
  const friendCount = typeof body.friendCount === "number" ? body.friendCount : 0;
  if (!ciphertext || !dek || !FRIEND_ID_RE.test(friendId)) return json({ error: "invalid_payload" }, 400);

  const lookupKey = await accountLookupKey(v.sub);
  const existing = await getJson<AccountRecord>(env, accountKey(lookupKey));
  if (existing && url.searchParams.get("force") !== "1") {
    return json({ error: "conflict", existingFriendId: existing.friendId, friendCount: existing.friendCount }, 409);
  }
  // Confirmed overwrite onto a different identity → purge the previous one.
  if (existing && existing.friendId !== friendId) await purgeFriend(existing.friendId);

  const wrappedDek = await aesGcmEncrypt(await wrapKey(v.sub, env.ACCOUNT_PEPPER), b64ToBytes(dek));
  const now = Date.now();
  const rec: AccountRecord = {
    ciphertext,
    wrappedDek,
    friendId,
    friendCount,
    linkedAt: existing?.linkedAt ?? now,
    updatedAt: now,
  };
  await putJson(env, accountKey(lookupKey), rec);
  // Reverse pointer under the friendId prefix so data-deletion (keyed by friendId)
  // can drop the account record too — see handleSocialDelete.
  await putJson(env, accountPointerKey(friendId), { lk: lookupKey });
  return json({ ok: true, friendId });
}

/**
 * GET /api/account/resolve — the new-device restore path. Returns
 * `{ friendId, ciphertext, dek }` (the DEK unwrapped server-side) for the
 * authenticated account, or 404 when nothing is linked.
 */
export async function handleAccountResolve(req: Request, env: AccountEnv): Promise<Response> {
  if (!env.ACCOUNT_PEPPER || !env.GOOGLE_WEB_CLIENT_ID) return json({ error: "not_configured" }, 503);
  const v = await verifyGoogleIdToken(bearer(req), env);
  if (!v) return json({ error: "unauthorized" }, 401);
  const rec = await getJson<AccountRecord>(env, accountKey(await accountLookupKey(v.sub)));
  if (!rec) return json({ error: "not_found" }, 404);
  let dek: string;
  try {
    dek = bytesToB64(await aesGcmDecrypt(await wrapKey(v.sub, env.ACCOUNT_PEPPER), rec.wrappedDek));
  } catch {
    return json({ error: "unwrap_failed" }, 500);
  }
  return json({ friendId: rec.friendId, ciphertext: rec.ciphertext, dek });
}

/**
 * POST /api/account/unlink — remove the mapping only. NEVER deletes the identity,
 * its relay data, or the recovery-code backup.
 */
export async function handleAccountUnlink(req: Request, env: AccountEnv): Promise<Response> {
  if (!env.GOOGLE_WEB_CLIENT_ID) return json({ error: "not_configured" }, 503);
  const v = await verifyGoogleIdToken(bearer(req), env);
  if (!v) return json({ error: "unauthorized" }, 401);
  const lookupKey = await accountLookupKey(v.sub);
  const rec = await getJson<AccountRecord>(env, accountKey(lookupKey));
  await env.BUCKET.delete(accountKey(lookupKey));
  if (rec) await env.BUCKET.delete(accountPointerKey(rec.friendId));
  return json({ ok: true });
}

/**
 * Drop the account record for a friendId during data-deletion. Reads the reverse
 * pointer `{friendId}/account.json` (which the friendId-prefix purge also removes)
 * and deletes the out-of-prefix `account/{lookupKey}.json`. Best-effort.
 */
export async function deleteAccountForFriend(env: AccountEnv, friendId: string): Promise<void> {
  const ptr = await getJson<{ lk?: string }>(env, accountPointerKey(friendId));
  if (ptr?.lk) await env.BUCKET.delete(accountKey(ptr.lk));
}
