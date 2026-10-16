/**
 * Secrets Vault client crypto (zero-knowledge, burn-after-reading).
 *
 * K       = 32 random bytes, only in the link fragment: `#s:<id>/<K>`
 * ikm     = K ‖ PBKDF2-SHA256(password, salt, 310 000)   (password optional)
 * encKey  = HKDF-SHA256(ikm, info "enc")  → AES-256-GCM, random 96-bit IV
 * token   = HKDF-SHA256(ikm, info "auth") → 32 bytes; the server stores only
 *           sha256(token) and requires the token to reveal, so neither the id
 *           alone nor a wrong password can burn the secret.
 */
import { b64urlDecode, b64urlEncode } from "../p2p/protocol";

export const MAX_SECRET_BYTES = 64 * 1024;
const PBKDF2_ITERATIONS = 310_000;
const enc = new TextEncoder();

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function ikm(key: Uint8Array, password?: string, salt?: Uint8Array): Promise<CryptoKey> {
  let material = key;
  if (password !== undefined) {
    if (!salt) throw new Error("salt required");
    const pwKey = await crypto.subtle.importKey("raw", buf(enc.encode(password.normalize("NFC"))), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "PBKDF2", salt: buf(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, pwKey, 256),
    );
    material = new Uint8Array(key.length + bits.length);
    material.set(key);
    material.set(bits, key.length);
  }
  return crypto.subtle.importKey("raw", buf(material), "HKDF", false, ["deriveKey", "deriveBits"]);
}

const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: buf(enc.encode("filenymous-vault-v1")), info: buf(enc.encode(info)) });

async function keys(key: Uint8Array, password?: string, salt?: Uint8Array) {
  const base = await ikm(key, password, salt);
  const encKey = await crypto.subtle.deriveKey(hkdf("enc"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const token = new Uint8Array(await crypto.subtle.deriveBits(hkdf("auth"), base, 256));
  return { encKey, token };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf(bytes)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SealedSecret {
  /** Request body for POST /api/v1/secrets (without ttl/reads). */
  body: { v: 1; ct: string; iv: string; salt?: string; pw: boolean; auth: string };
  /** Goes in the link fragment only. */
  key: string;
}

export async function sealSecret(text: string, password?: string): Promise<SealedSecret> {
  const plain = enc.encode(text);
  if (plain.byteLength === 0) throw new Error("empty");
  if (plain.byteLength > MAX_SECRET_BYTES) throw new Error("too-large");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const pw = !!password;
  const salt = pw ? crypto.getRandomValues(new Uint8Array(16)) : undefined;
  const { encKey, token } = await keys(key, pw ? password : undefined, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, encKey, buf(plain)));
  return {
    key: b64urlEncode(key),
    body: { v: 1, ct: b64urlEncode(ct), iv: b64urlEncode(iv), ...(salt ? { salt: b64urlEncode(salt) } : {}), pw, auth: await sha256Hex(token) },
  };
}

/** Token sent to /reveal (derived before any consuming request). */
export async function revealToken(key: string, password?: string, salt?: string): Promise<{ token: string; encKey: CryptoKey }> {
  const k = await keys(b64urlDecode(key), password, salt ? b64urlDecode(salt) : undefined);
  return { token: b64urlEncode(k.token), encKey: k.encKey };
}

export async function openSecret(encKey: CryptoKey, ct: string, iv: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(b64urlDecode(iv)) }, encKey, buf(b64urlDecode(ct)));
  return new TextDecoder().decode(pt);
}

export function buildSecretLink(baseUrl: string, id: string, key: string): string {
  return `${baseUrl.split("#")[0]}#s:${id}/${key}`;
}

/** `key` is absent once the page stripped it from the address bar after reading. */
export function parseSecretLink(input: string): { id: string; key?: string } | null {
  const at = input.indexOf("#");
  const raw = at >= 0 ? input.slice(at + 1) : input;
  const m = raw.match(/^s:([A-Za-z0-9_-]{22})(?:\/([A-Za-z0-9_-]{43}))?$/);
  if (!m) return null;
  return m[2] ? { id: m[1]!, key: m[2] } : { id: m[1]! };
}

export function isSecretHash(hash: string): boolean {
  return /^#s:/.test(hash);
}
