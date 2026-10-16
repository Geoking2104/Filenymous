/**
 * "Canal de signalement" client crypto (all in the browser, WebCrypto only).
 *
 * Organisation key pair: ECDH P-256 (supported by every WebCrypto engine;
 * X25519 is not yet universal). The private key never leaves the browser
 * except inside the passphrase-encrypted key file.
 *
 * Sealed box (HPKE-style, base mode):
 *   e      = ephemeral ECDH P-256 key pair
 *   shared = ECDH(e.priv, orgPub)
 *   key    = HKDF-SHA256(shared, salt = e.pub ‖ orgPub, info = "filenymous-report-v1|<context>")
 *   out    = { epk: e.pub, iv, ct: AES-256-GCM(key, iv, plaintext, aad = context) }
 *
 * Follow-up key F (32 random bytes, shown once to the reporter, never sent):
 *   id    = HKDF(F, "id")[:16]     → report id on the server
 *   token = HKDF(F, "auth")        → server stores sha256(token) only
 *   reply = HKDF(F, "reply")       → AES-256-GCM key; given to the org inside
 *                                    the sealed report, used for its replies.
 */
import { b64urlDecode, b64urlEncode } from "../p2p/protocol";

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => crypto.subtle;
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;
const P256 = { name: "ECDH", namedCurve: "P-256" } as const;
export const KEYFILE_FORMAT = "filenymous-report-key";
const PBKDF2_ITERATIONS = 310_000;

export interface Sealed { epk: string; iv: string; ct: string }
export interface SymMsg { iv: string; ct: string }

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await subtle().digest("SHA-256", buf(bytes)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Human-checkable fingerprint of a public key: 8 groups of 4 hex chars. */
export async function fingerprint(pubB64: string): Promise<string> {
  const h = (await sha256Hex(b64urlDecode(pubB64))).slice(0, 32).toUpperCase();
  return h.match(/.{4}/g)!.join(" ");
}

export async function importPub(pubB64: string): Promise<CryptoKey> {
  const raw = b64urlDecode(pubB64);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("bad-key");
  return subtle().importKey("raw", buf(raw), P256, true, []);
}

export interface MailboxKeys { priv: CryptoKey; pub: string; admin: string }

export async function generateMailboxKeys(): Promise<MailboxKeys> {
  const kp = (await subtle().generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = b64urlEncode(new Uint8Array(await subtle().exportKey("raw", kp.publicKey)));
  return { priv: kp.privateKey, pub, admin: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))) };
}

async function sealKey(shared: ArrayBuffer, epk: Uint8Array, pub: Uint8Array, context: string): Promise<CryptoKey> {
  const ikm = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(concat(epk, pub)), info: buf(enc.encode(`filenymous-report-v1|${context}`)) },
    ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export async function seal(pubB64: string, plain: Uint8Array, context: string): Promise<Sealed> {
  const pub = await importPub(pubB64);
  const e = (await subtle().generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
  const epk = new Uint8Array(await subtle().exportKey("raw", e.publicKey));
  const shared = await subtle().deriveBits({ name: "ECDH", public: pub }, e.privateKey, 256);
  const key = await sealKey(shared, epk, b64urlDecode(pubB64), context);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(enc.encode(context)) }, key, buf(plain)));
  return { epk: b64urlEncode(epk), iv: b64urlEncode(iv), ct: b64urlEncode(ct) };
}

export async function open(priv: CryptoKey, pubB64: string, s: Sealed, context: string): Promise<Uint8Array> {
  const epkRaw = b64urlDecode(s.epk);
  const epk = await subtle().importKey("raw", buf(epkRaw), P256, false, []);
  const shared = await subtle().deriveBits({ name: "ECDH", public: epk }, priv, 256);
  const key = await sealKey(shared, epkRaw, b64urlDecode(pubB64), context);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: buf(b64urlDecode(s.iv)), additionalData: buf(enc.encode(context)) }, key, buf(b64urlDecode(s.ct))));
}

export async function symEncrypt(keyRaw: Uint8Array, plain: Uint8Array, context: string): Promise<SymMsg> {
  const key = await subtle().importKey("raw", buf(keyRaw), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(enc.encode(context)) }, key, buf(plain)));
  return { iv: b64urlEncode(iv), ct: b64urlEncode(ct) };
}

export async function symDecrypt(keyRaw: Uint8Array, m: SymMsg, context: string): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", buf(keyRaw), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: buf(b64urlDecode(m.iv)), additionalData: buf(enc.encode(context)) }, key, buf(b64urlDecode(m.ct))));
}

// ---- follow-up key -------------------------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newFollowSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** 52 base32 characters in groups of 4: easy to copy or write down. */
export function formatFollowKey(f: Uint8Array): string {
  let bits = 0, v = 0, out = "";
  for (const b of f) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) out += B32[(v >>> (bits - 5)) & 31], (bits -= 5);
  }
  if (bits) out += B32[(v << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

export function parseFollowKey(s: string): Uint8Array | null {
  const c = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (c.length !== 52) return null;
  const out: number[] = [];
  let bits = 0, v = 0;
  for (const ch of c) {
    v = (v << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) out.push((v >>> (bits - 8)) & 255), (bits -= 8);
  }
  return new Uint8Array(out.slice(0, 32));
}

export interface FollowKeys { id: string; token: string; auth: string; reply: Uint8Array }

export async function deriveFollow(f: Uint8Array): Promise<FollowKeys> {
  const ikm = await subtle().importKey("raw", buf(f), "HKDF", false, ["deriveBits"]);
  const bits = async (info: string, n: number) =>
    new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(enc.encode("filenymous-report-follow-v1")), info: buf(enc.encode(info)) }, ikm, n * 8));
  const token = await bits("auth", 32);
  return { id: b64urlEncode(await bits("id", 16)), token: b64urlEncode(token), auth: await sha256Hex(token), reply: await bits("reply", 32) };
}

// ---- report payload --------------------------------------------------------
export interface FileMeta { status: "cleaned" | "nothing-found" | "partial" | "unsupported"; removed: string[]; remaining: string[] }
export interface ReportFile { name: string; type: string; size: number; meta: FileMeta; data: Uint8Array }
export interface ReportPayload { v: 1; text: string; reply: string; files: ReportFile[] }

/** 4-byte length ‖ JSON header ‖ file bytes. */
export function encodePayload(p: ReportPayload): Uint8Array {
  const header = enc.encode(JSON.stringify({ v: 1, text: p.text, reply: p.reply, files: p.files.map(({ data: _d, ...f }) => ({ ...f, size: _d.length })) }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length);
  return concat(len, header, ...p.files.map((f) => f.data));
}

export function decodePayload(bytes: Uint8Array): ReportPayload {
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const h = JSON.parse(dec.decode(bytes.subarray(4, 4 + n)));
  if (h.v !== 1 || typeof h.text !== "string" || !Array.isArray(h.files)) throw new Error("bad-payload");
  let o = 4 + n;
  const files: ReportFile[] = h.files.map((f: Omit<ReportFile, "data">) => {
    const data = bytes.slice(o, o + f.size);
    o += f.size;
    return { ...f, data };
  });
  return { v: 1, text: h.text, reply: h.reply, files };
}

export const textBytes = (s: string) => enc.encode(JSON.stringify({ text: s }));
export const bytesText = (b: Uint8Array): string => String(JSON.parse(dec.decode(b)).text ?? "");

// ---- passphrase-protected key file ---------------------------------------
export interface KeyFile { format: typeof KEYFILE_FORMAT; v: 1; mailbox: string; pub: string; salt: string; iv: string; ct: string }

async function passKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const pk = await subtle().importKey("raw", buf(enc.encode(passphrase.normalize("NFC"))), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", salt: buf(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, pk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function exportKeyFile(mailbox: string, keys: MailboxKeys, passphrase: string): Promise<KeyFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const jwk = await subtle().exportKey("jwk", keys.priv);
  const plain = enc.encode(JSON.stringify({ d: jwk.d, x: jwk.x, y: jwk.y, admin: keys.admin }));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(enc.encode(`${mailbox}|${keys.pub}`)) }, await passKey(passphrase, salt), buf(plain)));
  return { format: KEYFILE_FORMAT, v: 1, mailbox, pub: keys.pub, salt: b64urlEncode(salt), iv: b64urlEncode(iv), ct: b64urlEncode(ct) };
}

export function parseKeyFile(text: string): KeyFile | null {
  try {
    const k = JSON.parse(text);
    if (k?.format !== KEYFILE_FORMAT || k.v !== 1 || !/^[A-Za-z0-9_-]{22}$/.test(k.mailbox) || !/^[A-Za-z0-9_-]{87}$/.test(k.pub)) return null;
    return k as KeyFile;
  } catch {
    return null;
  }
}

/** Throws "bad-passphrase" when the passphrase is wrong (GCM tag mismatch). */
export async function unlockKeyFile(k: KeyFile, passphrase: string): Promise<MailboxKeys> {
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: buf(b64urlDecode(k.iv)), additionalData: buf(enc.encode(`${k.mailbox}|${k.pub}`)) }, await passKey(passphrase, b64urlDecode(k.salt)), buf(b64urlDecode(k.ct))));
  } catch {
    throw new Error("bad-passphrase");
  }
  const s = JSON.parse(dec.decode(plain));
  const priv = await subtle().importKey("jwk", { kty: "EC", crv: "P-256", d: s.d, x: s.x, y: s.y, ext: true }, P256, true, ["deriveBits"]);
  return { priv, pub: k.pub, admin: s.admin };
}

// ---- links -----------------------------------------------------------------
export const REPORT_HASH = /^#report:([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{87})$/;
export function buildReportLink(base: string, mailbox: string, pub: string): string {
  return `${base}#report:${mailbox}/${pub}`;
}
export function parseReportHash(hash: string): { mailbox: string; pub: string } | null {
  const m = hash.match(REPORT_HASH);
  return m ? { mailbox: m[1], pub: m[2] } : null;
}
