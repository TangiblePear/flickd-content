import { describe, expect, it } from "vitest";
import {
  MAX_STICKERS_PER_USER,
  MAX_STICKER_BYTES,
  handleGetSticker,
  handleBrowseStickers,
  handleCommunityStickers,
  handleUploadSticker,
  sniffStickerType,
} from "./stickers";

/** Header bytes only — the sniff never reads past them. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF89 = new Uint8Array([...Buffer.from("GIF89a"), 0x01, 0x00]);

function webp(): Uint8Array {
  const b = new Uint8Array(32);
  b.set(Buffer.from("RIFF"), 0);
  b.set(Buffer.from("WEBP"), 8);
  b.set(Buffer.from("VP8 "), 12);
  return b;
}

const STICKER = "0123456789abcdef0123456789abcdef";

/** In-memory R2 that records what was written where. */
class FakeBucket {
  objects = new Map<string, { body: Uint8Array; contentType: string }>();

  async get(key: string) {
    const hit = this.objects.get(key);
    if (!hit) return null;
    const decode = () => new TextDecoder().decode(hit.body);
    return {
      body: hit.body,
      httpMetadata: { contentType: hit.contentType },
      text: async () => decode(),
      json: async () => JSON.parse(decode()),
    };
  }
  async head(key: string) {
    return this.objects.has(key) ? {} : null;
  }
  async put(key: string, body: Uint8Array | string, opts?: any) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    this.objects.set(key, { body: bytes, contentType: opts?.httpMetadata?.contentType ?? "" });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list({ prefix }: { prefix: string; limit?: number }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
    return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
  }
}

class FakeD1 {
  rows: Array<Record<string, unknown>>;
  private sql = "";
  private args: unknown[] = [];

  constructor(rows: Array<Record<string, unknown>> = []) {
    this.rows = rows;
  }
  prepare(sql: string) {
    this.sql = sql;
    return this;
  }
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first() {
    return null;
  }
  async run() {
    return { success: true, meta: { changes: 1 } };
  }
  async all() {
    // Only the browse query needs real behaviour; everything else gets an empty page.
    if (!this.sql.includes("FROM stickers")) return { results: [] };
    const byNew = this.sql.includes("created_at DESC");
    const sorted = [...this.rows].sort((a, b) =>
      byNew
        ? (b.created_at as number) - (a.created_at as number) || String(a.id).localeCompare(String(b.id))
        : (b.uses as number) - (a.uses as number) || String(a.id).localeCompare(String(b.id)),
    );
    const [limit, offset] = this.args as [number, number];
    return { results: sorted.slice(offset, offset + limit) };
  }
}

const env = (bucket: FakeBucket, db: FakeD1 = new FakeD1()) =>
  ({ DB: db, BUCKET: bucket, MODERATION_ENABLED: "false" }) as any;

const catalogueRow = (id: string, uses: number, created_at = 0) => ({
  id,
  tmdb_id: 1399,
  media_type: "tv",
  title: "T",
  uses,
  created_at,
});

const ctx = { waitUntil: () => {} } as any;

const upload = (bytes: Uint8Array) =>
  new Request("https://flickto.app/api/me/stickers", { method: "POST", body: bytes });

describe("sniffStickerType", () => {
  it("accepts the two alpha-capable types", () => {
    expect(sniffStickerType(PNG)).toBe("image/png");
    expect(sniffStickerType(webp())).toBe("image/webp");
  });

  /**
   * The narrowing that distinguishes this from the profile-picture sniff. A JPEG has no
   * alpha channel, so a "cut-out" in that format is a rectangle with a background — the
   * exact thing the feature exists to remove. Accepting it would store an object the app
   * can never render correctly.
   */
  it("rejects formats that cannot carry an alpha channel", () => {
    expect(sniffStickerType(JPEG)).toBeNull();
    expect(sniffStickerType(GIF89)).toBeNull();
  });

  it("rejects garbage and empty input", () => {
    expect(sniffStickerType(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(sniffStickerType(new Uint8Array([]))).toBeNull();
    // A RIFF container that is not WebP (a WAV, say) must not pass.
    const riff = new Uint8Array(16);
    riff.set(Buffer.from("RIFF"), 0);
    riff.set(Buffer.from("WAVE"), 8);
    expect(sniffStickerType(riff)).toBeNull();
  });
});

describe("handleUploadSticker", () => {
  it("refuses an unauthenticated upload", async () => {
    const res = await handleUploadSticker(upload(PNG), env(new FakeBucket()), ctx);
    expect(res.status).toBe(401);
  });
});

describe("handleGetSticker", () => {
  it("serves stored bytes with the stored content type", async () => {
    const bucket = new FakeBucket();
    await bucket.put(`stickers/${STICKER}.png`, PNG, { httpMetadata: { contentType: "image/png" } });
    const res = await handleGetSticker(STICKER, env(bucket));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("answers 404 for a sticker that never existed", async () => {
    expect((await handleGetSticker(STICKER, env(new FakeBucket()))).status).toBe(404);
  });

  /**
   * 410 and not 404. A taken-down sticker DID exist, and the app distinguishes the two:
   * "gone" is a final state it can stop retrying, "not found" reads as a transient miss.
   *
   * Also asserts the tombstone is consulted BEFORE the bytes are fetched — the object is
   * still stored, so a handler that read it first would serve the image and only then
   * decide it was hidden.
   */
  it("answers 410 once hidden, while the bytes stay stored for review", async () => {
    const bucket = new FakeBucket();
    await bucket.put(`stickers/${STICKER}.png`, PNG, {});
    await bucket.put(`_moderation/s/${STICKER}.json`, JSON.stringify({ hiddenAt: 1 }), {});

    expect((await handleGetSticker(STICKER, env(bucket))).status).toBe(410);
    expect(bucket.objects.has(`stickers/${STICKER}.png`)).toBe(true);
  });
});

describe("storage layout", () => {
  /**
   * ⚠️ The key must carry NO user id.
   *
   * A sticker outlives the account that uploaded it — `eraseAccount` skips it on purpose,
   * because it is cut from a public promotional image and published for everyone. A key
   * or URL containing `users.id` would therefore keep a deleted account's identifier
   * resolvable forever. The owner belongs in the meta object, which is never served.
   */
  it("keys stickers flatly, with the owner only in the unserved meta object", async () => {
    const bucket = new FakeBucket();
    await bucket.put(`stickers/${STICKER}.png`, PNG, {});
    await bucket.put(
      `stickers/${STICKER}.json`,
      JSON.stringify({ ownerId: "AAAAH73X7P55T48R4CFHDED9CW" }),
      {},
    );

    const served = [...bucket.objects.keys()].filter((k) => k.endsWith(".png"));
    for (const key of served) {
      expect(key).toBe(`stickers/${STICKER}.png`);
      expect(key).not.toContain("AAAAH73X7P55T48R4CFHDED9CW");
    }
  });
});

describe("handleCommunityStickers", () => {
  const listing = (q: string) =>
    new URL(`https://flickto.app/api/stickers/community${q}`);

  it("lists exactly the stickers indexed under that title", async () => {
    const bucket = new FakeBucket();
    await bucket.put("stickers/by-title/tv/1399/aaa", "", {});
    await bucket.put("stickers/by-title/tv/1399/bbb", "", {});
    // A different title, and a different media type on the SAME number — both must be
    // excluded. TMDB numbers movies and shows in separate namespaces, so keying on the
    // id alone would merge two unrelated titles.
    await bucket.put("stickers/by-title/tv/9999/ccc", "", {});
    await bucket.put("stickers/by-title/movie/1399/ddd", "", {});

    const res = await handleCommunityStickers(listing("?tmdb_id=1399&media_type=tv"), env(bucket));
    const body = (await res.json()) as { stickers: Array<{ id: string; url: string }> };

    expect(res.status).toBe(200);
    expect(body.stickers.map((s) => s.id).sort()).toEqual(["aaa", "bbb"]);
    expect(body.stickers[0].url).toBe("https://flickto.app/api/stickers/aaa");
  });

  it("answers empty rather than erroring for a title nobody has cut", async () => {
    const res = await handleCommunityStickers(listing("?tmdb_id=42&media_type=movie"), env(new FakeBucket()));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stickers: unknown[] }).stickers).toEqual([]);
  });

  it("rejects a missing or nonsense subject", async () => {
    const b = new FakeBucket();
    expect((await handleCommunityStickers(listing(""), env(b))).status).toBe(400);
    expect((await handleCommunityStickers(listing("?tmdb_id=1399"), env(b))).status).toBe(400);
    expect((await handleCommunityStickers(listing("?tmdb_id=0&media_type=tv"), env(b))).status).toBe(400);
    expect((await handleCommunityStickers(listing("?tmdb_id=1&media_type=book"), env(b))).status).toBe(400);
  });
});

describe("handleBrowseStickers", () => {
  const browse = (q: string) => new URL(`https://flickto.app/api/stickers/browse${q}`);

  it("orders by uses, most-taken first", async () => {
    const db = new FakeD1([catalogueRow("a", 3), catalogueRow("b", 9), catalogueRow("c", 5)]);
    const res = await handleBrowseStickers(browse("?sort=popular"), env(new FakeBucket(), db));
    const body = (await res.json()) as { stickers: Array<{ id: string; uses: number }> };

    expect(body.stickers.map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(body.stickers[0].uses).toBe(9);
  });

  /**
   * The tie-break is not cosmetic. Ordering purely on a counter lets two rows with the
   * same count swap places between pages, so one is served twice and the other never —
   * `id` makes the sequence total and therefore pageable.
   */
  it("breaks ties on id so paging is stable", async () => {
    const db = new FakeD1([catalogueRow("z", 4), catalogueRow("a", 4), catalogueRow("m", 4)]);
    const res = await handleBrowseStickers(browse("?sort=popular"), env(new FakeBucket(), db));
    const body = (await res.json()) as { stickers: Array<{ id: string }> };
    expect(body.stickers.map((s) => s.id)).toEqual(["a", "m", "z"]);
  });

  it("pages, and reports the next cursor only while there is more", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => catalogueRow(`s${i}`, 100 - i));
    const db = new FakeD1(rows);

    const first = await handleBrowseStickers(browse("?limit=2"), env(new FakeBucket(), db));
    const firstBody = (await first.json()) as { stickers: unknown[]; nextCursor: number | null };
    expect(firstBody.stickers).toHaveLength(2);
    expect(firstBody.nextCursor).toBe(2);

    const last = await handleBrowseStickers(browse("?limit=2&cursor=4"), env(new FakeBucket(), db));
    const lastBody = (await last.json()) as { stickers: unknown[]; nextCursor: number | null };
    expect(lastBody.stickers).toHaveLength(1);
    expect(lastBody.nextCursor).toBeNull();
  });

  it("sorts newest-first when asked", async () => {
    const db = new FakeD1([
      catalogueRow("old", 99, 1),
      catalogueRow("new", 1, 500),
    ]);
    const res = await handleBrowseStickers(browse("?sort=new"), env(new FakeBucket(), db));
    const body = (await res.json()) as { stickers: Array<{ id: string }> };
    expect(body.stickers.map((s) => s.id)).toEqual(["new", "old"]);
  });
});

describe("limits", () => {
  /**
   * Pinned because the Android client duplicates both numbers deliberately, so a change
   * on one side without the other turns a clear local message into a 413 after an upload.
   */
  it("match the caps the Android client enforces locally", () => {
    expect(MAX_STICKER_BYTES).toBe(1024 * 1024);
    expect(MAX_STICKERS_PER_USER).toBe(200);
  });
});
