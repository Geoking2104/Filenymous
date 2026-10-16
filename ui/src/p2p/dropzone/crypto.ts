/**
 * Dropzone key schedule and handshake. Reuses the direct-transfer chunk format
 * (`sealChunk`/`openChunk`: AES-256-GCM, IV = fileIndex ‖ chunkIndex, header as
 * AAD) with a fresh key per contributor session, so deterministic IVs are never
 * reused across sessions.
 *
 * key = HKDF-SHA256(secret ‖ PBKDF2(password)?, info = dropId ‖ sid ‖ expiry ‖ flags)
 *
 * The password gate is a mutual proof: the contributor seals `hello:<sid>`, the
 * owner (who knows the password) can only open it with the right key and
 * answers with a sealed `ready:<sid>`. A wrong password fails before any file
 * byte is sent; a fake owner can't produce the answer.
 */
import { b64urlDecode, b64urlEncode, safeFileName, type P2PFileInfo } from "../protocol";
import type { DropParams } from "./link";

export const DROP_PROTOCOL_VERSION = 1;
const PBKDF2_ITERATIONS = 200_000;
const enc = new TextEncoder();

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function createSessionId(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
}

async function passwordBits(dropId: string, password: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", buf(enc.encode(password.normalize("NFC"))), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: buf(enc.encode(`filenymous-drop-pw:${dropId}`)), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export type DropKeyParams = Pick<DropParams, "dropId" | "secret" | "expiresAt" | "password">;

/** Password bits are slow (PBKDF2): compute them once and reuse per session. */
export async function dropBaseMaterial(p: DropKeyParams, password?: string): Promise<Uint8Array> {
  const secret = b64urlDecode(p.secret);
  if (!p.password) return secret;
  const pw = await passwordBits(p.dropId, password ?? "");
  const out = new Uint8Array(secret.length + pw.length);
  out.set(secret);
  out.set(pw, secret.length);
  return out;
}

export async function deriveDropKey(p: DropKeyParams, base: Uint8Array, sid: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", buf(base), "HKDF", false, ["deriveKey"]);
  const info = `drop-key:${p.dropId}:${sid}:${Math.floor(p.expiresAt / 1000)}:${p.password ? "p" : "n"}`;
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(enc.encode("filenymous-drop-v1")), info: buf(enc.encode(info)) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealProof(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(enc.encode(text)));
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

export async function checkProof(key: CryptoKey, proof: string, expected: string): Promise<boolean> {
  try {
    const [iv, ct] = String(proof || "").split(".");
    if (!iv || !ct) return false;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(b64urlDecode(iv)) }, key, buf(b64urlDecode(ct)));
    return new TextDecoder().decode(pt) === expected;
  } catch {
    return false;
  }
}

export type DropControl =
  | { type: "drop-hello"; v: number; sid: string; proof: string }
  | { type: "drop-ready"; proof: string }
  | { type: "drop-reject"; reason: "bad-password" | "expired" | "busy" | "protocol" }
  | { type: "drop-manifest"; files: P2PFileInfo[] }
  | { type: "file-end"; index: number; chunks: number }
  | { type: "done" }
  | { type: "drop-receipt"; files: number; bytes: number }
  | { type: "ack" }
  | { type: "cancel"; reason?: string };

const MAX_FILES = 1000;

export function parseDropControl(text: string): DropControl | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const isStr = (v: unknown, max = 512) => typeof v === "string" && v.length > 0 && v.length <= max;
  const isInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  switch (msg.type) {
    case "drop-hello":
      return msg.v === DROP_PROTOCOL_VERSION && isStr(msg.sid, 64) && isStr(msg.proof) ? (msg as DropControl) : null;
    case "drop-ready":
      return isStr(msg.proof) ? (msg as DropControl) : null;
    case "drop-reject":
      return ["bad-password", "expired", "busy", "protocol"].includes(msg.reason as string) ? (msg as DropControl) : null;
    case "drop-manifest": {
      const files = msg.files;
      if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return null;
      const ok = files.every((f) => f && typeof f.name === "string" && isInt(f.size) && (f.mime === undefined || typeof f.mime === "string"));
      if (!ok) return null;
      return {
        type: "drop-manifest",
        files: files.map((f) => ({ name: safeFileName(f.name), size: f.size, mime: String(f.mime || "application/octet-stream").slice(0, 128) })),
      };
    }
    case "file-end":
      return isInt(msg.index) && isInt(msg.chunks) ? (msg as DropControl) : null;
    case "drop-receipt":
      return isInt(msg.files) && isInt(msg.bytes) ? (msg as DropControl) : null;
    case "done":
    case "ack":
      return { type: msg.type };
    case "cancel":
      return { type: "cancel", ...(typeof msg.reason === "string" ? { reason: msg.reason.slice(0, 64) } : {}) };
    default:
      return null;
  }
}
