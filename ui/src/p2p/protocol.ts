/**
 * Filenymous direct P2P protocol, v2.
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
  | { type: "manifest"; v: number; files: P2PFileInfo[]; chunkSize: number; wrappedSecret: string; message?: string; device?: string; auth?: P2PAuthChallenge; protected?: boolean; streamable?: boolean; expires?: number }
  | { type: "start"; files?: number[] }
  | { type: "file-end"; index: number; chunks: number }
  | { type: "done" }
  | { type: "progress"; bytes: number }
  | { type: "file-ack"; index: number }
  | { type: "ack"; bytes?: number }
  | { type: "cancel"; reason?: string }
  | { type: "hello"; device?: string }
  | { type: "auth"; proof: string }
  | { type: "auth-ok" }
  | { type: "auth-fail"; remaining: number }
  /**
   * Streaming (manifest.streamable): the receiver asks for chunks [from..to]
   * of one file, out of order. The sender answers with the usual sealed
   * frames (same per-(file, chunk) IV, so a resent chunk is byte-identical).
   * `prefetch` ranges are served after any on-demand range (player seeks).
 * Receivers/senders that don't know this message simply never send it.
   */
  | { type: "range"; index: number; from: number; to: number; prefetch?: boolean };

/** Max chunks one range request may ask for (4 MiB). */
export const MAX_RANGE_CHUNKS = 64;

/**
 * Password gate. A protected session first sends a v3 "locked" manifest
 * (no file names, no wrapped secret): v2-only clients reject it as an
 * unsupported protocol. The receiver answers an HMAC challenge-response; the
 * password itself never crosses the wire, and a PBKDF2-derived half of it is
 * mixed into the AES file key, so the link alone can't decrypt the data.
 */
export const P2P_LOCKED_VERSION = 3;
/**
 * Expiring shares: manifest v4 carries `expires` (Unix seconds). The expiry is
 * also in the link (`#p2p:CODE/SECRET/e<base36>`) and mixed into the AES key,
 * so editing it in the link makes decryption fail. v2-only receivers reject v4
 * cleanly ("unsupported-protocol"); non-expiring shares stay v2.
 */
export const P2P_EXPIRING_VERSION = 4;
export const PASSWORD_ITERATIONS = 310_000;
export const MAX_PASSWORD_ATTEMPTS = 5;

export interface P2PAuthChallenge {
  salt: string;
  iter: number;
  nonce: string;
}

export interface PasswordKeys {
  /** HMAC-SHA256 key for the challenge-response. */
  auth: CryptoKey;
  /** 32 bytes mixed into the AES file key. */
  mix: Uint8Array;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array {
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

export function buildShareLink(baseUrl: string, code: string, secret?: string, expires?: number): string {
  const base = baseUrl.split("#")[0]!;
  const exp = secret && expires ? `/e${expires.toString(36)}` : "";
  return `${base}#p2p:${code}${secret ? `/${secret}` : ""}${exp}`;
}

/** The `#p2p:` fragment for a parsed share (keeps the expiry segment). */
export function shareFragment(p: { code: string; secret?: string; expires?: number }): string {
  return buildShareLink("", p.code, p.secret, p.expires).slice(1);
}

/** Accepts a full link, a `#p2p:...` fragment or a bare code. */
export function parseShareInput(input: string): { code: string; secret?: string; expires?: number } | null {
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
  const [codePart, secretPart, expPart] = raw.split("/");
  const code = normalizeShareCode(codePart ?? "");
  if (!code) return null;
  const secret = secretPart && /^[A-Za-z0-9_-]{16,64}$/.test(secretPart) ? secretPart : undefined;
  if (!secret) return { code };
  const expires = expPart && /^e[0-9a-z]{1,10}$/.test(expPart) ? parseInt(expPart.slice(1), 36) : undefined;
  return expires ? { code, secret, expires } : { code, secret };
}

export function isP2PHash(hash: string): boolean {
  return /^#p2p:/i.test(hash) && parseShareInput(hash) !== null;
}

export function randomB64(bytes = 16): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function derivePasswordKeys(password: string, salt: string, iterations = PASSWORD_ITERATIONS): Promise<PasswordKeys> {
  const material = await crypto.subtle.importKey("raw", buf(new TextEncoder().encode(password.normalize("NFC"))), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", salt: buf(b64urlDecode(salt)), iterations, hash: "SHA-256" }, material, 512),
  );
  const auth = await crypto.subtle.importKey("raw", buf(bits.slice(0, 32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return { auth, mix: bits.slice(32) };
}

function authMessage(code: string, nonce: string): ArrayBuffer {
  return buf(new TextEncoder().encode(`filenymous-p2p-auth-v3:${code}:${nonce}`));
}

export async function passwordProof(keys: PasswordKeys, code: string, nonce: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", keys.auth, authMessage(code, nonce))));
}

/** Constant-time (WebCrypto HMAC verify). */
export async function verifyPasswordProof(keys: PasswordKeys, code: string, nonce: string, proof: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", keys.auth, buf(b64urlDecode(proof)), authMessage(code, nonce));
  } catch {
    return false;
  }
}

export async function deriveFileKey(secret: string, passwordMix?: Uint8Array, expires?: number): Promise<CryptoKey> {
  const sec = b64urlDecode(secret);
  let raw = sec;
  if (passwordMix) {
    raw = new Uint8Array(sec.length + passwordMix.length);
    raw.set(sec);
    raw.set(passwordMix, sec.length);
  }
  const ikm = await crypto.subtle.importKey("raw", buf(raw), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buf(new TextEncoder().encode("filenymous-p2p-v2")),
      info: buf(new TextEncoder().encode(`${passwordMix ? "file-key+password" : "file-key"}${expires ? `|exp=${expires}` : ""}`)),
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
      if (msg.expires !== undefined && !(Number.isSafeInteger(msg.expires) && msg.expires > 0)) return null;
      if (msg.auth !== undefined) {
        const a = msg.auth;
        if (!a || typeof a.salt !== "string" || typeof a.nonce !== "string" || !Number.isSafeInteger(a.iter)) return null;
        if (a.iter < 100_000 || a.iter > 5_000_000) return null;
      }
    }
    if (msg.type === "range") {
      const { index, from, to } = msg;
      if (![index, from, to].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
      if (to < from || to - from >= MAX_RANGE_CHUNKS) return null;
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
