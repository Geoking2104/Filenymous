/**
 * Sharewall state that lives only in memory: the host's item store (bytes in
 * RAM, never IndexedDB/localStorage/Cache), item metadata shown in the grid,
 * the control messages and their validation, plus the pure TTL/burn rules.
 */
import { sanitizeWallTitle } from "./link";
import { safeFileName } from "../p2p/protocol";
import {
  MAX_LIVE,
  MAX_MSG_CHARS,
  POLL_MAX,
  cleanLive,
  cleanMember,
  cleanName,
  cleanPost,
  isEmoji,
  isLabel,
  isPostId,
  type BurstKind,
  type LiveInfo,
  type LiveKind,
  type Member,
  type Post,
} from "./feed";

export type ItemKind = "file" | "text";

export interface ItemMeta {
  id: string;
  kind: ItemKind;
  name: string;
  size: number;
  mime: string;
  by: string;
  at: number;
}

export const MAX_ITEM_BYTES = 256 * 1024 * 1024;
export const MAX_WALL_BYTES = 1024 * 1024 * 1024;
export const MAX_ITEMS = 200;
export const MAX_TEXT_BYTES = 64 * 1024;
export const WALL_CHUNK = 64 * 1024;

export type WallMessage =
  | { t: "profile"; name: string; agent: boolean; media: boolean }
  | { t: "say"; text: string; replyTo?: string }
  | { t: "put"; uid: number; kind: ItemKind; name: string; size: number; mime: string; replyTo?: string }
  | { t: "put-end"; uid: number; chunks: number }
  | { t: "get"; rid: number; id: string }
  | { t: "react"; id: string; emoji: string }
  | { t: "poll"; question: string; options: string[] }
  | { t: "vote"; id: string; option: number }
  | { t: "poll-close"; id: string }
  | { t: "remove"; id: string }
  | { t: "typing" }
  | { t: "burst"; kind: BurstKind }
  | { t: "hand"; up: boolean }
  | { t: "rename"; name: string }
  | { t: "live-start"; kind: LiveKind; tracks: number }
  | { t: "live-stop"; sid: string }
  | { t: "bye" }
  | { t: "note-set"; id: string; text: string; version: number }
  | { t: "note-update"; id: string; text: string; version: number; by: string; at: number }
  | { t: "welcome"; label: string; expiresAt: number; burn: boolean; hostLeave: boolean; agents: boolean; media: boolean; title?: string }
  | { t: "members"; members: Member[] }
  | { t: "post"; post: Post }
  | { t: "unpost"; id: string }
  | { t: "pin"; id: string | null }
  | { t: "live"; streams: LiveInfo[] }
  | { t: "live-ok"; sid: string }
  | { t: "live-fail"; reason: string }
  | { t: "typing-by"; label: string }
  | { t: "burst-by"; label: string; kind: BurstKind }
  | { t: "settings"; agents: boolean }
  | { t: "notice"; code: string; retryMs?: number }
  | { t: "kick"; reason: KickReason }
  | { t: "put-ok"; uid: number; id: string }
  | { t: "put-fail"; uid: number; reason: string }
  | { t: "get-begin"; rid: number; item: ItemMeta }
  | { t: "get-end"; rid: number; chunks: number }
  | { t: "get-fail"; rid: number; reason: "gone" | "busy" }
  | { t: "destroy"; reason: DestroyReason }
  | { t: "rtc"; link: string; kind: "offer" | "answer" | "ice"; sdp?: string; candidate?: RTCIceCandidateInit };

export interface RtcMessage {
  t: "rtc";
  link: string;
  kind: "offer" | "answer" | "ice";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export type DestroyReason = "destroyed" | "expired" | "host-left";
export type KickReason = "kicked" | "agents-off";

const int = (v: unknown, min = 0) => Number.isSafeInteger(v) && (v as number) >= min;
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const cleanText = (v: string, max: number) => v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
const optId = (v: unknown) => v === undefined || isPostId(v);
const LINK_RE = /^(up|down):[a-z0-9-]{1,64}$/;

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

function cleanCandidate(c: unknown): RTCIceCandidateInit | null {
  const o = c as Record<string, unknown>;
  if (!o || typeof o !== "object" || !str(o.candidate, 2048)) return null;
  if (o.sdpMid !== undefined && o.sdpMid !== null && !str(o.sdpMid, 64)) return null;
  if (o.sdpMLineIndex !== undefined && o.sdpMLineIndex !== null && !int(o.sdpMLineIndex)) return null;
  if (o.usernameFragment !== undefined && o.usernameFragment !== null && !str(o.usernameFragment, 256)) return null;
  const out: RTCIceCandidateInit = { candidate: o.candidate as string, sdpMid: (o.sdpMid as string | null) ?? null, sdpMLineIndex: (o.sdpMLineIndex as number | null) ?? null };
  if (typeof o.usernameFragment === "string") out.usernameFragment = o.usernameFragment;
  return out;
}

const BURST_KINDS = new Set(["applause", "party", "heart"]);

export function parseWallMessage(m: unknown): WallMessage | null {
  const o = m as Record<string, unknown>;
  if (!o || typeof o !== "object" || typeof o.t !== "string") return null;
  switch (o.t) {
    case "note-set":
      return isPostId(o.id) && str(o.text, 64 * 1024) && int(o.version, 1)
        ? { t: "note-set", id: o.id as string, text: o.text as string, version: o.version as number }
        : null;
    case "note-update":
      return isPostId(o.id) && str(o.text, 64 * 1024) && int(o.version, 1) && str(o.by, 40) && int(o.at)
        ? { t: "note-update", id: o.id as string, text: o.text as string, version: o.version as number, by: o.by as string, at: o.at as number }
        : null;
    default:
      return null;
  }
}

export function admitItem(kind: ItemKind, size: number, usedBytes: number, count: number): string | null {
  if (count >= MAX_ITEMS) return "too-many-items";
  if (kind === "text" && (size === 0 || size > MAX_TEXT_BYTES)) return "text-too-large";
  if (size > MAX_ITEM_BYTES) return "item-too-large";
  if (usedBytes + size > MAX_WALL_BYTES) return "wall-full";
  return null;
}

interface Stored {
  meta: ItemMeta;
  owner: string;
  data: Blob;
}

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

  get(id: string): { meta: ItemMeta; data: Blob } | undefined {
    const s = this.items.get(id);
    return s ? { meta: s.meta, data: s.data } : undefined;
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

  wipe(): void {
    this.items.clear();
  }
}

export function remainingMs(expiresAt: number, now = Date.now()): number {
  if (!expiresAt) return Infinity;
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
