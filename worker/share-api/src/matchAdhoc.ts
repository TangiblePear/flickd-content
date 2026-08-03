// ── Account-free Friend Match, by QR, in person ──────────────────────────────
//
// Friend Match otherwise requires an account on both sides: `pairWithCard` refuses a card
// with no `serverUserId`, and publishing your own code is session-authed. That is correct
// for a *remote* match — there is no way to address someone who has no account — but it
// also blocked the case the feature is best at: two people in the same room, one scanning
// the other's screen.
//
// This is a rendezvous, and nothing more. It carries one ephemeral, one-shot,
// self-deleting exchange of two sealed taste profiles. It establishes no identity, no
// friendship and no addressable inbox, and it is deliberately NOT a revival of the retired
// E2EE relay — that carried friendships, feeds and pairings, and its absence is why the
// account-only path exists at all.
//
// ## Why a server is involved when both phones are in the same room
//
// `WATCHED_SHARE_LIMIT` is 5000 tmdbIds, so a sealed `PartnerProfile` is ~15 KB. A QR code
// tops out near 2.9 KB of binary. The QR can carry a public keyset (a few hundred bytes);
// it can never carry the profile. So the phones need somewhere to put ciphertext for each
// other, and this is the smallest thing that can be.
//
// ## The privacy property is unchanged from the account path
//
// Both halves are `SocialCrypto.seal`ed to exactly one recipient's public keyset. The
// server stores and deletes ciphertext it can never read. A taste vector is the most
// revealing thing in the app; do not "simplify" that away.
//
// ## ⚠️ An ad-hoc match cannot be blocked, by construction
//
// `sendScanMatchRequest` refuses a target in `friends.isBlockedByUserId`. An ad-hoc peer
// has no stable id to check, so that guard cannot exist here. The exposure is a taste
// vector, one-off, to someone standing in front of you whose code you chose to scan —
// acceptable, but it is a stated decision rather than an oversight, and it belongs in the
// privacy policy.

export interface MatchAdhocEnv {
  BUCKET: R2Bucket;
  /** Ad-hoc rendezvous tokens per IP per hour. Unset ⇒ [DEFAULT_TOKENS_PER_HOUR]. */
  ADHOC_MATCH_PER_HOUR?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, X-App-Version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const notFound = () => json({ error: "not_found" }, 404);

/** Crockford-ish base32, no vowels — the token is never typed, but it is logged. */
const TOKEN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_LENGTH = 26;
const TOKEN_RE = new RegExp(`^[${TOKEN_ALPHABET}]{${TOKEN_LENGTH}}$`);

/** A sealed PartnerProfile is ~15 KB; the cap is against abuse, not the real payload. */
const MAX_HALF_BYTES = 128 * 1024;
const MAX_KEYSET_BYTES = 4 * 1024;

/** How long a rendezvous stays open. Long enough to scan and score, short enough to forget. */
export const TTL_MS = 15 * 60 * 1000;

const DEFAULT_TOKENS_PER_HOUR = 30;

const prefix = (token: string) => `match-adhoc/${token}`;
const metaKey = (token: string) => `${prefix(token)}/meta.json`;
const halfKey = (token: string, side: "a" | "b") => `${prefix(token)}/${side}.json`;

interface AdhocMeta {
  /** The initiator's public keyset — what the scanner seals its half to. */
  publicKeyset: string;
  createdAt: number;
  expiresAt: number;
  /**
   * Which halves have been COLLECTED.
   *
   * ⚠️ Tracked explicitly because a deleted half and a never-written half are the same
   * absence. An earlier version destroyed the rendezvous whenever the other half was
   * missing at read time, which killed it mid-exchange: the scanner uploads first, the
   * initiator reads that half, and at that instant its own half does not exist yet.
   * Caught by `round-trips both halves`.
   */
  collected?: string[];
}

interface AdhocHalf {
  sealed: string;
  /** The uploader's public keyset, so the other side can seal its reply. */
  publicKeyset: string;
  createdAt: number;
}

/**
 * A server-minted token.
 *
 * ⚠️ Server-minted is the one thing that separates this from `PUT /api/social/backup`,
 * whose lookup key is CLIENT-chosen and which is therefore a write-anything primitive. A
 * `PUT` here is accepted only for a token this Worker issued and has not yet expired, so
 * the namespace cannot be sprayed.
 */
function mintToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}

async function readMeta(env: MatchAdhocEnv, token: string): Promise<AdhocMeta | null> {
  const obj = await env.BUCKET.get(metaKey(token));
  if (!obj) return null;
  const meta = (await obj.json().catch(() => null)) as AdhocMeta | null;
  if (!meta) return null;
  // ⚠️ Expiry is enforced HERE, in the handler, not left to a bucket lifecycle rule.
  // A lifecycle rule is eventually-consistent and unverifiable from the code; an expired
  // rendezvous must be unreadable the instant it expires, whether or not anything has
  // swept it. The sweep is a cleanup, never the guarantee.
  if (Date.now() > meta.expiresAt) {
    await destroy(env, token);
    return null;
  }
  return meta;
}

async function destroy(env: MatchAdhocEnv, token: string): Promise<void> {
  await Promise.all([
    env.BUCKET.delete(metaKey(token)),
    env.BUCKET.delete(halfKey(token, "a")),
    env.BUCKET.delete(halfKey(token, "b")),
  ]);
}

async function rateLimited(env: MatchAdhocEnv, ip: string): Promise<boolean> {
  const limit = Number(env.ADHOC_MATCH_PER_HOUR ?? String(DEFAULT_TOKENS_PER_HOUR));
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const key = `rl/adhoc-match/${ip}/${new Date().toISOString().slice(0, 13)}.json`;
  const obj = await env.BUCKET.get(key);
  const rec = obj ? ((await obj.json().catch(() => null)) as { n?: number } | null) : null;
  const count = rec?.n ?? 0;
  if (count >= limit) return true;
  await env.BUCKET.put(key, JSON.stringify({ n: count + 1 }), {
    httpMetadata: { contentType: "application/json" },
  });
  return false;
}

/**
 * `POST /api/match/adhoc` — open a rendezvous.
 *
 * Unauthenticated by necessity: the whole point is that neither side needs an account.
 * Body: `{ publicKeyset }`. Returns `{ token, expiresAt }` for the QR.
 */
export async function handleAdhocCreate(req: Request, env: MatchAdhocEnv): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  if (await rateLimited(env, ip)) return json({ error: "rate_limited" }, 429);

  let body: { publicKeyset?: unknown };
  try {
    body = (await req.json()) as { publicKeyset?: unknown };
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const publicKeyset = typeof body.publicKeyset === "string" ? body.publicKeyset : "";
  if (!publicKeyset || publicKeyset.length > MAX_KEYSET_BYTES) {
    return json({ error: "invalid_keyset" }, 400);
  }

  const token = mintToken();
  const now = Date.now();
  const meta: AdhocMeta = { publicKeyset, createdAt: now, expiresAt: now + TTL_MS };
  await env.BUCKET.put(metaKey(token), JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
  });
  return json({ token, expiresAt: meta.expiresAt });
}

/**
 * `GET /api/match/adhoc/{token}` — the initiator's public keyset, so a scanner that only
 * read a short token from the QR can still seal to it.
 */
export async function handleAdhocMeta(token: string, env: MatchAdhocEnv): Promise<Response> {
  if (!TOKEN_RE.test(token)) return notFound();
  const meta = await readMeta(env, token);
  if (!meta) return notFound();
  return json({ publicKeyset: meta.publicKeyset, expiresAt: meta.expiresAt });
}

/**
 * `PUT /api/match/adhoc/{token}/{a|b}` — deposit one sealed half.
 *
 * Side `b` is the SCANNER and uploads first. That preserves the exposure asymmetry the
 * account path already has ("the requester's sealed half rides the request; the target's
 * is uploaded only on accept"): the party who has demonstrated physical presence by
 * scanning exposes their taste vector first, and the other only ever responds.
 *
 * A half may be written once. Overwriting would let a third party who guessed a live token
 * replace a half after it was read.
 */
export async function handleAdhocPut(
  token: string,
  side: string,
  req: Request,
  env: MatchAdhocEnv,
): Promise<Response> {
  if (!TOKEN_RE.test(token)) return notFound();
  if (side !== "a" && side !== "b") return notFound();
  // Refuses any token this Worker did not issue, or one that has expired.
  const meta = await readMeta(env, token);
  if (!meta) return notFound();

  const raw = await req.text();
  if (raw.length > MAX_HALF_BYTES) return json({ error: "too_large" }, 413);
  let parsed: { sealed?: unknown; publicKeyset?: unknown };
  try {
    parsed = JSON.parse(raw) as { sealed?: unknown; publicKeyset?: unknown };
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const sealed = typeof parsed.sealed === "string" ? parsed.sealed : "";
  const publicKeyset = typeof parsed.publicKeyset === "string" ? parsed.publicKeyset : "";
  if (!sealed || !publicKeyset || publicKeyset.length > MAX_KEYSET_BYTES) {
    return json({ error: "invalid_payload" }, 400);
  }

  const key = halfKey(token, side);
  if (await env.BUCKET.head(key)) return json({ error: "already_written" }, 409);

  const half: AdhocHalf = { sealed, publicKeyset, createdAt: Date.now() };
  await env.BUCKET.put(key, JSON.stringify(half), {
    httpMetadata: { contentType: "application/json" },
  });
  return json({ ok: true });
}

/**
 * `GET /api/match/adhoc/{token}/{a|b}` — collect the other side's half, ONE SHOT.
 *
 * The half is deleted as it is served, and once BOTH halves are gone so is the whole
 * rendezvous. Ciphertext nobody is coming back for is exactly what should not sit in a
 * bucket, and a one-shot read means a leaked token is worth nothing after the exchange.
 */
export async function handleAdhocGet(
  token: string,
  side: string,
  env: MatchAdhocEnv,
): Promise<Response> {
  if (!TOKEN_RE.test(token)) return notFound();
  if (side !== "a" && side !== "b") return notFound();
  const meta = await readMeta(env, token);
  if (!meta) return notFound();

  const key = halfKey(token, side);
  const obj = await env.BUCKET.get(key);
  if (!obj) return notFound();
  const half = (await obj.json().catch(() => null)) as AdhocHalf | null;
  if (!half) return notFound();

  await env.BUCKET.delete(key);

  // Both halves collected ⇒ the exchange is over and nothing here is worth keeping.
  // Recorded in meta rather than inferred from the bucket, because a collected half and
  // an unwritten one are indistinguishable by absence — see AdhocMeta.collected.
  const collected = new Set(meta.collected ?? []);
  collected.add(side);
  if (collected.has("a") && collected.has("b")) {
    await destroy(env, token);
  } else {
    await env.BUCKET.put(
      metaKey(token),
      JSON.stringify({ ...meta, collected: [...collected] } satisfies AdhocMeta),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  return json({ sealed: half.sealed, publicKeyset: half.publicKeyset });
}
