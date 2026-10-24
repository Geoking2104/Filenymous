/**
 * Coffre-fort (persistent personal vault) — cryptographic core.
 *
 * Pure functions on top of WebCrypto (AES-256-GCM, HKDF, SHA-256, HMAC),
 * hash-wasm (Argon2id), @scure/bip39 (recovery phrase) and @noble/curves
 * (Ed25519 signatures, X25519 key agreement). Runs in the vault worker and in
 * unit tests (Node); never on the page's main thread for vault keys.
 *
 * Key hierarchy:
 *   master password ──Argon2id(t=3, m=64 MiB, p=4)──► KEK ──wraps──► vault DEK
 *   24-word phrase (256-bit entropy) ──HKDF──► recovery key ──wraps──► vault DEK (copy)
 *   passkey PRF output ──HKDF──► passkey key ──wraps──► vault DEK (optional copy)
 *   vault DEK ──AES-256-GCM──► every record, file chunk, embedding and contact
 */
import { argon2id } from "hash-wasm";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { ed25519, x25519 } from "@noble/curves/ed25519";

/** WebCrypto wants ArrayBuffer-backed views; this is a type-only cast (no copy). */
export const B = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/**
 * Best-effort wipe of a sensitive buffer (zeros, random, zeros). JavaScript
 * gives no guarantee that no other copy exists (strings, GC moves, WebCrypto
 * internals), so this reduces exposure; it is not a proof of erasure.
 */
export class SecureBuffer {
  static wipe(b: Uint8Array | null | undefined): void {
    if (!b || !(b instanceof Uint8Array) || b.length === 0) return;
    b.fill(0);
    for (let i = 0; i < b.length; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(b.length, i + 65536)));
    b.fill(0);
  }

  static async useAndDestroy<T>(b: Uint8Array, fn: (b: Uint8Array) => T | Promise<T>): Promise<T> {
    try {
      return await fn(b);
    } finally {
      SecureBuffer.wipe(b);
    }
  }
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", B(data)));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", B(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, B(data)));
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, len = 32): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", B(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: B(salt), info: B(enc.encode(info)) }, k, len * 8));
}

/* ── AES-256-GCM ─────────────────────────────────────────────────────────── */

export type Key = CryptoKey;

export function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", B(raw), { name: "AES-GCM" }, extractable, ["encrypt", "decrypt"]);
}

/** Ciphertext includes the 16-byte GCM tag (WebCrypto layout). */
export interface Sealed {
  iv: Uint8Array;
  ct: Uint8Array;
}

export async function aesSeal(key: CryptoKey, plain: Uint8Array, aad?: Uint8Array, iv = randomBytes(12)): Promise<Sealed> {
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: B(iv), ...(aad ? { additionalData: B(aad) } : {}) }, key, B(plain));
  return { iv, ct: new Uint8Array(ct) };
}

export async function aesOpen(key: CryptoKey, s: Sealed, aad?: Uint8Array): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: B(s.iv), ...(aad ? { additionalData: B(aad) } : {}) }, key, B(s.ct));
  return new Uint8Array(pt);
}

/** [iv(12) || ct] blob form, used for wrapped keys stored in the vault header. */
export const packSealed = (s: Sealed) => concat(s.iv, s.ct);
export const unpackSealed = (b: Uint8Array): Sealed => ({ iv: b.slice(0, 12), ct: b.slice(12) });

export async function sealJson(key: CryptoKey, value: unknown, aad?: string): Promise<Sealed> {
  const bytes = enc.encode(JSON.stringify(value));
  try {
    return await aesSeal(key, bytes, aad ? enc.encode(aad) : undefined);
  } finally {
    SecureBuffer.wipe(bytes);
  }
}

export async function openJson<T>(key: CryptoKey, s: Sealed, aad?: string): Promise<T> {
  const bytes = await aesOpen(key, s, aad ? enc.encode(aad) : undefined);
  try {
    return JSON.parse(dec.decode(bytes)) as T;
  } finally {
    SecureBuffer.wipe(bytes);
  }
}

/* ── Key derivation & wrapping ───────────────────────────────────────────── */

export interface KdfParams {
  alg: "argon2id";
  salt: string; // b64u, 16 bytes
  t: number;
  m: number; // KiB
  p: number;
}

/** Spec parameters: t=3, m=64 MiB, p=4, 32-byte output. */
export const KDF_DEFAULT = { t: 3, m: 65536, p: 4 } as const;

export function newKdfParams(over: Partial<Pick<KdfParams, "t" | "m" | "p">> = {}): KdfParams {
  return { alg: "argon2id", salt: b64u(randomBytes(16)), ...KDF_DEFAULT, ...over };
}

/** Master password → 32-byte KEK (raw bytes; the caller wipes them). */
export async function deriveKekBytes(password: string, p: KdfParams): Promise<Uint8Array> {
  const out = await argon2id({
    password: password.normalize("NFKC"),
    salt: fromB64u(p.salt),
    iterations: p.t,
    memorySize: p.m,
    parallelism: p.p,
    hashLength: 32,
    outputType: "binary",
  });
  return new Uint8Array(out);
}

export async function keyFromBytes(raw: Uint8Array, wipe = true): Promise<CryptoKey> {
  try {
    return await importAesKey(raw);
  } finally {
    if (wipe) SecureBuffer.wipe(raw);
  }
}

/** Wrap the raw DEK under a wrapping key; AAD binds the slot name. */
export async function wrapDek(wrapKey: CryptoKey, dekRaw: Uint8Array, slot: string): Promise<Uint8Array> {
  return packSealed(await aesSeal(wrapKey, dekRaw, enc.encode(`fny-safe/dek/${slot}`)));
}

export async function unwrapDek(wrapKey: CryptoKey, blob: Uint8Array, slot: string): Promise<Uint8Array> {
  return aesOpen(wrapKey, unpackSealed(blob), enc.encode(`fny-safe/dek/${slot}`));
}

/* ── Recovery phrase (BIP-39, 24 words) ──────────────────────────────────── */

export function newRecoveryEntropy(): Uint8Array {
  return randomBytes(32);
}

export function entropyToPhrase(entropy: Uint8Array): string {
  return entropyToMnemonic(entropy, wordlist);
}

export function phraseToEntropy(phrase: string): Uint8Array {
  const norm = normalizePhrase(phrase);
  if (!validateMnemonic(norm, wordlist)) throw new Error("bad-phrase");
  const e = mnemonicToEntropy(norm, wordlist);
  if (e.length !== 32) throw new Error("bad-phrase");
  return e;
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isPhraseValid(phrase: string): boolean {
  const norm = normalizePhrase(phrase);
  return norm.split(" ").length === 24 && validateMnemonic(norm, wordlist);
}

export const PHRASE_WORDS = wordlist;

/** 256-bit phrase entropy → recovery wrapping key (HKDF; no slow KDF needed at 256 bits). */
export async function recoveryKey(entropy: Uint8Array): Promise<CryptoKey> {
  return keyFromBytes(await hkdf(entropy, enc.encode("fny-safe/recovery/v1"), "fny-safe recovery wrap"));
}

/** Passkey PRF output (32 bytes) → wrapping key. */
export async function prfKey(prfOutput: Uint8Array): Promise<CryptoKey> {
  return keyFromBytes(await hkdf(prfOutput, enc.encode("fny-safe/passkey-prf/v1"), "fny-safe passkey wrap"));
}

/** Three distinct random word positions (0-based) for the backup check. */
export function pickCheckPositions(count = 3, total = 24): number[] {
  const set = new Set<number>();
  while (set.size < count) {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    set.add(r[0]! % total);
  }
  return [...set].sort((a, b) => a - b);
}

/* ── Files: 1 MiB chunks, per-chunk IV, SHA-256 Merkle root ─────────────── */

export const CHUNK_SIZE = 1024 * 1024;

export interface EncChunk {
  idx: number;
  iv: Uint8Array;
  ct: Uint8Array;
}

export async function encryptChunks(key: CryptoKey, data: Uint8Array, aadPrefix: string, chunkSize = CHUNK_SIZE): Promise<EncChunk[]> {
  const out: EncChunk[] = [];
  const n = Math.max(1, Math.ceil(data.length / chunkSize));
  for (let i = 0; i < n; i++) {
    const part = data.subarray(i * chunkSize, Math.min(data.length, (i + 1) * chunkSize));
    const s = await aesSeal(key, part, enc.encode(`${aadPrefix}#${i}/${n}`));
    out.push({ idx: i, iv: s.iv, ct: s.ct });
  }
  return out;
}

export async function decryptChunks(key: CryptoKey, chunks: EncChunk[], aadPrefix: string): Promise<Uint8Array> {
  const n = chunks.length;
  const parts: Uint8Array[] = [];
  for (const c of [...chunks].sort((a, b) => a.idx - b.idx)) parts.push(await aesOpen(key, { iv: c.iv, ct: c.ct }, enc.encode(`${aadPrefix}#${c.idx}/${n}`)));
  return concat(...parts);
}

/** Leaf = SHA-256(iv || ciphertext) of an encrypted chunk. */
export async function chunkLeaf(c: { iv: Uint8Array; ct: Uint8Array }): Promise<Uint8Array> {
  return sha256(concat(c.iv, c.ct));
}

/** Binary Merkle root (SHA-256, odd node promoted by self-pairing). */
export async function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return sha256(new Uint8Array());
  let level = leaves;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await sha256(concat(new Uint8Array([1]), level[i]!, level[i + 1] ?? level[i]!)));
    level = next;
  }
  return level[0]!;
}

/* ── Identity: Ed25519 (signatures) + X25519 (key agreement) ─────────────── */

export interface Identity {
  edSecret: Uint8Array; // 32-byte seed
  xSecret: Uint8Array; // 32-byte scalar
}

export interface PublicIdentity {
  ed: Uint8Array;
  x: Uint8Array;
  inbox: string; // relay inbox id: "wall-" + 24 hex
}

export function newIdentity(): Identity {
  return { edSecret: ed25519.utils.randomPrivateKey(), xSecret: x25519.utils.randomPrivateKey() };
}

export function publicKeys(id: Identity): { ed: Uint8Array; x: Uint8Array } {
  return { ed: ed25519.getPublicKey(id.edSecret), x: x25519.getPublicKey(id.xSecret) };
}

/** Secret that lets only this vault host its relay inbox (the relay checks sha256(secret) = inbox id). */
export async function inboxSecret(id: Identity): Promise<string> {
  return b64u(await hmacSha256(id.edSecret, enc.encode("fny-safe/inbox/v1")));
}

export async function inboxIdFor(secret: string): Promise<string> {
  return `wall-${hex(await sha256(enc.encode(secret))).slice(0, 24)}`;
}

const B32 = "abcdefghijkmnpqrstuvwxyz23456789"; // no l, o, 0, 1

/** Short human handle: fingerprint of both public keys, e.g. "fny-7k2m-q9xa-4bte-wn3c". */
export async function handleFor(ed: Uint8Array, x: Uint8Array): Promise<string> {
  const h = await sha256(concat(enc.encode("fny-safe/handle/v1"), ed, x));
  let bits = 0;
  let val = 0;
  let s = "";
  for (const byte of h.subarray(0, 10)) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      s += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `fny-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/** Contact card a user gives to others: "fny1." + b64u(ed || x || inbox(12 bytes)). */
export function encodeCard(p: PublicIdentity): string {
  const inbox = p.inbox.replace(/^wall-/, "");
  const ib = new Uint8Array(12);
  for (let i = 0; i < 12; i++) ib[i] = parseInt(inbox.slice(i * 2, i * 2 + 2), 16);
  return `fny1.${b64u(concat(p.ed, p.x, ib))}`;
}

export function decodeCard(card: string): PublicIdentity | null {
  const m = card.trim().match(/^fny1\.([A-Za-z0-9_-]{100,110})$/);
  if (!m) return null;
  try {
    const b = fromB64u(m[1]!);
    if (b.length !== 76) return null;
    return { ed: b.slice(0, 32), x: b.slice(32, 64), inbox: `wall-${hex(b.slice(64, 76))}` };
  } catch {
    return null;
  }
}

export function sign(id: Identity, msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, id.edSecret);
}

export function verify(pubEd: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, pubEd);
  } catch {
    return false;
  }
}

/**
 * HPKE-style base mode to a recipient's X25519 key: ephemeral X25519,
 * ECDH, HKDF-SHA256(salt = eph || recipient) → a one-time AES-256-GCM
 * content key. The returned raw key encrypts the share header and every
 * chunk (deterministic IVs are safe because the key is used for one share only).
 */
export async function shareKeyToRecipient(recipientX: Uint8Array): Promise<{ eph: Uint8Array; key: CryptoKey }> {
  const ephSecret = x25519.utils.randomPrivateKey();
  const eph = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, recipientX);
  SecureBuffer.wipe(ephSecret);
  const raw = await hkdf(shared, concat(eph, recipientX), "fny-safe/share/v1");
  SecureBuffer.wipe(shared);
  return { eph, key: await keyFromBytes(raw) };
}

export async function shareKeyFromSender(id: Identity, eph: Uint8Array): Promise<CryptoKey> {
  const myX = x25519.getPublicKey(id.xSecret);
  const shared = x25519.getSharedSecret(id.xSecret, eph);
  const raw = await hkdf(shared, concat(eph, myX), "fny-safe/share/v1");
  SecureBuffer.wipe(shared);
  return keyFromBytes(raw);
}

/** IV for frame `idx` of a one-time share key (0 = header, i+1 = chunk i). */
export function shareIv(idx: number): Uint8Array {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(0, 0x46_4e_59_53); // "FNYS"
  new DataView(iv.buffer).setBigUint64(4, BigInt(idx));
  return iv;
}
