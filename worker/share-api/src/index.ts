interface Env {
  BUCKET: R2Bucket;
  // Profile-picture bytes + moderation reports/tombstones (server-visible, not
  // E2EE) so the flickto-web admin panel can bind the same bucket for review.
  PICS: R2Bucket;
  SHARE_TTL_SECONDS: string;
  MAX_ITEMS: string;
  RATE_LIMIT_PER_HOUR: string;
  FCM_PROJECT_ID: string;
  FCM_SERVICE_ACCOUNT_EMAIL: string;
  FCM_PRIVATE_KEY: string;
  // Image moderation. When MODERATION_ENABLED !== "true" or the key is absent,
  // uploads skip the paid scan (dev mode) and are accepted.
  MODERATION_ENABLED?: string;
  VISION_API_KEY?: string;
  // Distinct-reporter threshold that auto-hides a picture pending admin review.
  REPORT_AUTOHIDE?: string;
  // Orphan-profile reaper: delete a friendId folder untouched for this long.
  PROFILE_TTL_SECONDS?: string;
  // Max folders the reaper purges per run (keeps each run bounded).
  GC_MAX_PREFIXES_PER_RUN?: string;
  // Opportunistic trigger cadence (no cron budget): run at most once per this.
  REAP_INTERVAL_SECONDS?: string;
  // Per-isolate throttle so we don't read the gate object on every request.
  REAP_GATE_THROTTLE_SECONDS?: string;
}

import { sendFcmMessage, pickFcmTarget, FcmConfig } from "./fcm";
import { moderateImage } from "./moderation";
import { reapOrphanProfiles, dueForReap } from "./reaper";

interface ShareItem {
  tmdbId: number;
  type: string;
}

interface SharePayload {
  // "manual" carries an item snapshot; "smart" carries a filter blob the
  // recipient's app rebuilds into a dynamic smart list. Defaults to "manual"
  // so anything stored before this field existed still reads correctly.
  kind?: string;
  title: string;
  items?: ShareItem[];
  filters?: unknown;
}

interface StoredShare {
  kind: string;
  title: string;
  items: ShareItem[];
  filters: unknown | null;
  createdAt: string;
  expiresAt: string;
  views: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Feed-Secret, X-Read-Token",
};

// ── Limits (the relay stores ciphertext only; these just cap abuse) ──
const MAX_BLOB_BYTES = 256 * 1024; // a profile / opinion ciphertext object
const MAX_ACCESS_BYTES = 512 * 1024; // wrapped-keys bundle (grows with friend count)
const MAX_INBOX_ITEM_BYTES = 64 * 1024;
const MAX_INBOX_ITEMS = 200;
const MAX_BATCH_ITEMS = 200; // friends queried per opinion-batch call
const MAX_CARD_BYTES = 8 * 1024;
const MAX_FILTERS_BYTES = 4096;
const MAX_BACKUP_BYTES = 64 * 1024; // zero-knowledge identity bundle ciphertext
const MAX_SELF_BYTES = 512 * 1024; // live friends+block record ciphertext (grows with friend count)

const FRIENDCODE_TTL = 60 * 60 * 24 * 90; // 90 days
const FRIEND_ID = "[A-Z0-9]{12,40}";
const FRIEND_CODE = "[A-Z0-9]{6,12}";
const HASH = "[a-f0-9]{32,160}"; // hex blind index (HMAC-SHA256 + Tink prefix)
const LOOKUP_KEY = "[A-Za-z0-9_-]{22,128}"; // HKDF/HMAC blind index (hex or base64url)

const APP_PACKAGE = "com.flickto.app";
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.flickto.app";
const APP_STORE_URL = "https://apps.apple.com/app/id0000000000";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...CORS, ...(init.headers ?? {}) },
  });

const rawJson = (raw: string) =>
  new Response(raw, { headers: { "Content-Type": "application/json", ...CORS } });

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    ...init,
    headers: { "Content-Type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });

const forbidden = () => json({ error: "forbidden" }, { status: 403 });
const notFound = () => json({ error: "not_found" }, { status: 404 });
const tooLarge = () => json({ error: "too_large" }, { status: 413 });
const invalidJson = () => json({ error: "invalid_json" }, { status: 400 });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Opportunistic orphan-profile reaper: no cron budget on this account, so we
    // let ambient request traffic tick the clock. Fire-and-forget — never blocks
    // the response, self-throttles, and runs the reap at most once per interval.
    ctx.waitUntil(maybeReap(env));

    const url = new URL(req.url);
    const p = url.pathname;

    // ── Share links (legacy feature, now R2-backed) ──
    if (p === "/api/share" && req.method === "POST") return handleCreate(req, env);

    const apiShare = p.match(/^\/api\/share\/([A-Z0-9]{6,12})$/);
    if (apiShare && req.method === "GET") return handleGet(apiShare[1], env);

    const landing = p.match(/^\/share\/([A-Z0-9]{6,12})$/);
    if (landing && req.method === "GET") return handleLanding(landing[1], env);

    // ── Opinion batch (blind-indexed, on-demand reads) ──
    if (p === "/api/opinions/batch" && req.method === "POST") {
      return handleOpinionsBatch(req, env);
    }

    // ── User-scoped objects: access keys, profile, per-title opinions, push ──
    // `push` (was `fcm-token`) carries the owner's topic names for O(1) fan-out;
    // both are accepted during rollout and neither is client-readable (GET refused).
    const userObj = p.match(new RegExp(`^/api/user/(${FRIEND_ID})/(access|profile|fcm-token|push)$`));
    if (userObj) {
      const [, friendId, kind] = userObj;
      if (req.method === "PUT") return handlePutUserObject(friendId, kind, req, env, ctx);
      if (req.method === "GET" && kind !== "fcm-token" && kind !== "push") return handleGetUserObject(friendId, kind, req, env);
    }

    const userOpinion = p.match(new RegExp(`^/api/user/(${FRIEND_ID})/opinions/(${HASH})$`));
    if (userOpinion) {
      const [, friendId, hash] = userOpinion;
      if (req.method === "PUT") return handlePutOpinion(friendId, hash, req, env);
      if (req.method === "DELETE") return handleDeleteOpinion(friendId, hash, req, env);
    }

    // ── Profile picture (server-visible, moderated) ──
    const userPicture = p.match(new RegExp(`^/api/user/(${FRIEND_ID})/picture$`));
    if (userPicture) {
      const [, friendId] = userPicture;
      if (req.method === "PUT") return handlePutPicture(friendId, req, env, ctx);
      if (req.method === "GET") return handleGetPicture(friendId, env);
      if (req.method === "DELETE") return handleDeletePicture(friendId, req, env);
    }

    // ── Report ingestion (user / feed-comment / picture) → admin inbox ──
    const userReport = p.match(new RegExp(`^/api/user/(${FRIEND_ID})/report$`));
    if (userReport && req.method === "POST") return handleReport(userReport[1], req, env);

    // ── Inbox (sealed handshake / share messages) ──
    const inbox = p.match(new RegExp(`^/api/inbox/(${FRIEND_ID})$`));
    if (inbox) {
      if (req.method === "POST") return handlePostInbox(inbox[1], req, env);
      if (req.method === "GET") return handleGetInbox(inbox[1], req, env);
      if (req.method === "DELETE") return handleDeleteInbox(inbox[1], req, env, url);
    }

    // ── Freshness Check (Batch) ──
    if (p === "/api/social/freshness" && req.method === "POST") {
      return handleFreshness(req, env);
    }

    // ── Friend code → public friend card ──
    if (p === "/api/friendcode" && req.method === "POST") {
      return handlePublishFriendCode(req, env);
    }
    const friendCode = p.match(new RegExp(`^/api/friendcode/(${FRIEND_CODE})$`));
    if (friendCode && req.method === "GET") return handleGetFriendCode(friendCode[1], env);

    // Legal pages (/privacy, /delete) are now static HTML served by the
    // flickto-content worker — no route handlers needed here.

    // ── Portable identity backup (zero-knowledge ciphertext) ──
    if (p === "/api/social/backup" && req.method === "PUT") return handlePutBackup(req, env);
    const backupObj = p.match(new RegExp(`^/api/social/backup/(${LOOKUP_KEY})$`));
    if (backupObj) {
      if (req.method === "GET") return handleGetBackup(backupObj[1], env);
      if (req.method === "DELETE") return handleDeleteBackup(backupObj[1], env);
    }

    // ── Live friends+block record (optimistic concurrency) ──
    const selfObj = p.match(new RegExp(`^/api/social/self/(${LOOKUP_KEY})$`));
    if (selfObj) {
      if (req.method === "GET") return handleGetSelf(selfObj[1], env);
      if (req.method === "PUT") return handlePutSelf(selfObj[1], req, env);
      if (req.method === "DELETE") return handleDeleteSelf(selfObj[1], env);
    }

    // ── Account / data deletion (Google Play deletion policy) ──
    if (p === "/api/social/delete" && req.method === "POST") return handleSocialDelete(req, env);
    if (p === "/api/social/delete-request" && req.method === "POST") return handleDeleteRequest(req, env);

    return notFound();
  },
};

// ── Opportunistic orphan-profile reaper ──────────────────────────────────────
// This account is at its 5-cron limit, so instead of a scheduled() cron the
// reaper piggybacks on ambient request traffic: any request past the interval
// fires one bounded reap in the background. A wiped/uninstalled device stops
// re-publishing (a live install re-PUTs fcm-token every ≤3 days), so its data
// ages out; recovery blobs (backup/, self/) are excluded by prefix shape.

interface GcState {
  cursor?: string;
  lastRunAt?: number;
}
const GC_CURSOR_KEY = "_gc/cursor.json";

// Best-effort per-isolate throttle so we hit R2 for the gate object at most once
// per window regardless of request volume (ephemeral; a recycled isolate just
// re-reads sooner — correctness rides on the persisted lastRunAt, not this).
let lastGateCheckMs = 0;

async function maybeReap(env: Env): Promise<void> {
  try {
    const now = Date.now();
    const throttleMs = Number(env.REAP_GATE_THROTTLE_SECONDS ?? "600") * 1000;
    if (now - lastGateCheckMs < throttleMs) return;
    lastGateCheckMs = now;

    const state = (await getJson<GcState>(env, GC_CURSOR_KEY)) ?? {};
    const intervalMs = Number(env.REAP_INTERVAL_SECONDS ?? "86400") * 1000; // default 24h
    if (!dueForReap(state.lastRunAt, now, intervalMs)) return;

    // Claim the run first so concurrent requests don't double-fire.
    await putJson(env, GC_CURSOR_KEY, { cursor: state.cursor, lastRunAt: now });
    await runReaper(env, state.cursor, now);
  } catch (e) {
    console.error("reaper: maybeReap failed", e);
  }
}

async function runReaper(env: Env, cursor: string | undefined, claimedAt: number): Promise<void> {
  const ttlMs = Number(env.PROFILE_TTL_SECONDS ?? "31536000") * 1000; // default 365d
  const cap = Number(env.GC_MAX_PREFIXES_PER_RUN ?? "500");
  const result = await reapOrphanProfiles(
    env.BUCKET,
    (friendId) => purgeFriendScoped(env, friendId),
    { nowMs: Date.now(), ttlMs, cap, cursor },
  );
  // Preserve the claim timestamp; advance the cursor for the next run.
  await putJson(env, GC_CURSOR_KEY, { cursor: result.nextCursor, lastRunAt: claimedAt });
  console.log(`reaper: purged ${result.reaped.length} orphan profile(s)`);
}

// ── R2 helpers ─────────────────────────────────────────────────────────────

async function getText(env: Env, key: string): Promise<string | null> {
  const obj = await env.BUCKET.get(key);
  return obj ? await obj.text() : null;
}

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    return (await obj.json()) as T;
  } catch {
    return null;
  }
}

async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function putRaw(env: Env, key: string, body: string): Promise<void> {
  await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/json" },
  });
}

// Lightweight per-IP hourly rate limit backed by R2 (one tiny object per
// ip+hour bucket; `rl/` should carry a 1-day lifecycle rule to self-clean).
async function rateLimited(env: Env, scope: string, ip: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const key = `rl/${scope}/${ip}/${currentHour()}.json`;
  const rec = await getJson<{ n: number }>(env, key);
  const count = rec?.n ?? 0;
  if (count >= limit) return true;
  await putJson(env, key, { n: count + 1 });
  return false;
}

function currentHour(): string {
  return new Date().toISOString().slice(0, 13);
}

// ── Auth: trust-on-first-use owner binding + read token ──────────────────────

/**
 * Owner binding for a friendId. `h` = sha256(writeSecret).
 * Read tokens are split (0a-3) so un-friending can revoke without a bootstrap
 * deadlock: `ta` is stable and gates `access.json` only; `tc` is rotatable and
 * gates `profile.json` + `opinions/*`. `t` is the legacy single token (pre-0a-3),
 * read as both when `ta`/`tc` are absent.
 */
interface OwnerRecord {
  h: string;
  t?: string;
  ta?: string;
  tc?: string;
}

/** Effective stable (access) read token, honouring the legacy single token. */
const effTa = (rec: OwnerRecord): string | undefined => rec.ta ?? rec.t;
/** Effective rotatable (profile/opinions) read token, honouring the legacy single token. */
const effTc = (rec: OwnerRecord): string | undefined => rec.tc ?? rec.t;

const ownerKey = (friendId: string) => `${friendId}/owner.json`;

/**
 * Owner-auth result. `created` is true when this call had to freshly create
 * `owner.json` (trust-on-first-use) — the signal that the relay had lost this
 * identity's data (e.g. reaped after inactivity), so the client should re-publish.
 */
interface OwnerAuth {
  ok: boolean;
  created: boolean;
}

/** Owner-authenticate a write. Binds the secret on first use; verifies after. */
async function verifyOwner(env: Env, friendId: string, secret: string | null): Promise<OwnerAuth> {
  if (!secret) return { ok: false, created: false };
  const hash = await sha256hex(secret);
  const existing = await getJson<OwnerRecord>(env, ownerKey(friendId));
  if (!existing) {
    await putJson(env, ownerKey(friendId), { h: hash });
    return { ok: true, created: true };
  }
  return { ok: existing.h === hash, created: false };
}

/**
 * Owner-authenticate AND (re)bind the read tokens friends present to read.
 * `ta` gates access.json (stable); `tc` gates profile/opinions (rotatable). Each
 * absent value preserves what was bound before, so a write that carries only one
 * token never clears the other. Rotation is just a write that supplies a new `tc`.
 */
async function verifyOwnerBindToken(
  env: Env,
  friendId: string,
  secret: string | null,
  ta: string | null,
  tc: string | null,
): Promise<OwnerAuth> {
  if (!secret) return { ok: false, created: false };
  const hash = await sha256hex(secret);
  const existing = await getJson<OwnerRecord>(env, ownerKey(friendId));
  if (existing && existing.h !== hash) return { ok: false, created: false };
  const next: OwnerRecord = {
    h: hash,
    ta: ta ?? (existing ? effTa(existing) : undefined),
    tc: tc ?? (existing ? effTc(existing) : undefined),
  };
  if (!existing || existing.h !== next.h || existing.ta !== next.ta || existing.tc !== next.tc) {
    await putJson(env, ownerKey(friendId), next);
  }
  return { ok: true, created: !existing };
}

/**
 * Read-gate: the presented token must match the author's bound read token for the
 * given slot — `"a"` for access.json (stable `ta`), `"c"` for profile/opinions
 * (rotatable `tc`). A rotated `tc` therefore 403s a stale reader immediately.
 */
async function verifyReadToken(
  env: Env,
  friendId: string,
  token: string | null,
  which: "a" | "c",
): Promise<boolean> {
  if (!token) return false;
  const rec = await getJson<OwnerRecord>(env, ownerKey(friendId));
  if (!rec) return false;
  const bound = which === "a" ? effTa(rec) : effTc(rec);
  return !!bound && bound === token;
}

// ── Social handlers ──────────────────────────────────────────────────────────

// PUT access.json / profile.json — owner-auth + bind read token. Body is opaque.
async function handlePutUserObject(
  friendId: string,
  kind: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // X-Read-Token = stable `ta` (access); X-Read-Token-C = rotatable `tc`
  // (profile/opinions). Each write rebinds whichever it carries; rotation is just a
  // write with a new tc. Access writes rate-limited so churn can't hammer the relay.
  const ta = req.headers.get("X-Read-Token");
  const tc = req.headers.get("X-Read-Token-C");
  if (kind === "access") {
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    if (await rateLimited(env, "access", ip, Number(env.RATE_LIMIT_PER_HOUR ?? "10") * 6)) {
      return json({ error: "rate_limited" }, { status: 429 });
    }
  }
  const owner = await verifyOwnerBindToken(env, friendId, req.headers.get("X-Feed-Secret"), ta, tc);
  if (!owner.ok) return forbidden();
  const body = await req.text();
  let cap = MAX_BLOB_BYTES;
  if (kind === "access") cap = MAX_ACCESS_BYTES;
  if (kind === "fcm-token" || kind === "push") cap = 2048;
  if (body.length > cap) return tooLarge();
  try {
    JSON.parse(body);
  } catch {
    return invalidJson();
  }
  if (kind === "profile") {
    // Stash the rotatable read token (tc) on the object so freshness can authorize
    // with a single get() (0a-2). Profile is re-PUT on rotation, so this stays
    // current — unlike opinions, whose batch endpoint checks owner.json.tc directly.
    await env.BUCKET.put(`${friendId}/${kind}.json`, body, {
      httpMetadata: { contentType: "application/json" },
      ...(tc ? { customMetadata: { rt: tc } } : {}),
    });
    ctx.waitUntil(fanOutProfileUpdate(friendId, env));
  } else {
    await putRaw(env, `${friendId}/${kind}.json`, body);
  }

  return json({ ok: true, ownerRecreated: owner.created });
}

interface PushRecord {
  selfTopic?: string;
  friendTopic?: string;
  token?: string;
}

/** Read an owner's push record, preferring `push.json` over the legacy `fcm-token.json`. */
async function readPushRecord(env: Env, friendId: string): Promise<PushRecord | null> {
  const raw = (await getText(env, `${friendId}/push.json`)) ?? (await getText(env, `${friendId}/fcm-token.json`));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PushRecord;
  } catch {
    return null;
  }
}

function fcmConfig(env: Env): FcmConfig | null {
  if (!env.FCM_PROJECT_ID || !env.FCM_SERVICE_ACCOUNT_EMAIL || !env.FCM_PRIVATE_KEY) return null;
  return {
    projectId: env.FCM_PROJECT_ID,
    clientEmail: env.FCM_SERVICE_ACCOUNT_EMAIL,
    privateKey: env.FCM_PRIVATE_KEY,
  };
}

// Ambient profile fan-out. With push topics this is O(1): publish one message to
// the owner's friend-topic and Google delivers it to every subscribed friend on
// every device. Only a pre-topics owner (no `friendTopic` yet) falls back to the
// legacy per-friend token loop, which self-resolves once the owner republishes
// `push.json` within the client's ~3-day heartbeat.
async function fanOutProfileUpdate(myId: string, env: Env) {
  const config = fcmConfig(env);
  if (!config) return;
  try {
    const mine = await readPushRecord(env, myId);
    if (mine && typeof mine.friendTopic === "string" && mine.friendTopic) {
      const target = pickFcmTarget(mine, "friend");
      if (target && "topic" in target) {
        await sendFcmMessage(config, target, myId, "social_update");
        return;
      }
    }
    // Legacy fallback: owner not yet on topics — notify each friend's device token.
    const accessStr = await getText(env, `${myId}/access.json`);
    if (!accessStr) return;
    const access = JSON.parse(accessStr) as { keys?: Record<string, unknown> };
    if (!access.keys) return;
    for (const friendId of Object.keys(access.keys)) {
      const rec = await readPushRecord(env, friendId);
      if (rec && typeof rec.token === "string" && rec.token) {
        await sendFcmMessage(config, { token: rec.token }, myId, "social_update");
      }
    }
  } catch (e) {
    console.error("Failed to fan out profile update", e);
  }
}

// GET access.json / profile.json — read-token-gated; returns stored ciphertext.
async function handleGetUserObject(
  friendId: string,
  kind: string,
  req: Request,
  env: Env,
): Promise<Response> {
  // access.json is gated by the stable `ta`; profile.json by the rotatable `tc`.
  const which = kind === "access" ? "a" : "c";
  if (!(await verifyReadToken(env, friendId, req.headers.get("X-Read-Token"), which))) return forbidden();
  const raw = await getText(env, `${friendId}/${kind}.json`);
  return raw ? rawJson(raw) : notFound();
}

// PUT one encrypted opinion, located by its blind index hash. Owner-auth.
async function handlePutOpinion(friendId: string, hash: string, req: Request, env: Env): Promise<Response> {
  const auth = await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"));
  if (!auth.ok) return forbidden();
  const body = await req.text();
  if (body.length > MAX_BLOB_BYTES) return tooLarge();
  try {
    JSON.parse(body);
  } catch {
    return invalidJson();
  }
  // Stash the read token so the batch endpoint can authorize with one get() (0a-2).
  const readToken = req.headers.get("X-Read-Token");
  await env.BUCKET.put(`${friendId}/opinions/${hash}.json`, body, {
    httpMetadata: { contentType: "application/json" },
    ...(readToken ? { customMetadata: { rt: readToken } } : {}),
  });
  return json({ ok: true, ownerRecreated: auth.created });
}

// DELETE one opinion (true removal on tombstone). Owner-auth.
async function handleDeleteOpinion(friendId: string, hash: string, req: Request, env: Env): Promise<Response> {
  const auth = await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"));
  if (!auth.ok) return forbidden();
  await env.BUCKET.delete(`${friendId}/opinions/${hash}.json`);
  return json({ ok: true, ownerRecreated: auth.created });
}

// ── Profile pictures + reports ──────────────────────────────────────────────
// All picture-domain objects live in the PICS bucket (server-visible, not E2EE)
// so the flickto-web admin panel can bind the same bucket for review/takedown:
//   pics/{friendId}/picture.jpg           — the image bytes
//   pics/{friendId}/meta.json             — { version, contentType, sha256, verdict }
//   _moderation/{friendId}.json           — takedown tombstone (auto or admin)
//   _reports/{targetId}/{ts}-{reporter}.json — one report record
const MAX_PICTURE_BYTES = 512 * 1024;
const picKey = (friendId: string) => `pics/${friendId}/picture.jpg`;
const picMetaKey = (friendId: string) => `pics/${friendId}/meta.json`;
const tombstoneKey = (friendId: string) => `_moderation/${friendId}.json`;
const REPORT_KINDS = new Set(["user", "feed_comment", "picture"]);

interface PictureMeta {
  version: number;
  contentType: string;
  sha256: string;
  verdict: string;
  updatedAt: number;
}

/** Sniff the leading bytes for a supported raster type. Returns a MIME or null. */
function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) return "image/webp";
  return null;
}

// PUT the owner's profile picture. Owner-auth (same secret + read token that
// gates profile.json). Scans the bytes before storing; a flagged image is never
// persisted or shared. A fresh upload clears any prior takedown tombstone.
async function handlePutPicture(
  friendId: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const owner = await verifyOwnerBindToken(env, friendId, req.headers.get("X-Feed-Secret"), req.headers.get("X-Read-Token"), req.headers.get("X-Read-Token-C"));
  if (!owner.ok) return forbidden();
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength === 0) return invalidJson();
  if (buf.byteLength > MAX_PICTURE_BYTES) return tooLarge();

  const contentType = sniffImageType(buf);
  if (!contentType) return json({ error: "unsupported_type" }, { status: 400 });

  const result = await moderateImage(buf, env);
  if (!result.allowed) {
    return json({ error: "rejected", categories: result.categories }, { status: 422 });
  }

  const version = Date.now();
  await env.PICS.put(picKey(friendId), buf, { httpMetadata: { contentType } });
  const meta: PictureMeta = {
    version,
    contentType,
    sha256: await sha256hexBytes(buf),
    verdict: result.verdict,
    updatedAt: version,
  };
  await env.PICS.put(picMetaKey(friendId), JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
  });
  // A new image supersedes any earlier auto/admin takedown.
  await env.PICS.delete(tombstoneKey(friendId));

  // Reuse the profile fan-out so friends refresh and pull the new pictureUrl.
  ctx.waitUntil(fanOutProfileUpdate(friendId, env));

  const url = `https://flickto.app/api/user/${friendId}/picture?v=${version}`;
  return json({ ok: true, url, version, ownerRecreated: owner.created });
}

// GET a profile picture. Public — the opaque friendId is the capability, so Coil
// loads it with no custom headers. A takedown tombstone yields 410.
async function handleGetPicture(friendId: string, env: Env): Promise<Response> {
  const tomb = await env.PICS.get(tombstoneKey(friendId));
  if (tomb) return new Response("gone", { status: 410, headers: { ...CORS } });
  const obj = await env.PICS.get(picKey(friendId));
  if (!obj) return new Response("not found", { status: 404, headers: { ...CORS } });
  const contentType = obj.httpMetadata?.contentType ?? "image/jpeg";
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ...CORS,
    },
  });
}

// DELETE the owner's own picture. Owner-auth.
async function handleDeletePicture(friendId: string, req: Request, env: Env): Promise<Response> {
  const auth = await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"));
  if (!auth.ok) return forbidden();
  await env.PICS.delete(picKey(friendId));
  await env.PICS.delete(picMetaKey(friendId));
  return json({ ok: true, ownerRecreated: auth.created });
}

// POST a report for any content kind. The reporter proves a real identity by
// presenting their own bound read token (X-Read-Token matching reporterId). The
// record lands in the admin Reports inbox; picture reports auto-hide at threshold.
async function handleReport(targetFriendId: string, req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
  if (await rateLimited(env, "report", ip, limit)) return json({ error: "rate_limited" }, { status: 429 });

  let body: { kind?: unknown; reporterId?: unknown; reason?: unknown; context?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return invalidJson();
  }
  const kind = typeof body.kind === "string" ? body.kind : "";
  const reporterId = typeof body.reporterId === "string" ? body.reporterId : "";
  if (!REPORT_KINDS.has(kind) || !reporterId) return json({ error: "bad_request" }, { status: 400 });

  // Anti-spam: the reporter must own the reporterId (its bound read token).
  if (!(await verifyReadToken(env, reporterId, req.headers.get("X-Read-Token"), "a"))) return forbidden();

  const record = {
    kind,
    targetFriendId,
    reporterId,
    reason: typeof body.reason === "string" ? body.reason.slice(0, 2000) : "",
    context: typeof body.context === "string" ? body.context.slice(0, 4000) : "",
    at: Date.now(),
    resolved: false,
  };
  await env.PICS.put(
    `_reports/${targetFriendId}/${record.at}-${reporterId}.json`,
    JSON.stringify(record),
    { httpMetadata: { contentType: "application/json" } },
  );

  // Picture reports auto-hide once enough distinct reporters flag them.
  if (kind === "picture") {
    const threshold = Number(env.REPORT_AUTOHIDE ?? "3");
    const listed = await env.PICS.list({ prefix: `_reports/${targetFriendId}/` });
    const reporters = new Set<string>();
    for (const o of listed.objects) {
      const name = o.key.split("/").pop() ?? "";
      const who = name.replace(/\.json$/, "").split("-").slice(1).join("-");
      if (who) reporters.add(who);
    }
    if (reporters.size >= threshold) {
      await env.PICS.put(
        tombstoneKey(targetFriendId),
        JSON.stringify({ reason: "auto_report_threshold", at: Date.now() }),
        { httpMetadata: { contentType: "application/json" } },
      );
    }
  }

  return json({ ok: true });
}

/** sha256 hex over raw bytes (the string variant hashes UTF-8 text). */
async function sha256hexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface BatchQuery {
  friendId?: unknown;
  hash?: unknown;
  readToken?: unknown;
}
interface OpinionFile {
  ciphertext?: unknown;
}

// Fetch many friends' opinions for one title in a single call. Each entry is
// read-token-gated; the blind hash differs per author, so callers send one per
// friend. The relay never learns the tmdbId (only opaque hashes).
async function handleOpinionsBatch(req: Request, env: Env): Promise<Response> {
  let body: { items?: unknown };
  try {
    body = (await req.json()) as { items?: unknown };
  } catch {
    return invalidJson();
  }
  const items = Array.isArray(body.items) ? (body.items as BatchQuery[]) : null;
  if (!items) return json({ error: "invalid_payload" }, { status: 400 });

  const out: Array<{ friendId: string; hash: string; ciphertext: string }> = [];
  for (const it of items.slice(0, MAX_BATCH_ITEMS)) {
    const friendId = typeof it.friendId === "string" ? it.friendId : "";
    const hash = typeof it.hash === "string" ? it.hash : "";
    const readToken = typeof it.readToken === "string" ? it.readToken : "";
    if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) continue;
    if (!new RegExp(`^${HASH}$`).test(hash)) continue;
    // Opinions are gated by the live rotatable `tc` (owner.json), NOT the token
    // stamped on the object: opinion objects are not re-PUT on rotation, so their
    // customMetadata goes stale — a removed friend's revoked tc must still 403 here
    // (0a-3). That is one owner.json read + one object read per friend; the client
    // chunks the batch so a request never approaches the 50-subrequest cap.
    if (!(await verifyReadToken(env, friendId, readToken, "c"))) continue;
    const obj = await env.BUCKET.get(`${friendId}/opinions/${hash}.json`);
    if (!obj) continue;
    try {
      const file = (await obj.json()) as OpinionFile;
      if (file && typeof file.ciphertext === "string") {
        out.push({ friendId, hash, ciphertext: file.ciphertext });
      }
    } catch {
      // skip malformed
    }
  }
  return json({ items: out });
}

interface InboxStored {
  id: string;
  at: number;
  ciphertext: string;
}

// Append a sealed message to a recipient's inbox (open write, rate-limited).
async function handlePostInbox(friendId: string, req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10") * 6; // inbox is chattier than share-create
  if (await rateLimited(env, "inbox", ip, limit)) return json({ error: "rate_limited" }, { status: 429 });

  let ciphertext: string;
  try {
    const parsed = (await req.json()) as { ciphertext?: unknown };
    if (typeof parsed.ciphertext !== "string") throw new Error("bad");
    ciphertext = parsed.ciphertext;
  } catch {
    return invalidJson();
  }
  if (ciphertext.length > MAX_INBOX_ITEM_BYTES) return tooLarge();

  const key = `${friendId}/inbox.json`;
  const items = (await getJson<InboxStored[]>(env, key)) ?? [];
  items.push({ id: `${Date.now()}-${randomCode(6)}`, at: Date.now(), ciphertext });
  await putJson(env, key, items.slice(-MAX_INBOX_ITEMS));
  
  // Fire an FCM push to the recipient so every one of their devices fetches the
  // inbox message immediately. The self-topic reaches all of the recipient's
  // devices in one send; a pre-topics recipient falls back to their device token.
  try {
    const config = fcmConfig(env);
    if (config) {
      const target = pickFcmTarget(await readPushRecord(env, friendId), "self");
      if (target) await sendFcmMessage(config, target, friendId, "inbox_update");
    }
  } catch (e) {
    // Ignore FCM failures, inbox is durable
  }

  return json({ ok: true });
}

async function handleGetInbox(friendId: string, req: Request, env: Env): Promise<Response> {
  const auth = await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"));
  if (!auth.ok) return forbidden();
  const items = (await getJson<InboxStored[]>(env, `${friendId}/inbox.json`)) ?? [];
  // ownerRecreated first so a truncated client-side body peek still catches it
  // even when `items` is large.
  return json({ ownerRecreated: auth.created, items });
}

async function handleDeleteInbox(friendId: string, req: Request, env: Env, url: URL): Promise<Response> {
  const auth = await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"));
  if (!auth.ok) return forbidden();
  const upTo = Number(url.searchParams.get("upTo") ?? "0");
  const key = `${friendId}/inbox.json`;
  const items = (await getJson<InboxStored[]>(env, key)) ?? [];
  await putJson(env, key, items.filter((it) => it.at > upTo));
  return json({ ok: true, ownerRecreated: auth.created });
}

interface FreshnessQuery {
  friendId?: unknown;
  readToken?: unknown;
  since?: unknown;
  keyEpoch?: unknown;
}

/** Blind index of a friendId for access.json slots — matches the client's derivation. */
async function accessSlotHash(friendId: string): Promise<string> {
  return sha256hex(`access-slot:${friendId}`);
}

async function handleFreshness(req: Request, env: Env): Promise<Response> {
  let body: { items?: unknown; requesterId?: unknown };
  try {
    body = (await req.json()) as { items?: unknown; requesterId?: unknown };
  } catch {
    return invalidJson();
  }
  const items = Array.isArray(body.items) ? (body.items as FreshnessQuery[]) : null;
  if (!items) return json({ error: "invalid_payload" }, { status: 400 });

  // The caller's own friendId — lets us return their freshly-sealed access slot
  // inline when an author rotated (0a-3), so they re-key without an extra request.
  const requesterId =
    typeof body.requesterId === "string" && new RegExp(`^${FRIEND_ID}$`).test(body.requesterId)
      ? body.requesterId
      : "";
  const slotHash = requesterId ? await accessSlotHash(requesterId) : "";

  const out: Array<{ friendId: string; modifiedAt: number; profile?: unknown; slot?: unknown; keyEpoch?: number }> = [];
  for (const it of items.slice(0, MAX_BATCH_ITEMS)) {
    const friendId = typeof it.friendId === "string" ? it.friendId : "";
    const readToken = typeof it.readToken === "string" ? it.readToken : "";
    const since = typeof it.since === "number" ? it.since : 0;
    const sentEpoch = typeof it.keyEpoch === "number" ? it.keyEpoch : 0;

    if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) continue;

    // Single get() yields body + uploaded + customMetadata — no separate owner.json
    // read or head() (0a-2). The plaintext header carries the author's keyEpoch.
    const obj = await env.BUCKET.get(`${friendId}/profile.json`);
    if (!obj) continue;
    const uploaded = obj.uploaded.getTime();
    let profile: any = null;
    try {
      profile = await obj.json();
    } catch {
      profile = null;
    }
    const authorEpoch =
      profile && profile.header && typeof profile.header.keyEpoch === "number" ? profile.header.keyEpoch : 0;

    // Rotation: the author bumped keyEpoch since the requester last synced. Return
    // the requester's re-sealed access slot inline so they pick up the new feed key,
    // tc, and topic in this same call. Membership in access.json is the authorization
    // (the slot is sealed to their public keyset); a removed friend has no slot and
    // receives nothing here — actually revoked.
    if (slotHash && authorEpoch > sentEpoch) {
      const access = await getJson<{ keys?: Record<string, unknown> }>(env, `${friendId}/access.json`);
      const slot = access?.keys?.[slotHash];
      if (slot !== undefined && profile) {
        out.push({ friendId, modifiedAt: uploaded, profile, slot, keyEpoch: authorEpoch });
      }
      continue;
    }

    // Normal path: fresh + authorized by the rotatable tc (customMetadata, or the
    // live owner.json for a profile written before the token was stamped).
    if (uploaded <= since) continue;
    const rt = obj.customMetadata?.rt;
    const authed = rt ? rt === readToken : await verifyReadToken(env, friendId, readToken, "c");
    if (!authed) continue;
    out.push({ friendId, modifiedAt: uploaded, profile: profile ?? undefined });
  }
  return json({ items: out });
}

interface FcOwnerRecord {
  c: string;
}

// Publish my public friend card under a short, stable code (owner-authenticated).
// The card holds only public pairing info — no secrets.
async function handlePublishFriendCode(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (body.length > MAX_CARD_BYTES) return tooLarge();
  let card: { friendId?: unknown };
  try {
    card = JSON.parse(body);
  } catch {
    return invalidJson();
  }
  const friendId = typeof card.friendId === "string" ? card.friendId : "";
  if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) return json({ error: "invalid_card" }, { status: 400 });
  const auth = await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"));
  if (!auth.ok) return forbidden();

  // Stable code per friendId: reuse the existing one, else mint a unique one.
  const owner = await getJson<FcOwnerRecord>(env, `${friendId}/friendcode.json`);
  const code = owner?.c ?? (await generateUniqueFriendCode(env));
  const existingCard = await getText(env, `fc/${code}.json`);
  if (existingCard !== body) {
    await putRaw(env, `fc/${code}.json`, body);
    await putJson(env, `${friendId}/friendcode.json`, { c: code });
  }
  return json({
    code,
    expiresAt: new Date(Date.now() + FRIENDCODE_TTL * 1000).toISOString(),
    ownerRecreated: auth.created,
  });
}

async function handleGetFriendCode(code: string, env: Env): Promise<Response> {
  const raw = await getText(env, `fc/${code}.json`);
  return raw ? rawJson(raw) : notFound();
}

// ── Portable identity backup ──────────────────────────────────────────────────
// Zero-knowledge: the relay stores ciphertext under a blind-index lookup key the
// owner derives from their recovery code (HKDF). The relay can neither read the
// bundle nor link it to a friendId. Possession of the unguessable lookup key is
// the only authorization needed — only the owner can derive it.

async function handlePutBackup(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (body.length > MAX_BACKUP_BYTES) return tooLarge();
  let parsed: { lookupKey?: unknown; ciphertext?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return invalidJson();
  }
  const lookupKey = typeof parsed.lookupKey === "string" ? parsed.lookupKey : "";
  const ciphertext = typeof parsed.ciphertext === "string" ? parsed.ciphertext : "";
  if (!new RegExp(`^${LOOKUP_KEY}$`).test(lookupKey) || !ciphertext) {
    return json({ error: "invalid_payload" }, { status: 400 });
  }
  await putJson(env, `backup/${lookupKey}.json`, { ciphertext });
  return json({ ok: true });
}

async function handleGetBackup(lookupKey: string, env: Env): Promise<Response> {
  const rec = await getJson<{ ciphertext: string }>(env, `backup/${lookupKey}.json`);
  return rec ? json({ ciphertext: rec.ciphertext }) : notFound();
}

async function handleDeleteBackup(lookupKey: string, env: Env): Promise<Response> {
  await env.BUCKET.delete(`backup/${lookupKey}.json`);
  return json({ ok: true });
}

// ── Live friends+block record ───────────────────────────────────────────────
// Per-user encrypted friend + block list, kept current across the user's own
// devices. The relay stores ciphertext only — it never sees who is friends with
// whom. Optimistic concurrency: the writer presents the version it based its
// edit on; a mismatch returns 409 so the client re-pulls, LWW-merges, retries.

interface SelfRecord {
  ciphertext: string;
  version: number;
}

async function handleGetSelf(lookupKey: string, env: Env): Promise<Response> {
  const rec = await getJson<SelfRecord>(env, `self/${lookupKey}.json`);
  return rec ? json({ ciphertext: rec.ciphertext, version: rec.version }) : notFound();
}

async function handlePutSelf(lookupKey: string, req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (body.length > MAX_SELF_BYTES) return tooLarge();
  let parsed: { ciphertext?: unknown; baseVersion?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return invalidJson();
  }
  const ciphertext = typeof parsed.ciphertext === "string" ? parsed.ciphertext : "";
  const baseVersion = typeof parsed.baseVersion === "number" ? parsed.baseVersion : NaN;
  if (!ciphertext || !Number.isFinite(baseVersion)) {
    return json({ error: "invalid_payload" }, { status: 400 });
  }
  const existing = await getJson<SelfRecord>(env, `self/${lookupKey}.json`);
  const currentVersion = existing?.version ?? 0;
  if (baseVersion !== currentVersion) {
    return json({ error: "version_conflict", version: currentVersion }, { status: 409 });
  }
  const next: SelfRecord = { ciphertext, version: currentVersion + 1 };
  await putJson(env, `self/${lookupKey}.json`, next);
  return json({ ok: true, version: next.version });
}

async function handleDeleteSelf(lookupKey: string, env: Env): Promise<Response> {
  await env.BUCKET.delete(`self/${lookupKey}.json`);
  return json({ ok: true });
}

// ── Account / data deletion ───────────────────────────────────────────────────

// Remove every object stored under a friendId prefix, plus the public friend
// card it points at. Returns the number of relay objects removed.
async function purgeFriendScoped(env: Env, friendId: string): Promise<number> {
  const fc = await getJson<FcOwnerRecord>(env, `${friendId}/friendcode.json`);
  let removed = await deletePrefix(env, `${friendId}/`);
  if (fc?.c) {
    await env.BUCKET.delete(`fc/${fc.c}.json`);
    removed += 1;
  }
  return removed;
}

// Owner-authenticated deletion — used by the in-app "Delete my social data"
// action, which holds the write secret. Purges the friendId-scoped relay data
// and, when the caller supplies the blind-index lookup keys it alone can derive,
// the zero-knowledge identity backup and live friends record too.
async function handleSocialDelete(req: Request, env: Env): Promise<Response> {
  let body: { friendId?: unknown; backupLookupKey?: unknown; selfLookupKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return invalidJson();
  }
  const friendId = typeof body.friendId === "string" ? body.friendId : "";
  if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) return json({ error: "invalid_request" }, { status: 400 });
  // Deletion endpoint: intentionally does NOT surface ownerRecreated — signaling
  // "republish" while the user is deleting their data would resurrect it.
  if (!(await verifyOwner(env, friendId, req.headers.get("X-Feed-Secret"))).ok) return forbidden();

  let removed = await purgeFriendScoped(env, friendId);
  const backupLookupKey = typeof body.backupLookupKey === "string" ? body.backupLookupKey : "";
  const selfLookupKey = typeof body.selfLookupKey === "string" ? body.selfLookupKey : "";
  if (new RegExp(`^${LOOKUP_KEY}$`).test(backupLookupKey)) {
    await env.BUCKET.delete(`backup/${backupLookupKey}.json`);
    removed += 1;
  }
  if (new RegExp(`^${LOOKUP_KEY}$`).test(selfLookupKey)) {
    await env.BUCKET.delete(`self/${selfLookupKey}.json`);
    removed += 1;
  }
  return json({ ok: true, removed });
}

// Web fallback for users who no longer have the app: identify the account by its
// public friend code and purge the friendId-scoped relay data immediately. The
// zero-knowledge backup + friends record are NOT touched here (their blind-index
// keys require the recovery code), so the user's private recovery path stays
// intact and only they — via the in-app reset — can remove it.
async function handleDeleteRequest(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
  if (await rateLimited(env, "delreq", ip, limit)) return json({ error: "rate_limited" }, { status: 429 });

  let body: { code?: unknown };
  try {
    body = (await req.json()) as { code?: unknown };
  } catch {
    return invalidJson();
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!new RegExp(`^${FRIEND_CODE}$`).test(code)) return json({ error: "invalid_code" }, { status: 400 });

  const card = await getJson<{ friendId?: unknown }>(env, `fc/${code}.json`);
  const friendId = card && typeof card.friendId === "string" ? card.friendId : "";
  if (!new RegExp(`^${FRIEND_ID}$`).test(friendId)) return notFound();

  const removed = await purgeFriendScoped(env, friendId);
  return json({ ok: true, removed });
}

// List + delete every object under a prefix, following the R2 list cursor.
async function deletePrefix(env: Env, prefix: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.BUCKET.list({ prefix, cursor });
    if (listed.objects.length) {
      await env.BUCKET.delete(listed.objects.map((o) => o.key));
      removed += listed.objects.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return removed;
}

// ── Share links ──────────────────────────────────────────────────────────────

async function handleCreate(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
  if (await rateLimited(env, "share", ip, limit)) return json({ error: "rate_limited" }, { status: 429 });

  let payload: SharePayload;
  try {
    payload = (await req.json()) as SharePayload;
  } catch {
    return invalidJson();
  }
  if (!payload || typeof payload.title !== "string") {
    return json({ error: "invalid_payload" }, { status: 400 });
  }

  const kind = payload.kind === "smart" ? "smart" : "manual";
  const title = payload.title.slice(0, 120);
  const maxItems = Number(env.MAX_ITEMS ?? "100");

  let items: ShareItem[] = [];
  let filters: unknown | null = null;

  if (kind === "smart") {
    if (!payload.filters || typeof payload.filters !== "object") {
      return json({ error: "invalid_filters" }, { status: 400 });
    }
    if (JSON.stringify(payload.filters).length > MAX_FILTERS_BYTES) {
      return json({ error: "filters_too_large" }, { status: 400 });
    }
    filters = payload.filters;
  } else {
    if (!Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > maxItems) {
      return json({ error: "invalid_payload" }, { status: 400 });
    }
    items = payload.items
      .slice(0, maxItems)
      .map((it) => ({ tmdbId: Number(it.tmdbId) | 0, type: String(it.type).slice(0, 8) }))
      .filter((it) => it.tmdbId > 0);
    if (items.length === 0) return json({ error: "empty_after_validation" }, { status: 400 });
  }

  const ttl = Number(env.SHARE_TTL_SECONDS ?? "2592000");
  const code = await generateUniqueCode(env);
  const now = new Date();
  const stored: StoredShare = {
    kind,
    title,
    items,
    filters,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    views: 0,
  };
  await putJson(env, `share/${code}.json`, stored);
  return json({ code, expiresAt: stored.expiresAt });
}

async function handleGet(code: string, env: Env): Promise<Response> {
  const stored = await getJson<StoredShare>(env, `share/${code}.json`);
  if (!stored || isExpired(stored)) return notFound();

  const normalized = normalizeStored(stored);
  normalized.views = (normalized.views ?? 0) + 1;
  await putJson(env, `share/${code}.json`, normalized);
  return json(normalized);
}

async function handleLanding(code: string, env: Env): Promise<Response> {
  const stored = await getJson<StoredShare>(env, `share/${code}.json`);
  if (!stored || isExpired(stored)) return html(landingNotFound(), { status: 404 });
  // Read-only render: does not increment views (that's the app's /api GET).
  return html(landingPage(code, normalizeStored(stored)));
}

function isExpired(s: { expiresAt?: string }): boolean {
  return !!s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
}

// ── Utilities ────────────────────────────────────────────────────────────────

async function sha256hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Back-fills fields absent on shares stored before the kind/filters split.
function normalizeStored(parsed: any): StoredShare {
  return {
    kind: parsed.kind === "smart" ? "smart" : "manual",
    title: typeof parsed.title === "string" ? parsed.title : "Shared list",
    items: Array.isArray(parsed.items) ? parsed.items : [],
    filters: parsed.filters ?? null,
    createdAt: parsed.createdAt ?? new Date().toISOString(),
    expiresAt: parsed.expiresAt ?? new Date().toISOString(),
    views: Number(parsed.views ?? 0),
  };
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

async function generateUniqueCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    if (!(await env.BUCKET.head(`share/${code}.json`))) return code;
  }
  return randomCode(8);
}

async function generateUniqueFriendCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    if (!(await env.BUCKET.head(`fc/${code}.json`))) return code;
  }
  return randomCode(8);
}

function randomCode(length: number): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

function landingPage(code: string, stored: StoredShare): string {
  const intentUrl =
    `intent://share/${code}#Intent;scheme=flickto;package=${APP_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;
  const subtitle =
    stored.kind === "smart"
      ? "Smart list · rebuilds on your device"
      : `${stored.items.length} title${stored.items.length === 1 ? "" : "s"}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${htmlEscape(stored.title)} · FlickTo</title>
    <style>
      :root { color-scheme: dark; }
      body {
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        background: #0e1014; color: #e8eaf0;
        display: flex; min-height: 100vh; margin: 0;
        align-items: center; justify-content: center; padding: 1.5rem;
      }
      .card { max-width: 420px; width: 100%; text-align: center; }
      h1 { font-size: 24px; margin: 0 0 0.25rem; }
      .muted { color: #8a93a6; margin: 0 0 1.75rem; }
      .btn {
        display: block; width: 100%; box-sizing: border-box;
        padding: 0.9rem 1rem; border-radius: 12px; text-decoration: none;
        font-weight: 600; margin-bottom: 0.75rem;
      }
      .primary { background: #ffb547; color: #0e1014; }
      .secondary { background: #1b2030; color: #e8eaf0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${htmlEscape(stored.title)}</h1>
      <p class="muted">${subtitle}</p>
      <a class="btn primary" id="open" href="${intentUrl}">Open in FlickTo</a>
      <a class="btn secondary" href="${PLAY_STORE_URL}">Get it on Google Play</a>
      <a class="btn secondary" href="${APP_STORE_URL}">Download on the App Store</a>
    </div>
    <!--
      No auto-redirect: Chrome blocks gesture-less navigation to an intent://
      URL and falls through to browser_fallback_url (the store). The user taps
      "Open in FlickTo" instead — that gesture is honored and opens the app.
      Links clicked from App-Link-aware apps open the app directly and never
      reach this page.
    -->
  </body>
</html>`;
}

function landingNotFound(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>List not found · FlickTo</title>
    <style>
      :root { color-scheme: dark; }
      body {
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        background: #0e1014; color: #e8eaf0;
        display: flex; min-height: 100vh; margin: 0;
        align-items: center; justify-content: center; padding: 1.5rem; text-align: center;
      }
      a { color: #ffb547; }
    </style>
  </head>
  <body>
    <div>
      <h1>This list expired or doesn't exist</h1>
      <p>Shared lists are kept for 30 days. <a href="${PLAY_STORE_URL}">Get FlickTo</a></p>
    </div>
  </body>
</html>`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Legal / compliance pages (/privacy, /delete) have been moved to static HTML
// files served by the flickto-content worker. The inline templates that were
// here (privacyPage(), deletePage(), LEGAL_CSS) have been extracted to:
//   flickd-content/content/privacy.html
//   flickd-content/content/delete.html




