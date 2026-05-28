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
  title: string;
  items: ShareItem[];
}

interface StoredShare extends SharePayload {
  createdAt: string;
  expiresAt: string;
  views: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...CORS, ...(init.headers ?? {}) },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);

    if (url.pathname === "/api/share" && req.method === "POST") {
      return handleCreate(req, env);
    }

    const match = url.pathname.match(/^\/api\/share\/([A-Z0-9]{6,12})$/);
    if (match && req.method === "GET") {
      return handleGet(match[1], env);
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

  const maxItems = Number(env.MAX_ITEMS ?? "100");
  if (
    !payload ||
    typeof payload.title !== "string" ||
    !Array.isArray(payload.items) ||
    payload.items.length === 0 ||
    payload.items.length > maxItems
  ) {
    return json({ error: "invalid_payload" }, { status: 400 });
  }

  const title = payload.title.slice(0, 120);
  const items = payload.items.slice(0, maxItems).map((it) => ({
    tmdbId: Number(it.tmdbId) | 0,
    type: String(it.type).slice(0, 8),
  })).filter((it) => it.tmdbId > 0);

  if (items.length === 0) {
    return json({ error: "empty_after_validation" }, { status: 400 });
  }

  const ttl = Number(env.SHARE_TTL_SECONDS ?? "2592000");
  const code = await generateUniqueCode(env);
  const now = new Date();
  const stored: StoredShare = {
    title,
    items,
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

  const stored = JSON.parse(raw) as StoredShare;
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
