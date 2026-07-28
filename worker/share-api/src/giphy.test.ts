// The GIPHY proxy exists because of two hard limits, and the tests here are about
// those limits rather than about GIFs: the rating parameter that is unsafe by
// omission, and the 100-calls-per-hour budget that only query normalisation and
// caching make survivable.

import { describe, it, expect, vi, afterEach } from "vitest";
import { handleGiphy } from "./giphy";

const ctx = { waitUntil: () => {} } as any;
const env = { GIPHY_API_KEY: "test-key" } as any;

const get = (path: string) => new Request(`https://flickto.app${path}`);

/** Captures the upstream URLs so the assertions can be about what was requested. */
function stubGiphy(payload: unknown = { data: [] }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const GIF = {
  data: [
    {
      id: "abc",
      title: "a gif",
      images: {
        fixed_width: { url: "https://media.giphy.com/abc.gif", width: "200", height: "150" },
        fixed_width_still: { url: "https://media.giphy.com/abc_s.gif", width: "200", height: "150" },
      },
    },
  ],
};

describe("the GIPHY proxy", () => {
  it("is 503 with no key rather than calling upstream unauthenticated", async () => {
    const calls = stubGiphy();
    const res = await handleGiphy("trending", get("/api/giphy/trending"), {} as any, ctx);
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("⚠️ always sets rating=g — omitting the parameter returns ALL ratings", async () => {
    const calls = stubGiphy();
    await handleGiphy("trending", get("/api/giphy/trending"), env, ctx);
    expect(calls[0]).toContain("rating=g");
  });

  it("never lets the key reach the client", async () => {
    stubGiphy(GIF);
    const res = await handleGiphy("search", get("/api/giphy/search?q=cat"), env, ctx);
    expect(JSON.stringify(await res.json())).not.toContain("test-key");
  });

  it("trims the payload to what a comment actually stores, still frame included", async () => {
    stubGiphy(GIF);
    const res = await handleGiphy("search", get("/api/giphy/search?q=cat"), env, ctx);
    // The still is not an optimisation: GIFs must not autoplay in a scrolling
    // list, so the row renders this and swaps to `url` on tap.
    expect((await res.json()).gifs).toEqual([
      {
        id: "abc",
        title: "a gif",
        url: "https://media.giphy.com/abc.gif",
        still: "https://media.giphy.com/abc_s.gif",
        w: 200,
        h: 150,
      },
    ]);
  });

  it("normalises the query, so casing and padding do not each cost an upstream call", async () => {
    const calls = stubGiphy(GIF);
    await handleGiphy("search", get("/api/giphy/search?q=%20Star%20Wars%20"), env, ctx);
    // 100 calls an hour is the whole budget, across every user.
    expect(calls[0]).toContain("q=star+wars");
  });

  it("answers an empty search without spending a call", async () => {
    const calls = stubGiphy();
    const res = await handleGiphy("search", get("/api/giphy/search?q=%20%20"), env, ctx);
    expect((await res.json()).gifs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("carries Cache-Control, which is what makes the beta tier survivable", async () => {
    stubGiphy(GIF);
    const res = await handleGiphy("trending", get("/api/giphy/trending"), env, ctx);
    // Trending is identical for every user, so one upstream call an hour serves
    // everybody in the colo.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("reports an upstream failure as 502 rather than an empty picker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const res = await handleGiphy("trending", get("/api/giphy/trending"), env, ctx);
    expect(res.status).toBe(502);
  });
});
