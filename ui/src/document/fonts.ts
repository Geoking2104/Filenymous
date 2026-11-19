/**
 * Noto Sans (SIL Open Font License 1.1, see fonts/OFL.txt), subset to Latin,
 * Greek, Cyrillic and common symbols, gzip-compressed. Fetched only when a
 * PDF is generated, then cached for the session.
 */
import { inflate } from "./fontsInflate";
import type { FontSet } from "./pdfExport";
import regular from "./fonts/NotoSans-Regular.ttf.gz?url";
import bold from "./fonts/NotoSans-Bold.ttf.gz?url";
import italic from "./fonts/NotoSans-Italic.ttf.gz?url";
import boldItalic from "./fonts/NotoSans-BoldItalic.ttf.gz?url";

let cache: Promise<FontSet> | null = null;

async function get(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font ${res.status}`);
  return inflate(new Uint8Array(await res.arrayBuffer()));
}

export function loadFonts(): Promise<FontSet> {
  if (!cache) {
    cache = Promise.all([get(regular), get(bold), get(italic), get(boldItalic)]).then(([r, b, i, bi]) => ({ regular: r, bold: b, italic: i, boldItalic: bi }));
    cache.catch(() => (cache = null));
  }
  return cache;
}

/** Any image the browser can display → PNG bytes for the PDF (canvas). */
export async function imageToPng(src: string): Promise<{ bytes: Uint8Array; type: "png" } | null> {
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d")!.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), type: "png" } : null;
  } catch {
    return null;
  }
}
