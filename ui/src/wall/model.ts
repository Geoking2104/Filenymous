/**
 * Sharewall state that lives only in memory: the host's item store (bytes in
 * RAM, never IndexedDB/localStorage/Cache), item metadata shown in the grid,
 * the control messages and their validation, plus the pure TTL/burn rules.
 */
import { safeFileName } from "../p2p/protocol";

export type ItemKind = "file" | "text";

export interface ItemMeta {
  id: string;
  kind: ItemKind;
  name: string;
  size: number;
  mime: string;
  /** Short label of the author ("Hôte", "Pair 2"…), never a real identity. */
  by: string;
  at: number;
}

export const MAX_ITEM_BYTES = 256 * 1024 * 1024;
export const MAX_WALL_BYTES = 1024 * 1024 * 1024;
export const MAX_ITEMS = 200;
export const MAX_TEXT_BYTES = 64 * 1024;
export const WALL_CHUNK = 64 * 1024;

/** Control messages (always sent sealed, see crypto.ts). */
export type WallMessage =
  // peer → host
  | { t: "put"; uid: number; kind: ItemKind; name: string; size: number; mime: string }
  | { t: "put-end"; uid: number; chunks: number }
  | { t: "get"; rid: number; id: string }
  | { t: "bye" }
  // host → peer
  | { t: "welcome"; label: string; expiresAt: number; burn: boolean; hostLeave: boolean }
  | { t: "state"; items: ItemMeta[]; peers: number }
  | { t: "put-ok"; uid: number; id: string }
  | { t: "put-fail"; uid: number; reason: string }
  | { t: "get-begin"; rid: number; item: ItemMeta }
  | { t: "get-end"; rid: number; chunks: number }
  | { t: "get-fail"; rid: number; reason: "gone" | "busy" }
  | { t: "destroy"; reason: DestroyReason };

export type DestroyReason = "destroyed" | "expired" | "host-left";

const int = (v: unknown, min = 0) => Number.isSafeInteger(v) && (v as number) >= min;
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const cleanText = (v: string, max: number) => v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);

export function cleanMeta(m: unknown): ItemMeta | null {
  const o = m as Record<string, unknown>;
  if (!o || typeof o !== "object") return null;
  if (!str(o.id, 64) || !/^[a-z0-9-]{1,64}$/.test(o.id as string)) return null;
  if (o.kind !== "file" && o.kind !== "text") return null;
  if (!str(o.name, 400) || !int(o.size) || !str(o.mime, 200) || !str(o.by, 80) || !int(o.at)) return null;
  return {
    id: o.id as string,
    kind: o.kind,
    name: o.kind === "file" ? safeFileName(o.name as string) : cleanText(o.name as string, 120),
    size: o.size as number,
    mime: cleanText((o.mime as string) || "application/octet-stream", 128),
    by: cleanText(o.by as string, 40),
    at: o.at as number,
  };
}

/** Validates a decrypted control message; returns null when malformed. */
export function parseWallMessage(m: unknown): WallMessage | null {
  const o = m as Record<string, unknown>;
  if (!o || typeof o !== "object" || typeof o.t !== "string") return null;
  switch (o.t) {
    case "put":
      if (!int(o.uid, 1) || (o.kind !== "file" && o.kind !== "text") || !str(o.name, 400) || !int(o.size) || !str(o.mime, 200)) return null;
      return { t: "put", uid: o.uid as number, kind: o.kind, name: o.name as string, size: o.size as number, mime: o.mime as string };
    case "put-end":
      return int(o.uid, 1) && int(o.chunks) ? { t: "put-end", uid: o.uid as number, chunks: o.chunks as number } : null;
    case "get":
      return int(o.rid, 1) && str(o.id, 64) ? { t: "get", rid: o.rid as number, id: o.id as string } : null;
    case "bye":
      return { t: "bye" };
    case "welcome":
      return str(o.label, 40) && int(o.expiresAt) && typeof o.burn === "boolean" && typeof o.hostLeave === "boolean"
        ? { t: "welcome", label: cleanText(o.label as string, 40), expiresAt: o.expiresAt as number, burn: o.burn, hostLeave: o.hostLeave }
        : null;
    case "state": {
      if (!Array.isArray(o.items) || o.items.length > MAX_ITEMS || !int(o.peers)) return null;
      const items = o.items.map(cleanMeta);
      return items.every(Boolean) ? { t: "state", items: items as ItemMeta[], peers: o.peers as number } : null;
    }
    case "put-ok":
      return int(o.uid, 1) && str(o.id, 64) ? { t: "put-ok", uid: o.uid as number, id: o.id as string } : null;
    case "put-fail":
      return int(o.uid, 1) && str(o.reason, 64) ? { t: "put-fail", uid: o.uid as number, reason: o.reason as string } : null;
    case "get-begin": {
      const item = cleanMeta(o.item);
      return int(o.rid, 1) && item ? { t: "get-begin", rid: o.rid as number, item } : null;
    }
    case "get-end":
      return int(o.rid, 1) && int(o.chunks) ? { t: "get-end", rid: o.rid as number, chunks: o.chunks as number } : null;
    case "get-fail":
      return int(o.rid, 1) && (o.reason === "gone" || o.reason === "busy") ? { t: "get-fail", rid: o.rid as number, reason: o.reason } : null;
    case "destroy":
      return ["destroyed", "expired", "host-left"].includes(o.reason as string) ? { t: "destroy", reason: o.reason as DestroyReason } : null;
    default:
      return null;
  }
}

/** Checks an incoming item against the wall limits; returns a reason or null. */
export function admitItem(kind: ItemKind, size: number, usedBytes: number, count: number): string | null {
  if (count >= MAX_ITEMS) return "too-many-items";
  if (kind === "text" && (size === 0 || size > MAX_TEXT_BYTES)) return "text-too-large";
  if (size > MAX_ITEM_BYTES) return "item-too-large";
  if (usedBytes + size > MAX_WALL_BYTES) return "wall-full";
  return null;
}

interface Stored {
  meta: ItemMeta;
  /** Author peer id ("host" for the host), to exclude self-downloads from burn. */
  owner: string;
  data: Blob;
}

/**
 * The host's in-memory wall. With `burn`, an item is removed from the wall on
 * its first download by anyone other than its author.
 */
export class WallStore {
  private items = new Map<string, Stored>();
  private seq = 0;

  constructor(private readonly burn: boolean) {}

  get used(): number {
    let n = 0;
    for (const s of this.items.values()) n += s.meta.size;
    return n;
  }

  get size(): number {
    return this.items.size;
  }

  list(): ItemMeta[] {
    return Array.from(this.items.values(), (s) => s.meta);
  }

  admit(kind: ItemKind, size: number): string | null {
    return admitItem(kind, size, this.used, this.items.size);
  }

  add(input: { kind: ItemKind; name: string; mime: string; by: string; owner: string; data: Blob; at?: number }): ItemMeta {
    const id = `i${++this.seq}-${Math.random().toString(36).slice(2, 8)}`;
    const meta: ItemMeta = {
      id,
      kind: input.kind,
      name: input.kind === "file" ? safeFileName(input.name) : cleanText(input.name, 120) || "note",
      size: input.data.size,
      mime: input.mime || "application/octet-stream",
      by: input.by,
      at: input.at ?? Date.now(),
    };
    this.items.set(id, { meta, owner: input.owner, data: input.data });
    return meta;
  }

  /** Bytes of an item for `requester`; with burn, removes it unless the requester is its author. */
  take(id: string, requester: string): { meta: ItemMeta; data: Blob; burned: boolean } | null {
    const s = this.items.get(id);
    if (!s) return null;
    const burned = this.burn && s.owner !== requester;
    if (burned) this.items.delete(id);
    return { meta: s.meta, data: s.data, burned };
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }

  /** Drops every reference to item bytes (the browser frees the memory). */
  wipe(): void {
    this.items.clear();
  }
}

export function remainingMs(expiresAt: number, now = Date.now()): number {
  return Math.max(0, expiresAt - now);
}

export function formatRemaining(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export type PreviewKind = "image" | "video" | "audio" | "text" | null;

const TEXT_EXT = /\.(txt|md|csv|json|log|ya?ml|xml|ini|conf|env|sh|py|js|ts|tsx|jsx|css|html?|sql|toml|rs|go|java|c|h|cpp|rb|php)$/i;

/**
 * What can be previewed from memory. PDF is deliberately not previewed: the
 * browsers' PDF viewers refuse sandboxed frames and can run document scripts,
 * so PDFs are download-only. HTML/SVG are never rendered as documents: text is
 * shown with textContent and images through <img> (scripts don't run there).
 */
export function previewKind(meta: Pick<ItemMeta, "kind" | "name" | "mime">): PreviewKind {
  if (meta.kind === "text") return "text";
  const mime = meta.mime.toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(mime) || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(meta.name)) return "image";
  if (/^video\/(mp4|webm|ogg)$/.test(mime) || /\.(mp4|webm|ogv)$/i.test(meta.name)) return "video";
  if (/^audio\/(mpeg|mp3|ogg|wav|webm|aac|flac)$/.test(mime) || /\.(mp3|ogg|oga|wav|aac|flac)$/i.test(meta.name)) return "audio";
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXT.test(meta.name)) return "text";
  return null;
}

export const PREVIEW_TEXT_MAX = 200 * 1024;
