// The KLIPY proxy exists because of two hard limits, and the tests here are about
// those limits rather than about GIFs: the content_filter that is unsafe by
// omission, and the 100-calls-per-hour budget that only query normalisation and
// caching make survivable. The routes keep their legacy `/api/giphy/*` names.

import { describe, it, expect, vi, afterEach } from "vitest";
import { handleKlipy } from "./klipy";

const ctx = { waitUntil: () => {} } as any;
const env = { KLIPY_API_KEY: "test-key" } as any;

const get = (path: string) => new Request(`https://flickto.app${path}`);

/** Captures the upstream URLs so the assertions can be about what was requested. */
function stubKlipy(payload: unknown = { data: { data: [] } }) {
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

// KLIPY's shape: results nested two levels deep, renditions bucketed by size then
// format. Only the `sm` gif + jpg are read; the rest is there to prove it's ignored.
const GIF = {
  data: {
    data: [
      {
        id: 8041071659142944,
        slug: "hello-hi-662",
        title: "a gif",
        file: {
          hd: { gif: { url: "https://static.klipy.com/hd.gif", width: 498, height: 498 } },
          sm: {
            gif: { url: "https://static.klipy.com/sm.gif", width: 200, height: 150 },
            jpg: { url: "https://static.klipy.com/sm.jpg", width: 200, height: 150 },
          },
        },
      },
    ],
  },
};

describe("the KLIPY proxy", () => {
  it("is 503 with no key rather than calling upstream unauthenticated", async () => {
    const calls = stubKlipy();
    const res = await handleKlipy("trending", get("/api/giphy/trending"), {} as any, ctx);
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("⚠️ always sets content_filter=high — omitting it would return unsafe ratings", async () => {
    const calls = stubKlipy();
    await handleKlipy("trending", get("/api/giphy/trending"), env, ctx);
    expect(calls[0]).toContain("content_filter=high");
  });

  it("puts the key in the PATH, never the query string or the client response", async () => {
    const calls = stubKlipy(GIF);
    const res = await handleKlipy("search", get("/api/giphy/search?q=cat"), env, ctx);
    // Key is a path segment of the upstream URL…
    expect(calls[0]).toContain("/api/v1/test-key/gifs/search");
    // …and reaches neither the query string nor the client.
    expect(calls[0]).not.toContain("api_key=");
    expect(JSON.stringify(await res.json())).not.toContain("test-key");
  });

  it("trims the payload to what a comment actually stores, still frame included", async () => {
    stubKlipy(GIF);
    const res = await handleKlipy("search", get("/api/giphy/search?q=cat"), env, ctx);
    // The `sm` bucket matches GIPHY's old fixed_width; the still `jpg` is what the
    // grid renders, swapping to the animated `url` on tap (no autoplay in a list).
    expect((await res.json()).gifs).toEqual([
      {
        id: "hello-hi-662",
        title: "a gif",
        url: "https://static.klipy.com/sm.gif",
        still: "https://static.klipy.com/sm.jpg",
        w: 200,
        h: 150,
      },
    ]);
  });

  it("normalises the query, so casing and padding do not each cost an upstream call", async () => {
    const calls = stubKlipy(GIF);
    await handleKlipy("search", get("/api/giphy/search?q=%20Star%20Wars%20"), env, ctx);
    // 100 calls an hour is the whole budget, across every user.
    expect(calls[0]).toContain("q=star+wars");
  });

  it("answers an empty search without spending a call", async () => {
    const calls = stubKlipy();
    const res = await handleKlipy("search", get("/api/giphy/search?q=%20%20"), env, ctx);
    expect((await res.json()).gifs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("carries Cache-Control, which is what makes the test tier survivable", async () => {
    stubKlipy(GIF);
    const res = await handleKlipy("trending", get("/api/giphy/trending"), env, ctx);
    // Trending is identical for every user, so one upstream call an hour serves
    // everybody in the colo.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("reports an upstream failure as 502 rather than an empty picker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const res = await handleKlipy("trending", get("/api/giphy/trending"), env, ctx);
    expect(res.status).toBe(502);
  });
});
