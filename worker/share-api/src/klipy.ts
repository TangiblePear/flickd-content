// ── KLIPY proxy ─────────────────────────────────────────────────────────────
// Trending and search for the comment GIF picker, proxied rather than called
// from the app, for two independent reasons — either alone would justify it.
//
//   1. ⚠️ **The key must never ship in the APK.** KLIPY puts the key in the URL
//      PATH (`/api/v1/{key}/…`), so a direct client would ship it, and an APK key
//      is trivially extractable.
//   2. ⚠️ **The test tier is 100 API calls PER HOUR, per key — not per user.**
//      That is ~1.6 a minute across everybody, and a picker fires a search per
//      debounced keystroke plus trending on open. Only caching makes it survivable
//      until a production ("unlimited") key is granted.
//
// Picker-open shows *trending*, which is identical for every user, so one upstream
// call an hour serves everybody. Popular search terms cache the same way. Same
// edge-cache pattern as the public comment list.
//
// The route path stays `/api/giphy/*` (see index.ts) even though the provider is
// now KLIPY: builds already installed call that path, and the wire shape below is
// provider-neutral, so they keep working unchanged. `comments.media_provider`
// staying swappable is what made this a proxy-internal change rather than a client
// one — GIPHY's API is now paid and Tenor closed to new clients (Jan 2026).
//
// TODO (owner): confirm KLIPY's terms before relying on [CACHE_SECONDS], and
// request a Production key to lift the 100/hour cap (Partner Panel).

export interface KlipyEnv {
  /** A SECRET: `wrangler secret put KLIPY_API_KEY`. Unset ⇒ these routes 503. */
  KLIPY_API_KEY?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

const API = "https://api.klipy.com/api/v1";
/** An hour: the test tier's whole budget is 100 calls in one, so this IS the rate limit. */
const CACHE_SECONDS = 3600;
const MAX_RESULTS = 24;
const MAX_QUERY = 60;

/**
 * ⚠️ **Content safety.** KLIPY filters via `content_filter`, whose accepted values
 * are `off | low | medium | high` — NOT GIPHY's `g/pg/r`. `high` is the safest
 * (most-filtered) level, the KLIPY equivalent of the old `rating=g`.
 *
 * This is why comment GIFs need no Vision SafeSearch scan: a curated catalogue
 * with a safety filter, not arbitrary bytes. Context abuse — a GIF fine alone and
 * abusive as a reply — is a reporting problem, and the report flow already covers it.
 */
const CONTENT_FILTER = "high";

/**
 * ⚠️ Trim the upstream response to the two formats we use: the animated `gif` and
 * a `jpg` still. KLIPY otherwise returns five formats (gif/webp/jpg/mp4/webm) in
 * four sizes each — dozens of renditions per item for six fields of use.
 */
const FORMAT_FILTER = "gif,jpg";

interface KlipyRendition {
  url?: string;
  width?: number;
  height?: number;
}

interface KlipyGif {
  id?: number | string;
  slug?: string;
  title?: string;
  // KLIPY buckets each item by size (hd/md/sm/xs), then by format within a size.
  file?: Record<string, { gif?: KlipyRendition; jpg?: KlipyRendition }>;
}

/** KLIPY wraps the list two levels deep: `{ result, data: { data: [ … ] } }`. */
interface KlipyResponse {
  data?: { data?: KlipyGif[] };
}

/**
 * Trimmed to what the picker and `comments.media_*` actually store.
 *
 * The `sm` bucket (≈220px) is chosen to match GIPHY's old `fixed_width`, so the
 * grid renders at the same weight it always did. `still` is not an optimisation:
 * GIFs must NOT autoplay in a scrolling list — a battery and data complaint waiting
 * to happen — so the list renders the still `jpg` and only swaps to the animated
 * `url` on tap.
 */
function toWire(g: KlipyGif) {
  const sm = g.file?.sm;
  const animated = sm?.gif;
  const still = sm?.jpg;
  return {
    // KLIPY's numeric `id` would collide with the string-keyed grid; `slug` is the
    // stable string identifier it addresses items by, so prefer it.
    id: g.slug || (g.id != null ? String(g.id) : ""),
    title: g.title ?? "",
    url: animated?.url ?? "",
    still: still?.url ?? "",
    // Stored on the comment so a list reserves layout space without pre-fetching
    // the image, which is what stops the sheet jumping as GIFs land.
    w: Number(animated?.width ?? 0) || 0,
    h: Number(animated?.height ?? 0) || 0,
  };
}

/** `caches.default` where it exists (Workers). Node/vitest has no Cache API. */
function edgeCache(): Cache | null {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

/**
 * `GET /api/giphy/trending` and `GET /api/giphy/search?q=` (legacy route names —
 * see the module note; the provider behind them is KLIPY).
 *
 * The cache key is built from the normalised query rather than `req.url`, so
 * "Star Wars", "star wars" and "  star wars  " are one cache entry instead of
 * three upstream calls out of a budget of 100 an hour.
 */
export async function handleKlipy(
  kind: "trending" | "search",
  req: Request,
  env: KlipyEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!env.KLIPY_API_KEY) return json({ error: "not_configured" }, 503);

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, MAX_QUERY);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || MAX_RESULTS, 1), MAX_RESULTS);
  if (kind === "search" && !q) return json({ gifs: [] });

  const cache = edgeCache();
  const key = new Request(`https://klipy.invalid/${kind}?q=${encodeURIComponent(q)}&limit=${limit}`);
  const hit = await cache?.match(key);
  if (hit) return hit;

  // The key is a PATH segment, not a query param, so it never lands in a query log.
  const upstream = new URL(`${API}/${env.KLIPY_API_KEY}/gifs/${kind}`);
  upstream.searchParams.set("per_page", String(limit));
  upstream.searchParams.set("content_filter", CONTENT_FILTER);
  upstream.searchParams.set("format_filter", FORMAT_FILTER);
  if (kind === "search") upstream.searchParams.set("q", q);

  let gifs: ReturnType<typeof toWire>[] = [];
  try {
    const res = await fetch(upstream.toString());
    if (!res.ok) return json({ error: "upstream", status: res.status }, 502);
    const data = (await res.json()) as KlipyResponse;
    gifs = (data.data?.data ?? []).map(toWire).filter((g) => g.id && g.url);
  } catch {
    return json({ error: "upstream" }, 502);
  }

  const out = json({ gifs }, 200, { "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
  const put = cache?.put(key, out.clone());
  if (put) {
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return out;
}
