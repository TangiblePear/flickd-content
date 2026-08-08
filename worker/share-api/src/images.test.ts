import { describe, expect, it } from "vitest";
import { isAnimatedImage, sniffImageType } from "./index";

/** Header bytes only — the sniff never reads past them. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const GIF89 = new Uint8Array([...Buffer.from("GIF89a"), 0x01, 0x00]);
const GIF87 = new Uint8Array([...Buffer.from("GIF87a"), 0x01, 0x00]);

/**
 * A WebP header. `vp8x` adds the extended chunk; `animBit` sets the animation flag
 * inside it. A plain (lossy) WebP has neither and cannot animate.
 */
function webp({ vp8x = false, animBit = false } = {}): Uint8Array {
  const b = new Uint8Array(32);
  b.set(Buffer.from("RIFF"), 0);
  b.set(Buffer.from("WEBP"), 8);
  b.set(Buffer.from(vp8x ? "VP8X" : "VP8 "), 12);
  if (animBit) b[20] = 0x02;
  return b;
}

describe("sniffImageType", () => {
  it("recognises the four supported types by magic bytes", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(webp())).toBe("image/webp");
    expect(sniffImageType(GIF89)).toBe("image/gif");
    expect(sniffImageType(GIF87)).toBe("image/gif");
  });

  it("rejects anything else, including a near-miss header", () => {
    expect(sniffImageType(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
    // "GIF88a" is not a real version and must not be waved through.
    expect(sniffImageType(new Uint8Array(Buffer.from("GIF88a")))).toBeNull();
    // RIFF container that is not WebP (a WAV, say).
    const riff = new Uint8Array(16);
    riff.set(Buffer.from("RIFF"), 0);
    riff.set(Buffer.from("WAVE"), 8);
    expect(sniffImageType(riff)).toBeNull();
  });
});

describe("isAnimatedImage", () => {
  it("treats every GIF as animated, including a still one", () => {
    // Deliberate over-inclusion: telling them apart needs a block walk, and the cheap
    // approximations over-count, which would gate a still image behind a subscription.
    expect(isAnimatedImage("image/gif", GIF89)).toBe(true);
    expect(isAnimatedImage("image/gif", GIF87)).toBe(true);
  });

  it("reads the WebP animation flag exactly", () => {
    expect(isAnimatedImage("image/webp", webp({ vp8x: true, animBit: true }))).toBe(true);
    // VP8X present but the animation bit clear — a still extended WebP.
    expect(isAnimatedImage("image/webp", webp({ vp8x: true, animBit: false }))).toBe(false);
    // No VP8X chunk at all: cannot animate by construction.
    expect(isAnimatedImage("image/webp", webp())).toBe(false);
  });

  it("is false for types that cannot animate", () => {
    expect(isAnimatedImage("image/jpeg", JPEG)).toBe(false);
    expect(isAnimatedImage("image/png", PNG)).toBe(false);
  });

  it("does not read past the end of a truncated buffer", () => {
    expect(isAnimatedImage("image/webp", new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe(false);
  });
});
