/**
 * In-browser metadata removal before a report is sealed. Lossless: the file
 * bytes are kept, only metadata containers are dropped or blanked.
 *
 * - JPEG: APP1 (EXIF incl. GPS, XMP), APP3–APP13 (IPTC/Photoshop…), APP15 and
 *   comments are removed. APP0 (JFIF), APP2 (ICC colour profile) and APP14
 *   (Adobe colour transform) are kept because decoding needs them. The EXIF
 *   orientation goes with EXIF: a phone photo may display rotated.
 * - PNG: tEXt, zTXt, iTXt, eXIf and tIME chunks are removed.
 * - WebP: EXIF and XMP chunks are removed and the VP8X flags cleared.
 * - PDF: the values of the Info dictionary keys (Author, Creator, Producer,
 *   Title, Subject, Keywords, dates…) and uncompressed XMP packets are blanked
 *   in place (same length, so the xref table stays valid). Compressed XMP,
 *   object streams, annotations, form data and the visible content are not
 *   analysed: those are reported as "remaining".
 * - Anything else is sent as is, with a clear warning.
 */
import type { FileMeta } from "./crypto";

export interface Stripped { data: Uint8Array; meta: FileMeta }

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function stripJpeg(b: Uint8Array): Stripped {
  const removed = new Set<string>();
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xda || m === 0xd9) break; // start of scan: the rest is image data
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    const seg = b.subarray(i, i + 2 + len);
    const id = ascii(b, i + 4, 30);
    let drop = false;
    if (m === 0xe1) { drop = true; if (id.startsWith("Exif")) { removed.add("EXIF"); if (hasGps(seg)) removed.add("GPS"); } else removed.add(id.includes("adobe") ? "XMP" : "APP1"); }
    else if ((m >= 0xe3 && m <= 0xed) || m === 0xef) { drop = true; removed.add(m === 0xed ? "IPTC/Photoshop" : `APP${m - 0xe0}`); }
    else if (m === 0xfe) { drop = true; removed.add("COM"); }
    if (!drop) out.push(seg);
    i += 2 + len;
  }
  out.push(b.subarray(i));
  const data = join(out);
  return { data, meta: { status: removed.size ? "cleaned" : "nothing-found", removed: [...removed], remaining: [] } };
}

function hasGps(seg: Uint8Array): boolean {
  // GPS IFD pointer tag 0x8825, either byte order.
  for (let j = 0; j + 1 < seg.length; j++) if ((seg[j] === 0x88 && seg[j + 1] === 0x25) || (seg[j] === 0x25 && seg[j + 1] === 0x88)) return true;
  return false;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
export function stripPng(b: Uint8Array): Stripped {
  const removed = new Set<string>();
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (PNG_DROP.has(type)) removed.add(type);
    else out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return { data: join(out), meta: { status: removed.size ? "cleaned" : "nothing-found", removed: [...removed], remaining: [] } };
}

export function stripWebp(b: Uint8Array): Stripped {
  const removed = new Set<string>();
  const out: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const size = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    const end = i + 8 + size + (size & 1);
    if (type === "EXIF" || type === "XMP ") removed.add(type.trim());
    else {
      const chunk = b.slice(i, end);
      if (type === "VP8X") chunk[8] &= ~0x0c; // clear EXIF (0x08) and XMP (0x04) flags
      out.push(chunk);
    }
    i = end;
  }
  const body = join(out);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  return { data: join([head, body]), meta: { status: removed.size ? "cleaned" : "nothing-found", removed: [...removed], remaining: [] } };
}

const PDF_KEYS = ["Author", "Creator", "Producer", "Title", "Subject", "Keywords", "CreationDate", "ModDate", "Company", "Manager", "SourceModified", "Trapped"];
export function stripPdf(src: Uint8Array): Stripped {
  const b = src.slice();
  const s = latin1(b);
  const removed = new Set<string>();
  const re = new RegExp(`/(${PDF_KEYS.join("|")})\\s*(\\(|<(?!<))`, "g");
  for (let m; (m = re.exec(s)); ) {
    let j = m.index + m[0].length;
    if (m[2] === "(") {
      let depth = 1;
      for (; j < s.length && depth > 0; j++) {
        const c = s[j];
        if (c === "\\") { b[j] = 0x20; j++; if (j < s.length) b[j] = 0x20; continue; }
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) break; }
        b[j] = 0x20;
      }
    } else {
      for (; j < s.length && s[j] !== ">"; j++) if (/[0-9A-Fa-f]/.test(s[j])) b[j] = 0x30;
    }
    removed.add(m[1]);
  }
  const xmpOpen = /<x:xmpmeta\b/g;
  for (let m; (m = xmpOpen.exec(s)); ) {
    const end = s.indexOf("</x:xmpmeta>", m.index);
    if (end < 0) continue;
    b.fill(0x20, m.index, end + "</x:xmpmeta>".length);
    removed.add("XMP");
  }
  const remaining: string[] = [];
  const compressedXmp = /\/Type\s*\/Metadata[^>]*\/Filter|\/Filter[^>]*\/Type\s*\/Metadata/.test(s) && !removed.has("XMP");
  if (compressedXmp) remaining.push("xmp-compressed");
  if (/\/Type\s*\/ObjStm/.test(s)) remaining.push("objstm");
  if (/\/Annots/.test(s)) remaining.push("annots");
  remaining.push("content");
  return { data: b, meta: { status: compressedXmp || remaining.length > 1 ? "partial" : removed.size ? "cleaned" : "nothing-found", removed: [...removed], remaining } };
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

export function sniff(b: Uint8Array): "jpeg" | "png" | "webp" | "pdf" | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return "png";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (ascii(b, 0, 5) === "%PDF-") return "pdf";
  return null;
}

/** Strips what can be stripped; never throws (falls back to "unsupported"). */
export function stripMetadata(bytes: Uint8Array): Stripped {
  try {
    switch (sniff(bytes)) {
      case "jpeg": return stripJpeg(bytes);
      case "png": return stripPng(bytes);
      case "webp": return stripWebp(bytes);
      case "pdf": return stripPdf(bytes);
    }
  } catch {
    /* malformed file: send as is, with a warning */
  }
  return { data: bytes, meta: { status: "unsupported", removed: [], remaining: ["all"] } };
}
