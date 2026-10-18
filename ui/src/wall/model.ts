/**
 * Sharewall state that lives only in memory: the host's item store (bytes in
 * RAM, never IndexedDB/localStorage/Cache), item metadata shown in the grid,
 * the control messages and their validation, plus the pure TTL/burn rules.
 */
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
  /** Member label of the author ("host", "peer:2"), never a real identity. */
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
  // both directions: media signaling for live streams, inside the sealed channel
  | RtcMessage
  // host → peer
  | { t: "welcome"; label: string; expiresAt: number; burn: boolean; hostLeave: boolean; agents: boolean; media: boolean }
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
  | { t: "destroy"; reason: DestroyReason };

export interface RtcMessage {
  t: "rtc";
  /** "up:<sid>" publisher → host, "down:<sid>" host → viewer. */
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

/** Validates a decrypted control message; returns null when malformed. */
export function parseWallMessage(m: unknown): WallMessage | null {
  const o = m as Record<string, unknown>;
  if (!o || typeof o !== "object" || typeof o.t !== "string") return null;
  switch (o.t) {
    case "profile":
      return str(o.name, 200) && typeof o.agent === "boolean" && typeof o.media === "boolean"
        ? { t: "profile", name: cleanName(o.name), agent: o.agent, media: o.media }
        : null;
    case "say":
      if (!str(o.text, MAX_MSG_CHARS + 64) || !optId(o.replyTo)) return null;
      return { t: "say", text: o.text as string, ...(o.replyTo ? { replyTo: o.replyTo as string } : {}) };
    case "put":
      if (!int(o.uid, 1) || (o.kind !== "file" && o.kind !== "text") || !str(o.name, 400) || !int(o.size) || !str(o.mime, 200) || !optId(o.replyTo)) return null;
      return { t: "put", uid: o.uid as number, kind: o.kind, name: o.name as string, size: o.size as number, mime: o.mime as string, ...(o.replyTo ? { replyTo: o.replyTo as string } : {}) };
    case "put-end":
      return int(o.uid, 1) && int(o.chunks) ? { t: "put-end", uid: o.uid as number, chunks: o.chunks as number } : null;
    case "get":
      return int(o.rid, 1) && str(o.id, 64) ? { t: "get", rid: o.rid as number, id: o.id as string } : null;
    case "react":
      return isPostId(o.id) && isEmoji(o.emoji) ? { t: "react", id: o.id, emoji: o.emoji } : null;
    case "poll":
      return str(o.question, 400) && Array.isArray(o.options) && o.options.length <= POLL_MAX && o.options.every((x) => str(x, 200))
        ? { t: "poll", question: o.question as string, options: o.options as string[] }
        : null;
    case "vote":
      return isPostId(o.id) && int(o.option) && (o.option as number) < POLL_MAX ? { t: "vote", id: o.id, option: o.option as number } : null;
    case "poll-close":
    case "remove":
      return isPostId(o.id) ? { t: o.t, id: o.id } : null;
    case "typing":
      return { t: "typing" };
    case "burst":
      return BURST_KINDS.has(o.kind as string) ? { t: "burst", kind: o.kind as BurstKind } : null;
    case "hand":
      return typeof o.up === "boolean" ? { t: "hand", up: o.up } : null;
    case "rename":
      return str(o.name, 200) && cleanName(o.name) ? { t: "rename", name: cleanName(o.name) } : null;
    case "live-start":
      return (o.kind === "screen" || o.kind === "camera") && int(o.tracks, 1) && (o.tracks as number) <= 2 ? { t: "live-start", kind: o.kind, tracks: o.tracks as number } : null;
    case "live-stop":
    case "live-ok":
      return isPostId(o.sid) ? { t: o.t, sid: o.sid } : null;
    case "bye":
      return { t: "bye" };
    case "rtc": {
      if (typeof o.link !== "string" || !LINK_RE.test(o.link)) return null;
      if (o.kind === "offer" || o.kind === "answer") return str(o.sdp, 64 * 1024) && o.sdp ? { t: "rtc", link: o.link, kind: o.kind, sdp: o.sdp as string } : null;
      if (o.kind === "ice") {
        const candidate = cleanCandidate(o.candidate);
        return candidate ? { t: "rtc", link: o.link, kind: "ice", candidate } : null;
      }
      return null;
    }
    case "welcome":
      return isLabel(o.label) && int(o.expiresAt) && typeof o.burn === "boolean" && typeof o.hostLeave === "boolean" && typeof o.agents === "boolean" && typeof o.media === "boolean"
        ? { t: "welcome", label: o.label, expiresAt: o.expiresAt as number, burn: o.burn, hostLeave: o.hostLeave, agents: o.agents, media: o.media }
        : null;
    case "members": {
      if (!Array.isArray(o.members) || o.members.length > 64) return null;
      const members = o.members.map(cleanMember);
      return members.every(Boolean) ? { t: "members", members: members as Member[] } : null;
    }
    case "post": {
      const post = cleanPost(o.post, cleanMeta);
      return post ? { t: "post", post } : null;
    }
    case "unpost":
      return isPostId(o.id) ? { t: "unpost", id: o.id } : null;
    case "pin":
      return o.id === null || isPostId(o.id) ? { t: "pin", id: o.id as string | null } : null;
    case "live": {
      if (!Array.isArray(o.streams) || o.streams.length > MAX_LIVE) return null;
      const streams = o.streams.map(cleanLive);
      return streams.every(Boolean) ? { t: "live", streams: streams as LiveInfo[] } : null;
    }
    case "live-fail":
    case "notice":
      if (o.t === "live-fail") return str(o.reason, 64) ? { t: "live-fail", reason: o.reason as string } : null;
      return str(o.code, 64) && (o.retryMs === undefined || int(o.retryMs)) ? { t: "notice", code: o.code as string, ...(o.retryMs !== undefined ? { retryMs: o.retryMs as number } : {}) } : null;
    case "typing-by":
      return isLabel(o.label) ? { t: "typing-by", label: o.label } : null;
    case "burst-by":
      return isLabel(o.label) && BURST_KINDS.has(o.kind as string) ? { t: "burst-by", label: o.label, kind: o.kind as BurstKind } : null;
    case "settings":
      return typeof o.agents === "boolean" ? { t: "settings", agents: o.agents } : null;
    case "kick":
      return o.reason === "kicked" || o.reason === "agents-off" ? { t: "kick", reason: o.reason } : null;
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
