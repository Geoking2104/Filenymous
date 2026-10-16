/** Streaming helpers: which files can play in the browser, byte → chunk math. */
import { P2P_CHUNK_SIZE } from "./protocol";

const EXT_MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogv: "video/ogg", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
};

/** Best MIME for a shared file (senders may send an empty type). */
export function mediaMime(name: string, mime: string): string {
  if (/^(audio|video)\//.test(mime)) return mime;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXT_MIME[ext] ?? mime ?? "";
}

export function mediaKind(name: string, mime: string): "video" | "audio" | null {
  const m = mediaMime(name, mime);
  return m.startsWith("video/") ? "video" : m.startsWith("audio/") ? "audio" : null;
}

/** Can this browser play it natively (progressive, with Range seeking)? */
export function canPlayInBrowser(name: string, mime: string, probe?: (m: string) => string): boolean {
  const kind = mediaKind(name, mime);
  if (!kind) return false;
  const test = probe ?? ((m: string) => (typeof document !== "undefined" ? document.createElement(kind).canPlayType(m) : ""));
  return test(mediaMime(name, mime)) !== "";
}

/** Inclusive byte range [start, end] → inclusive chunk range. */
export function chunksForRange(start: number, end: number, size: number, chunkSize = P2P_CHUNK_SIZE): { from: number; to: number } {
  const last = Math.max(0, size - 1);
  const s = Math.min(Math.max(0, start), last);
  const e = Math.min(Math.max(s, end), last);
  return { from: Math.floor(s / chunkSize), to: Math.floor(e / chunkSize) };
}

/** Parses an HTTP Range header against a size: "bytes=100-" → {start:100, end:size-1}. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return { start: 0, end: size - 1 };
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return null;
  return { start, end };
}
