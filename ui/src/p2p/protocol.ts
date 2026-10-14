/**
 * Filenymous direct P2P (file.pizza-style) protocol, v2.
 *
 * - Share code: `123-456-ABC` (same format the signaling relay validates).
 * - Share link: `<app>#p2p:123-456-ABC/<secret>` — the secret never leaves the
 *   URL fragment, so neither the web host nor the signaling relay sees it.
 * - File key: HKDF-SHA256(secret) → AES-256-GCM. On top of WebRTC's DTLS, each
 *   64 KiB chunk is sealed with a unique IV (fileIndex ‖ chunkIndex) and the
 *   frame header as AAD, so chunks can't be reordered, replayed or swapped.
 * - Typed-code receivers (no secret in hand) get the secret over the
 *   DataChannel, wrapped with a PBKDF2 key derived from the code.
 */

export const P2P_PROTOCOL_VERSION = 2;
export const P2P_CHUNK_SIZE = 64 * 1024;
export const GCM_TAG_BYTES = 16;
export const FRAME_HEADER_BYTES = 8;
const CODE_RE = /^(\d{3})(\d{3})([A-Z]{3})$/;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export interface P2PFileInfo {
  name: string;
  size: number;
  mime: string;
}

export type P2PControl =
  | { type: "manifest"; v: number; files: P2PFileInfo[]; chunkSize: number; wrappedSecret: string; message?: string; device?: string }
  | { type: "start"; files?: number[] }
  | { type: "file-end"; index: number; chunks: number }
  | { type: "done" }
  | { type: "progress"; bytes: number }
  | { type: "file-ack"; index: number }
  | { type: "ack"; bytes?: number }
  | { type: "cancel"; reason?: string }
  | { type: "hello"; device?: string };

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function createShareCode(): string {
  const rnd = crypto.getRandomValues(new Uint32Array(4));
  const digits = String(rnd[0]! % 1_000_000).padStart(6, "0");
  const letters = [rnd[1]!, rnd[2]!, rnd[3]!].map((n) => LETTERS[n % LETTERS.length]).join("");
  return `${digits.slice(0, 3)}-${digits.slice(3)}-${letters}`;
}

export function normalizeShareCode(value: string): string | null {
  const compact = String(value || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const m = compact.match(CODE_RE);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function createSecret(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

export function buildShareLink(baseUrl: string, code: string, secret?: string): string {
  const base = baseUrl.split("#")[0]!;
  return `${base}#p2p:${code}${secret ? `/${secret}` : ""}`;
}

/** Accepts a full link, a `#p2p:...` fragment or a bare code. */
export function parseShareInput(input: string): { code: string; secret?: string } | null {
  let raw = String(input || "").trim();
  if (!raw) return null;
  const hashAt = raw.indexOf("#");
  if (hashAt >= 0) raw = raw.slice(hashAt + 1);
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  if (raw.startsWith("p2p:")) raw = raw.slice(4);
  const [codePart, secretPart] = raw.split("/");
  const code = normalizeShareCode(codePart ?? "");
  if (!code) return null;
  const secret = secretPart && /^[A-Za-z0-9_-]{16,64}$/.test(secretPart) ? secretPart : undefined;
  return secret ? { code, secret } : { code };
}

export function isP2PHash(hash: string): boolean {
  return /^#p2p:/i.test(hash) && parseShareInput(hash) !== null;
}

export async function deriveFileKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", buf(b64urlDecode(secret)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buf(new TextEncoder().encode("filenymous-p2p-v2")),
      info: buf(new TextEncoder().encode("file-key")),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function codeWrapKey(code: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    buf(new TextEncoder().encode(`filenymous-p2p-code-v2:${code}`)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: buf(new TextEncoder().encode("filenymous-p2p-secret-wrap")), iterations: 120_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function wrapSecret(code: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await codeWrapKey(code), buf(b64urlDecode(secret)));
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

export async function unwrapSecret(code: string, wrapped: string): Promise<string> {
  const [ivB64, ctB64] = String(wrapped || "").split(".");
  if (!ivB64 || !ctB64) throw new Error("invalid wrapped secret");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(b64urlDecode(ivB64)) },
    await codeWrapKey(code),
    buf(b64urlDecode(ctB64)),
  );
  return b64urlEncode(new Uint8Array(pt));
}

function frameIv(fileIndex: number, chunkIndex: number): Uint8Array {
  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);
  view.setUint32(0, fileIndex);
  view.setUint32(4, Math.floor(chunkIndex / 2 ** 32));
  view.setUint32(8, chunkIndex >>> 0);
  return iv;
}

/** Binary frame: u32 fileIndex ‖ u32 chunkIndex ‖ AES-GCM(ciphertext+tag). */
export async function sealChunk(key: CryptoKey, fileIndex: number, chunkIndex: number, plain: Uint8Array): Promise<ArrayBuffer> {
  const header = new Uint8Array(FRAME_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, fileIndex);
  view.setUint32(4, chunkIndex);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(frameIv(fileIndex, chunkIndex)), additionalData: buf(header) }, key, buf(plain)),
  );
  const out = new Uint8Array(FRAME_HEADER_BYTES + ct.byteLength);
  out.set(header);
  out.set(ct, FRAME_HEADER_BYTES);
  return out.buffer;
}

export async function openChunk(
  key: CryptoKey,
  frame: ArrayBuffer,
): Promise<{ fileIndex: number; chunkIndex: number; plain: Uint8Array }> {
  const bytes = new Uint8Array(frame);
  if (bytes.byteLength < FRAME_HEADER_BYTES + GCM_TAG_BYTES) throw new Error("short frame");
  const header = bytes.subarray(0, FRAME_HEADER_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, FRAME_HEADER_BYTES);
  const fileIndex = view.getUint32(0);
  const chunkIndex = view.getUint32(4);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(frameIv(fileIndex, chunkIndex)), additionalData: buf(header) },
      key,
      buf(bytes.subarray(FRAME_HEADER_BYTES)),
    ),
  );
  return { fileIndex, chunkIndex, plain };
}

export function chunkCount(size: number, chunkSize = P2P_CHUNK_SIZE): number {
  return size === 0 ? 0 : Math.ceil(size / chunkSize);
}

export function parseControl(text: string): P2PControl | null {
  try {
    const msg = JSON.parse(text) as P2PControl;
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") return null;
    if (msg.type === "manifest") {
      if (!Array.isArray(msg.files) || msg.files.length === 0 || msg.files.length > 1000) return null;
      if (!msg.files.every((f) => typeof f?.name === "string" && Number.isSafeInteger(f.size) && f.size >= 0)) return null;
      if (typeof msg.wrappedSecret !== "string" || !Number.isSafeInteger(msg.chunkSize)) return null;
    }
    if ("device" in msg && msg.device !== undefined) {
      if (typeof msg.device !== "string") return null;
      (msg as { device?: string }).device = msg.device.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
    }
    return msg;
  } catch {
    return null;
  }
}

/** Strip path separators/control chars from a peer-supplied file name. */
export function safeFileName(name: string): string {
  const cleaned = String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return cleaned || "file";
}
