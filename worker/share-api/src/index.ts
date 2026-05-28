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
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
    <script>
      // Auto-attempt the deep link once on load; the buttons stay as fallback.
      try { window.location.href = ${JSON.stringify(intentUrl)}; } catch (e) {}
    </script>
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
