/**
 * Profile photo: square centre crop, re-encoded through a canvas to 256×256
 * WebP (JPEG when the browser can't encode WebP), at most 48 KB. Re-encoding
 * keeps only pixels, so EXIF metadata (GPS position, camera, date) is dropped;
 * the EXIF orientation is applied first so the photo isn't sideways.
 */
export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BYTES = 48 * 1024;
export const AVATAR_INPUT_MAX = 25 * 1024 * 1024;
const SIZES = [AVATAR_SIZE, 192, 128];
const TYPES = ["image/webp", "image/jpeg"] as const;
const QUALITIES = [0.86, 0.76, 0.66, 0.56, 0.46, 0.36];

export interface Crop {
  sx: number;
  sy: number;
  side: number;
}

/** Largest centred square of a w×h image. */
export function squareCrop(w: number, h: number): Crop {
  const side = Math.min(w, h);
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), side };
}

/** Encodes the cropped image at `size`×`size` in `type`; may return another type if unsupported (canvas falls back to PNG). */
export type Encoder = (size: number, type: string, quality: number) => Promise<Blob | null>;

/** Tries sizes, formats and qualities from best to smallest until the result fits the limit. */
export async function encodeUnderLimit(encode: Encoder, max = AVATAR_MAX_BYTES): Promise<Blob> {
  for (const size of SIZES) {
    for (const type of TYPES) {
      for (const q of QUALITIES) {
        const b = await encode(size, type, q);
        if (!b || b.type !== type) break; // format not supported here: next format
        if (b.size <= max) return b;
      }
    }
  }
  throw new Error("avatar-too-big");
}

function canvasFor(size: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(size, size);
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
}

async function toBlob(c: HTMLCanvasElement | OffscreenCanvas, type: string, quality: number): Promise<Blob | null> {
  if ("convertToBlob" in c) {
    try {
      return await c.convertToBlob({ type, quality });
    } catch {
      return null;
    }
  }
  return new Promise((ok) => (c as HTMLCanvasElement).toBlob(ok, type, quality));
}

export async function resizeAvatar(file: Blob): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("avatar-not-image");
  if (file.size > AVATAR_INPUT_MAX) throw new Error("avatar-input-too-big");
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("avatar-unreadable");
  }
  try {
    const crop = squareCrop(bmp.width, bmp.height);
    return await encodeUnderLimit(async (size, type, quality) => {
      const c = canvasFor(size);
      const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) return null;
      ctx.imageSmoothingQuality = "high";
      // Opaque background: JPEG has no alpha, and it keeps transparent PNGs readable.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(bmp, crop.sx, crop.sy, crop.side, crop.side, 0, 0, size, size);
      return toBlob(c, type, quality);
    });
  } finally {
    bmp.close();
  }
}
