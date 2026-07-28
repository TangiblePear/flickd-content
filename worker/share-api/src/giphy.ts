// ── GIPHY proxy ─────────────────────────────────────────────────────────────
// Trending and search for the comment GIF picker, proxied rather than called
// from the app, for two independent reasons — either alone would justify it.
//
//   1. ⚠️ **The key must never ship in the APK.** An API key in an APK is
//      trivially extractable, and this one is attached to a paid, negotiated
//      production tier.
//   2. ⚠️ **The free beta tier is 100 API calls PER HOUR, per key — not per
//      user.** That is ~1.6 a minute across everybody, and a picker fires a
//      search per debounced keystroke plus trending on open. It is a development
//      tier, and only caching makes it survivable.
//
// Picker-open shows *trending*, which is identical for every user, so one
// upstream call an hour serves everybody. Popular search terms cache the same
// way. Same edge-cache pattern as the public comment list.
//
// **Tenor is not an option.** Checked 2026-07-27: "As of Jan 2026, we are no
// longer accepting new API clients." The free, Google-owned, Gboard-backed
// alternative is closed, which is why `comments.media_provider` staying swappable
// matters more than it looks.
//
// TODO (owner): confirm GIPHY's terms on permitted cache duration before relying
// on [CACHE_SECONDS], and apply for the production key — that is a human review
// plus a pricing conversation, not a button.

export interface GiphyEnv {
  /** A SECRET: `wrangler secret put GIPHY_API_KEY`. Unset ⇒ these routes 503. */
  GIPHY_API_KEY?: string;
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

const API = "https://api.giphy.com/v1/gifs";
/** An hour: the beta tier's whole budget is 100 calls in one, so this IS the rate limit. */
const CACHE_SECONDS = 3600;
const MAX_RESULTS = 24;
const MAX_QUERY = 60;

/**
 * ⚠️ **`rating` must be set explicitly. Omitting it returns ALL ratings**, `r`
 * included — the parameter is not "unfiltered means safe default".
 *
 * `g` is why comment GIFs need no Vision SafeSearch scan: this is a curated
 * catalogue with a rating filter, not arbitrary bytes, and scanning pre-rated
 * catalogue content buys nothing. Context abuse — a GIF that is fine alone and
 * abusive as a reply — is a reporting problem, and the report flow already
 * covers it.
 */
const RATING = "g";

interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
}

interface GiphyGif {
  id?: string;
  title?: string;
  images?: {
    fixed_width?: GiphyImage;
    fixed_width_still?: GiphyImage;
  };
}

/**
 * Trimmed to what the picker and `comments.media_*` actually store. The raw GIPHY
 * payload is ~40 renditions per GIF; forwarding it would make a 24-result page
 * hundreds of kilobytes for six fields of use.
 *
 * `still` is not an optimisation. GIFs must NOT autoplay in a scrolling list —
 * that is a battery and data complaint waiting to happen — so the list renders
 * the still and only swaps to [url] on tap.
 */
function toWire(g: GiphyGif) {
  const animated = g.images?.fixed_width;
  const still = g.images?.fixed_width_still;
  return {
    id: g.id ?? "",
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
 * `GET /api/giphy/trending` and `GET /api/giphy/search?q=`.
 *
 * The cache key is built from the normalised query rather than `req.url`, so
 * "Star Wars", "star wars" and "  star wars  " are one cache entry instead of
 * three upstream calls out of a budget of 100 an hour.
 */
export async function handleGiphy(
  kind: "trending" | "search",
  req: Request,
  env: GiphyEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!env.GIPHY_API_KEY) return json({ error: "not_configured" }, 503);

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, MAX_QUERY);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || MAX_RESULTS, 1), MAX_RESULTS);
  if (kind === "search" && !q) return json({ gifs: [] });

  const cache = edgeCache();
  const key = new Request(`https://giphy.invalid/${kind}?q=${encodeURIComponent(q)}&limit=${limit}`);
  const hit = await cache?.match(key);
  if (hit) return hit;

  const upstream = new URL(`${API}/${kind}`);
  upstream.searchParams.set("api_key", env.GIPHY_API_KEY);
  upstream.searchParams.set("limit", String(limit));
  upstream.searchParams.set("rating", RATING);
  if (kind === "search") upstream.searchParams.set("q", q);

  let gifs: ReturnType<typeof toWire>[] = [];
  try {
    const res = await fetch(upstream.toString());
    if (!res.ok) return json({ error: "upstream", status: res.status }, 502);
    const data = (await res.json()) as { data?: GiphyGif[] };
    gifs = (data.data ?? []).map(toWire).filter((g) => g.id && g.url);
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
