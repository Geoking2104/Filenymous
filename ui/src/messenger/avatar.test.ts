import { describe, expect, it, vi } from "vitest";
import { AVATAR_MAX_BYTES, AVATAR_SIZE, encodeUnderLimit, resizeAvatar, squareCrop } from "./avatar";

const blob = (size: number, type: string) => new Blob([new Uint8Array(size)], { type });

describe("avatar resize", () => {
  it("crops the largest centred square", () => {
    expect(squareCrop(400, 300)).toEqual({ sx: 50, sy: 0, side: 300 });
    expect(squareCrop(300, 500)).toEqual({ sx: 0, sy: 100, side: 300 });
    expect(squareCrop(256, 256)).toEqual({ sx: 0, sy: 0, side: 256 });
  });

  it("returns the first 256 px WebP under 48 KB, lowering quality as needed", async () => {
    const encode = vi.fn(async (_size: number, type: string, q: number) => blob(q > 0.7 ? 90_000 : 30_000, type));
    const out = await encodeUnderLimit(encode);
    expect(out.type).toBe("image/webp");
    expect(out.size).toBeLessThanOrEqual(AVATAR_MAX_BYTES);
    expect(encode.mock.calls.every(([s]) => s === AVATAR_SIZE)).toBe(true);
    expect(encode.mock.calls.at(-1)![2]).toBeLessThan(0.7);
  });

  it("falls back to JPEG when the browser can't encode WebP (canvas returns PNG)", async () => {
    const encode = vi.fn(async (_s: number, type: string) => (type === "image/webp" ? blob(10, "image/png") : blob(20_000, "image/jpeg")));
    const out = await encodeUnderLimit(encode);
    expect(out.type).toBe("image/jpeg");
    expect(encode.mock.calls.filter(([, t]) => t === "image/webp")).toHaveLength(1);
  });

  it("shrinks the size when quality alone isn't enough, and fails past the smallest size", async () => {
    const enc1 = vi.fn(async (size: number, type: string) => blob(size >= 192 ? 60_000 : 40_000, type));
    const out = await encodeUnderLimit(enc1);
    expect(out.size).toBe(40_000);
    expect(enc1.mock.calls.at(-1)![0]).toBe(128);
    await expect(encodeUnderLimit(async (_s, type) => blob(100_000, type))).rejects.toThrow("avatar-too-big");
  });

  it("never returns the original bytes: non-images and oversized inputs are refused", async () => {
    await expect(resizeAvatar(blob(10, "text/plain"))).rejects.toThrow("avatar-not-image");
    await expect(resizeAvatar(blob(26 * 1024 * 1024, "image/jpeg"))).rejects.toThrow("avatar-input-too-big");
  });
});
