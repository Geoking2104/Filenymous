/**
 * The active text document, kept in this browser only (IndexedDB) so it
 * survives closing the tab or the browser. Pasted images are stored apart
 * from the HTML (store "blobs"), so a photo no longer overflows the ~5 MB
 * localStorage quota that silently broke the old draft.
 *
 * PDFs are NOT persisted here (decision 1, 20/11/2026: PDF memory is opt-in,
 * coming in a later PR).
 */
import { idbAvailable, idbClear, idbGet, idbKeys, idbWrite, isQuotaError } from "./idb";
import { readMeta, writeMeta } from "./activeDoc";

/** Pre-IndexedDB draft (localStorage), migrated once then removed. */
export const LEGACY_KEY = "fny.document.draft.v1";
const SESSION = "active-text";
const REF = "fny-blob:";
const DATA_IMG = /src="(data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))"/gi;

export interface Draft {
  name: string;
  html: string;
  /** Last modification. */
  at: number;
  /** Last "Save as" PDF/MD; absent if never exported. */
  exportedAt?: number;
}

interface SessionRecord {
  kind: "text";
  name: string;
  /** HTML whose images point to `fny-blob:<key>`. */
  html: string;
  at: number;
  exportedAt?: number;
  images: string[];
}

interface ImageRecord {
  type: string;
  bytes: ArrayBuffer;
}

export type SaveResult = { ok: true; at: number } | { ok: false; reason: "quota" | "unavailable" | "stale" };

/* Writes run one after another, in call order (a save queued before an export mark lands first). */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

/* Bumped by clearDraft: a save scheduled before "Close and forget" must not resurrect the document. */
let generation = 0;
export function draftGeneration(): number {
  return generation;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** FNV-1a 64-bit over the data URL: a stable key, computed synchronously. */
export function imageKey(dataUrl: string): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0xcbf29ce4 | 0;
  for (let i = 0; i < dataUrl.length; i++) {
    const c = dataUrl.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 7);
  }
  return `img-${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}-${dataUrl.length.toString(36)}`;
}

/** Splits inline images out of the HTML: `src="data:…"` → `src="fny-blob:<key>"`. */
export function extractImages(html: string): { html: string; images: Map<string, ImageRecord> } {
  const images = new Map<string, ImageRecord>();
  const out = html.replace(DATA_IMG, (_m, url: string, type: string, b64: string) => {
    const key = imageKey(url);
    if (!images.has(key)) {
      const bytes = b64ToBytes(b64);
      images.set(key, { type: type.toLowerCase(), bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    }
    return `src="${REF}${key}"`;
  });
  return { html: out, images };
}

/** Puts the images back as data URLs (what the editor and the PDF export use). Missing ones are dropped. */
export function inlineImages(html: string, get: (key: string) => ImageRecord | undefined): string {
  return html.replace(/<img\b[^>]*?src="fny-blob:([A-Za-z0-9-]+)"[^>]*>/g, (tag, key: string) => {
    const rec = get(key);
    if (!rec) return "";
    return tag.replace(`${REF}${key}`, `data:${rec.type};base64,${bytesToB64(new Uint8Array(rec.bytes))}`);
  });
}

function readLegacy(): Draft | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return typeof d?.html === "string" && typeof d?.name === "string" ? { name: d.name, html: d.html, at: Number(d.at) || Date.now() } : null;
  } catch {
    return null;
  }
}

function dropLegacy() {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}

async function write(d: { name: string; html: string; at: number; exportedAt?: number }): Promise<void> {
  const { html, images } = extractImages(d.html);
  const existing = new Set(await idbKeys("blobs"));
  const ops: Parameters<typeof idbWrite>[0] = [];
  for (const [key, rec] of images) if (!existing.has(key)) ops.push({ store: "blobs", key, value: rec });
  // Images no longer in the document are dropped in the same transaction.
  for (const key of existing) if (!images.has(key)) ops.push({ store: "blobs", key, del: true });
  const record: SessionRecord = { kind: "text", name: d.name, html, at: d.at, exportedAt: d.exportedAt, images: [...images.keys()] };
  ops.push({ store: "sessions", key: SESSION, value: record });
  await idbWrite(ops);
  writeMeta({ name: d.name, updatedAt: d.at, exportedAt: d.exportedAt });
}

/** The persisted text document, or null. Migrates the old localStorage draft on first call. */
export function loadDraft(): Promise<Draft | null> {
  return serial(async () => {
    if (!idbAvailable()) return readLegacy();
    try {
      let rec = await idbGet<SessionRecord>("sessions", SESSION);
      const legacy = readLegacy();
      if (legacy) {
        if (!rec || legacy.at > rec.at) {
          await write(legacy);
          rec = await idbGet<SessionRecord>("sessions", SESSION);
        }
        dropLegacy();
      }
      if (!rec) {
        if (readMeta()) writeMeta(null);
        return null;
      }
      const imgs = new Map<string, ImageRecord>();
      for (const key of rec.images ?? []) {
        const r = await idbGet<ImageRecord>("blobs", key);
        if (r) imgs.set(key, r);
      }
      const meta = readMeta();
      if (!meta || meta.updatedAt !== rec.at || meta.exportedAt !== rec.exportedAt) writeMeta({ name: rec.name, updatedAt: rec.at, exportedAt: rec.exportedAt });
      return { name: rec.name, html: inlineImages(rec.html, (k) => imgs.get(k)), at: rec.at, exportedAt: rec.exportedAt };
    } catch {
      return readLegacy();
    }
  });
}

/**
 * Saves the active text document (a modification: `at` = now, export mark kept).
 * `gen` is draftGeneration() when the save was scheduled; a stale one is ignored.
 */
export function saveDraft(d: { name: string; html: string }, gen = generation): Promise<SaveResult> {
  return serial(async (): Promise<SaveResult> => {
    if (gen !== generation) return { ok: false, reason: "stale" };
    if (!idbAvailable()) return { ok: false, reason: "unavailable" };
    try {
      const prev = await idbGet<SessionRecord>("sessions", SESSION);
      // Strictly after the last export, even within the same millisecond.
      const at = Math.max(Date.now(), (prev?.exportedAt ?? 0) + 1);
      await write({ name: d.name, html: d.html, at, exportedAt: prev?.exportedAt });
      dropLegacy();
      return { ok: true, at };
    } catch (e) {
      return { ok: false, reason: isQuotaError(e) ? "quota" : "unavailable" };
    }
  });
}

/** "Save as" PDF/MD done: the document stays active, but the badge goes away. */
export function markDraftExported(name?: string): Promise<void> {
  return serial(async () => {
    if (!idbAvailable()) return;
    try {
      const prev = await idbGet<SessionRecord>("sessions", SESSION);
      if (!prev) return;
      const rec: SessionRecord = { ...prev, name: name ?? prev.name, exportedAt: Math.max(Date.now(), prev.at) };
      await idbWrite([{ store: "sessions", key: SESSION, value: rec }]);
      writeMeta({ name: rec.name, updatedAt: rec.at, exportedAt: rec.exportedAt });
    } catch {
      /* the badge simply stays */
    }
  });
}

/** Close and forget: removes the document, its images and the badge. */
export function clearDraft(): Promise<void> {
  generation++;
  dropLegacy();
  writeMeta(null);
  return serial(async () => {
    if (!idbAvailable()) return;
    try {
      await idbWrite([{ store: "sessions", key: SESSION, del: true }]);
      await idbClear("blobs");
    } catch {
      /* ignore */
    }
    // A save already running when this was called may have re-set the meta.
    writeMeta(null);
  });
}
