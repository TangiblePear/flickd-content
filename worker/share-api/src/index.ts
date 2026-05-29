interface Env {
  FLICKD_SHARE: KVNamespace;
  SHARE_TTL_SECONDS: string;
  RATE_LIMIT_PER_HOUR: string;
  MAX_ITEMS: string;
}

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

// ── Social channel (E2E-encrypted; relay stores ciphertext only) ──
const FEED_TTL = 60 * 60 * 24 * 30; // 30 days
const OPINIONS_TTL = 60 * 60 * 24 * 365; // 12 months
const INBOX_TTL = 60 * 60 * 24 * 30; // 30-day backstop if never collected
const OWNER_TTL = 60 * 60 * 24 * 400; // identity/read-token binding, refreshed on writes
// Lazily re-up the long-lived bindings instead of on every write: a routine
// feed/opinions/friendcode publish no longer costs an owner/readtok/fcOwner
// write. We only rewrite a binding once it's older than these thresholds.
const OWNER_REFRESH_AFTER_MS = 1000 * 60 * 60 * 24 * 30; // owner + readtok (400-day TTL)
const FRIENDCODE_REFRESH_AFTER_MS = 1000 * 60 * 60 * 24 * 45; // friend code (90-day TTL)
const MAX_BLOB_BYTES = 256 * 1024; // a feed/opinions ciphertext blob
const MAX_INBOX_ITEM_BYTES = 64 * 1024;
const MAX_INBOX_ITEMS = 200;
const FRIENDCODE_TTL = 60 * 60 * 24 * 90; // 90 days — a shareable short code → public friend card
const MAX_CARD_BYTES = 8 * 1024;
const FRIEND_ID = "[A-Z0-9]{12,40}";
const FRIEND_CODE = "[A-Z0-9]{6,12}";

const APP_PACKAGE = "com.flickd.app";
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.flickd.app";
const APP_STORE_URL = "https://apps.apple.com/app/id0000000000";

// Opaque smart-filter blobs are capped so a share can't be used to stuff KV.
const MAX_FILTERS_BYTES = 4096;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...CORS, ...(init.headers ?? {}) },
  });

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    ...init,
    headers: { "Content-Type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);

    if (url.pathname === "/api/share" && req.method === "POST") {
      return handleCreate(req, env);
    }

    const apiMatch = url.pathname.match(/^\/api\/share\/([A-Z0-9]{6,12})$/);
    if (apiMatch && req.method === "GET") {
      return handleGet(apiMatch[1], env);
    }

    // Human-facing landing page: opens the app via deep link, falls back to
    // store links. Reached only when the App Link isn't auto-verified (typed
    // URL, app not installed, desktop, iOS).
    const landingMatch = url.pathname.match(/^\/share\/([A-Z0-9]{6,12})$/);
    if (landingMatch && req.method === "GET") {
      return handleLanding(landingMatch[1], env);
    }

    // ── Social channel ──
    const feedMatch = url.pathname.match(new RegExp(`^/api/feed/(${FRIEND_ID})$`));
    if (feedMatch) {
      if (req.method === "PUT") return handlePutBroadcast(feedMatch[1], "feed", FEED_TTL, req, env);
      if (req.method === "GET") return handleGetBroadcast(feedMatch[1], "feed", env, req);
    }

    const opinionsMatch = url.pathname.match(new RegExp(`^/api/opinions/(${FRIEND_ID})$`));
    if (opinionsMatch) {
      if (req.method === "PUT") return handlePutBroadcast(opinionsMatch[1], "op", OPINIONS_TTL, req, env);
      if (req.method === "GET") return handleGetBroadcast(opinionsMatch[1], "op", env, req);
    }

    const inboxMatch = url.pathname.match(new RegExp(`^/api/inbox/(${FRIEND_ID})$`));
    if (inboxMatch) {
      if (req.method === "POST") return handlePostInbox(inboxMatch[1], req, env);
      if (req.method === "GET") return handleGetInbox(inboxMatch[1], req, env);
      if (req.method === "DELETE") return handleDeleteInbox(inboxMatch[1], req, env, url);
    }

    // Short friend code → public friend card (for manual pairing).
    if (url.pathname === "/api/friendcode" && req.method === "POST") {
      return handlePublishFriendCode(req, env);
    }
    const friendCodeMatch = url.pathname.match(new RegExp(`^/api/friendcode/(${FRIEND_CODE})$`));
    if (friendCodeMatch && req.method === "GET") {
      return handleGetFriendCode(friendCodeMatch[1], env);
    }

    return json({ error: "not_found" }, { status: 404 });
  },
};

async function handleCreate(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";

  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10");
  if (limit > 0) {
    const rateKey = `rl:${ip}:${currentHour()}`;
    const count = Number((await env.FLICKD_SHARE.get(rateKey)) ?? "0");
    if (count >= limit) {
      return json({ error: "rate_limited" }, { status: 429 });
    }
    await env.FLICKD_SHARE.put(rateKey, String(count + 1), { expirationTtl: 3700 });
  }

  let payload: SharePayload;
  try {
    payload = (await req.json()) as SharePayload;
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
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
    const serialized = JSON.stringify(payload.filters);
    if (serialized.length > MAX_FILTERS_BYTES) {
      return json({ error: "filters_too_large" }, { status: 400 });
    }
    filters = payload.filters;
  } else {
    if (
      !Array.isArray(payload.items) ||
      payload.items.length === 0 ||
      payload.items.length > maxItems
    ) {
      return json({ error: "invalid_payload" }, { status: 400 });
    }
    items = payload.items
      .slice(0, maxItems)
      .map((it) => ({
        tmdbId: Number(it.tmdbId) | 0,
        type: String(it.type).slice(0, 8),
      }))
      .filter((it) => it.tmdbId > 0);
    if (items.length === 0) {
      return json({ error: "empty_after_validation" }, { status: 400 });
    }
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
  await env.FLICKD_SHARE.put(`s:${code}`, JSON.stringify(stored), { expirationTtl: ttl });

  return json({ code, expiresAt: stored.expiresAt });
}

async function handleGet(code: string, env: Env): Promise<Response> {
  const raw = await env.FLICKD_SHARE.get(`s:${code}`);
  if (!raw) return json({ error: "not_found" }, { status: 404 });

  const stored = normalizeStored(JSON.parse(raw));
  stored.views = (stored.views ?? 0) + 1;

  const remainingSeconds = Math.floor(
    (new Date(stored.expiresAt).getTime() - Date.now()) / 1000,
  );
  if (remainingSeconds > 60) {
    await env.FLICKD_SHARE.put(`s:${code}`, JSON.stringify(stored), {
      expirationTtl: remainingSeconds,
    });
  }

  return json(stored);
}

async function handleLanding(code: string, env: Env): Promise<Response> {
  const raw = await env.FLICKD_SHARE.get(`s:${code}`);
  if (!raw) return html(landingNotFound(), { status: 404 });

  // Read-only render: does not increment views (that's the app's /api GET).
  const stored = normalizeStored(JSON.parse(raw));
  return html(landingPage(code, stored));
}

// ── Social handlers ───────────────────────────────────────────────────────

/** Owner binding stored as {hash, boundAt}; boundAt drives the lazy TTL refresh. */
interface OwnerRecord {
  h: string;
  b: number;
}

/** Parse an owner binding, tolerating legacy plain-hash values (boundAt 0 ⇒ refresh once). */
function parseOwner(raw: string): OwnerRecord {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.h === "string") return { h: v.h, b: Number(v.b ?? 0) };
  } catch {
    /* legacy plain-hash value */
  }
  return { h: raw, b: 0 };
}

/** Read-token binding stored as {token, boundAt}; boundAt drives the lazy TTL refresh. */
interface ReadTokRecord {
  t: string;
  b: number;
}

/** Parse a read-token binding, tolerating legacy plain-token values (boundAt 0 ⇒ refresh once). */
function parseReadTok(raw: string): ReadTokRecord {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.t === "string") return { t: v.t, b: Number(v.b ?? 0) };
  } catch {
    /* legacy plain-token value */
  }
  return { t: raw, b: 0 };
}

/** Trust-on-first-use owner binding: bind hash(writeSecret) on first owner write, verify after. */
async function verifyOrBindOwner(
  env: Env,
  friendId: string,
  secret: string | null,
): Promise<boolean> {
  if (!secret) return false;
  const hash = await sha256hex(secret);
  const key = `owner:${friendId}`;
  const existing = await env.FLICKD_SHARE.get(key);
  if (!existing) {
    await env.FLICKD_SHARE.put(key, JSON.stringify({ h: hash, b: Date.now() }), {
      expirationTtl: OWNER_TTL,
    });
    return true;
  }
  const rec = parseOwner(existing);
  if (rec.h !== hash) return false;
  // Lazy TTL refresh: only re-up the 400-day binding once it's stale, so a
  // routine write no longer costs an owner-key write every time.
  if (Date.now() - rec.b > OWNER_REFRESH_AFTER_MS) {
    await env.FLICKD_SHARE.put(key, JSON.stringify({ h: hash, b: Date.now() }), {
      expirationTtl: OWNER_TTL,
    });
  }
  return true;
}

// Publish a broadcast blob (feed / opinions). Owner-authenticated; on write we
// (re)bind the read token friends must present to fetch it.
async function handlePutBroadcast(
  friendId: string,
  prefix: string,
  ttl: number,
  req: Request,
  env: Env,
): Promise<Response> {
  const secret = req.headers.get("X-Feed-Secret");
  if (!(await verifyOrBindOwner(env, friendId, secret))) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  const readToken = req.headers.get("X-Read-Token");
  if (readToken) {
    const tokKey = `readtok:${friendId}`;
    const existingTok = await env.FLICKD_SHARE.get(tokKey);
    const rec = existingTok ? parseReadTok(existingTok) : null;
    // The read token is stable per identity, so only write it when it actually
    // changed or its 400-day TTL has gone stale — not on every publish.
    if (!rec || rec.t !== readToken || Date.now() - rec.b > OWNER_REFRESH_AFTER_MS) {
      await env.FLICKD_SHARE.put(tokKey, JSON.stringify({ t: readToken, b: Date.now() }), {
        expirationTtl: OWNER_TTL,
      });
    }
  }
  const body = await req.text();
  if (body.length > MAX_BLOB_BYTES) {
    return json({ error: "too_large" }, { status: 413 });
  }
  try {
    JSON.parse(body);
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  await env.FLICKD_SHARE.put(`${prefix}:${friendId}`, body, { expirationTtl: ttl });
  return json({ ok: true });
}

// Fetch a friend's broadcast blob. Read-token-gated; the blob is ciphertext, so
// even a leaked token only yields data the friend can't decrypt without a key.
async function handleGetBroadcast(
  friendId: string,
  prefix: string,
  env: Env,
  req: Request,
): Promise<Response> {
  const bound = await env.FLICKD_SHARE.get(`readtok:${friendId}`);
  if (!bound) return json({ error: "not_found" }, { status: 404 });
  if (req.headers.get("X-Read-Token") !== parseReadTok(bound).t) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  const raw = await env.FLICKD_SHARE.get(`${prefix}:${friendId}`);
  if (!raw) return json({ error: "not_found" }, { status: 404 });
  return new Response(raw, {
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

interface InboxStored {
  id: string;
  at: number;
  ciphertext: string;
}

// Append a sealed message to a recipient's inbox. Open write (sealed content is
// useless to the relay), rate-limited, capped, and never decryptable here.
async function handlePostInbox(friendId: string, req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = Number(env.RATE_LIMIT_PER_HOUR ?? "10") * 6; // inbox is chattier than share-create
  if (limit > 0) {
    const rateKey = `rl:inbox:${ip}:${currentHour()}`;
    const count = Number((await env.FLICKD_SHARE.get(rateKey)) ?? "0");
    if (count >= limit) return json({ error: "rate_limited" }, { status: 429 });
    await env.FLICKD_SHARE.put(rateKey, String(count + 1), { expirationTtl: 3700 });
  }

  let ciphertext: string;
  try {
    const parsed = (await req.json()) as { ciphertext?: unknown };
    if (typeof parsed.ciphertext !== "string") throw new Error("bad");
    ciphertext = parsed.ciphertext;
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  if (ciphertext.length > MAX_INBOX_ITEM_BYTES) {
    return json({ error: "too_large" }, { status: 413 });
  }

  const key = `inbox:${friendId}`;
  const existing = await env.FLICKD_SHARE.get(key);
  const items: InboxStored[] = existing ? (JSON.parse(existing) as InboxStored[]) : [];
  items.push({ id: `${Date.now()}-${randomCode(6)}`, at: Date.now(), ciphertext });
  const trimmed = items.slice(-MAX_INBOX_ITEMS);
  await env.FLICKD_SHARE.put(key, JSON.stringify(trimmed), { expirationTtl: INBOX_TTL });
  return json({ ok: true });
}

async function handleGetInbox(friendId: string, req: Request, env: Env): Promise<Response> {
  if (!(await verifyOrBindOwner(env, friendId, req.headers.get("X-Feed-Secret")))) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  const raw = await env.FLICKD_SHARE.get(`inbox:${friendId}`);
  const items: InboxStored[] = raw ? (JSON.parse(raw) as InboxStored[]) : [];
  return json({ items });
}

async function handleDeleteInbox(
  friendId: string,
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!(await verifyOrBindOwner(env, friendId, req.headers.get("X-Feed-Secret")))) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  const upTo = Number(url.searchParams.get("upTo") ?? "0");
  const key = `inbox:${friendId}`;
  const raw = await env.FLICKD_SHARE.get(key);
  const items: InboxStored[] = raw ? (JSON.parse(raw) as InboxStored[]) : [];
  // Items arriving after the client's read have at > upTo, so they're preserved.
  const remaining = items.filter((it) => it.at > upTo);
  await env.FLICKD_SHARE.put(key, JSON.stringify(remaining), { expirationTtl: INBOX_TTL });
  return json({ ok: true });
}

// Publish my public friend card under a short, stable code (owner-authenticated).
// The card holds only public pairing info (friendId, displayName, avatarId,
// publicKeyset, feedReadToken) — no secrets — so a code reveals nothing private.
async function handlePublishFriendCode(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (body.length > MAX_CARD_BYTES) return json({ error: "too_large" }, { status: 413 });
  let card: { friendId?: unknown };
  try {
    card = JSON.parse(body);
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  const friendId = typeof card.friendId === "string" ? card.friendId : "";
  if (!/^[A-Z0-9]{12,40}$/.test(friendId)) return json({ error: "invalid_card" }, { status: 400 });
  if (!(await verifyOrBindOwner(env, friendId, req.headers.get("X-Feed-Secret")))) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  // Stable code per friendId: reuse the existing one if present, else mint a unique one.
  const ownerRaw = await env.FLICKD_SHARE.get(`fcOwner:${friendId}`);
  const owner = ownerRaw ? parseFcOwner(ownerRaw) : null;
  const code = owner?.c ?? (await generateUniqueFriendCode(env));
  const existingCard = await env.FLICKD_SHARE.get(`fc:${code}`);
  const stale = !owner || Date.now() - owner.b > FRIENDCODE_REFRESH_AFTER_MS;
  // Skip both writes when the published card is byte-identical and the 90-day
  // code TTL isn't near expiry — the common case on repeat opens.
  if (existingCard !== body || stale) {
    await env.FLICKD_SHARE.put(`fc:${code}`, body, { expirationTtl: FRIENDCODE_TTL });
    await env.FLICKD_SHARE.put(`fcOwner:${friendId}`, JSON.stringify({ c: code, b: Date.now() }), {
      expirationTtl: OWNER_TTL,
    });
  }
  return json({ code, expiresAt: new Date(Date.now() + FRIENDCODE_TTL * 1000).toISOString() });
}

async function handleGetFriendCode(code: string, env: Env): Promise<Response> {
  const raw = await env.FLICKD_SHARE.get(`fc:${code}`);
  if (!raw) return json({ error: "not_found" }, { status: 404 });
  return new Response(raw, { headers: { "Content-Type": "application/json", ...CORS } });
}

/** fcOwner binding stored as {code, boundAt}; boundAt drives the lazy TTL refresh. */
interface FcOwnerRecord {
  c: string;
  b: number;
}

/** Parse an fcOwner binding, tolerating legacy plain-code values (boundAt 0 ⇒ refresh once). */
function parseFcOwner(raw: string): FcOwnerRecord {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.c === "string") return { c: v.c, b: Number(v.b ?? 0) };
  } catch {
    /* legacy plain-code value */
  }
  return { c: raw, b: 0 };
}

async function generateUniqueFriendCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    if (!(await env.FLICKD_SHARE.get(`fc:${code}`))) return code;
  }
  return randomCode(8);
}

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

function landingPage(code: string, stored: StoredShare): string {
  const intentUrl =
    `intent://share/${code}#Intent;scheme=flickd;package=${APP_PACKAGE};` +
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
    <title>${htmlEscape(stored.title)} · Flickd</title>
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
      <a class="btn primary" id="open" href="${intentUrl}">Open in Flickd</a>
      <a class="btn secondary" href="${PLAY_STORE_URL}">Get it on Google Play</a>
      <a class="btn secondary" href="${APP_STORE_URL}">Download on the App Store</a>
    </div>
    <!--
      No auto-redirect: Chrome blocks gesture-less navigation to an intent://
      URL and falls through to browser_fallback_url (the store). The user taps
      "Open in Flickd" instead — that gesture is honored and opens the app.
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
    <title>List not found · Flickd</title>
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
      <p>Shared lists are kept for 30 days. <a href="${PLAY_STORE_URL}">Get Flickd</a></p>
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

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
async function generateUniqueCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(6);
    const existing = await env.FLICKD_SHARE.get(`s:${code}`);
    if (!existing) return code;
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

function currentHour(): string {
  return new Date().toISOString().slice(0, 13);
}
