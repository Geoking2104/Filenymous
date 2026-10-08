/**
 * Browser-only self-contained encrypted link ("Magic Link").
 *
 * When there is no Holochain conductor (the production reality for
 * filenymous.eu, since the Holo Web Conductor is not deployed), the normal
 * DHT parcel flow cannot run. This module provides a fully client-side
 * fallback: the file is encrypted in the browser and the ciphertext is
 * embedded directly in the URL fragment, together with either the AES key
 * or a password-wrapped version of it.
 *
 * The recipient opens the link; ReceivePanel detects the `sl`/`slp` scheme
 * and decrypts the blob locally. No server, no conductor, no peer presence.
 *
 * Link formats (URL fragment):
 *   #sl=<b64url(ciphertext)>.<b64url(aesRawKey)>.<b64url(json meta)>
 *   #slp=<b64url(ciphertext)>.<b64url(wrappedKey)>.<b64url(salt)>.<b64url(json meta)>
 * where meta = { name, type, size }.
 *
 * `slp` (password mode): the AES key is wrapped with a KEK derived from the
 * password via Argon2id (see crypto/password.ts). The link alone is not
 * enough to decrypt — the password must be shared out-of-band.
 *
 * Security note: the key travels in the link (or is password-derived), so
 * the link (+ password) IS the capability. This matches the standalone
 * app's documented "self-contained link" design.
 */

import { generateAesKey, exportAesKey, importAesKey, decryptChunk } from "../crypto/aes";
import { toArrayBuffer } from "../crypto/buffer";
import { b64urlEncode, b64urlDecode } from "../crypto/b64url";
import { wrapKeyWithPassword, unwrapKeyWithPassword } from "../crypto/password";

// Keep the link shareable: URLs get unwieldy past a few MB. Match the
// standalone app's 8 MiB ceiling for inline links.
export const WEB_LINK_MAX_BYTES = 8 * 1024 * 1024;

const NONCE_LEN = 12; // matches aes.ts

export interface WebLinkResult {
  /** Full URL with the encrypted payload in the fragment. */
  url: string;
  size: number;
  passwordProtected: boolean;
}

interface LinkMeta {
  name: string;
  type: string;
  size: number;
}

function encodeMeta(meta: LinkMeta): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(meta)));
}

function decodeMeta(b64: string): LinkMeta {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(b64))) as LinkMeta;
}

/**
 * Encrypt `file` entirely in the browser and return a self-contained link.
 * Throws if the file exceeds WEB_LINK_MAX_BYTES.
 * When `password` is provided, the key is Argon2id-wrapped (slp format).
 */
export async function createWebLink(
  file: File,
  opts: { password?: string } = {},
): Promise<WebLinkResult> {
  if (file.size > WEB_LINK_MAX_BYTES) {
    throw new Error(
      `File too large for a self-contained link (max ${Math.round(WEB_LINK_MAX_BYTES / (1024 * 1024))} MB).`,
    );
  }

  const key = await generateAesKey();
  const aesRaw = await exportAesKey(key);

  const plaintext = new Uint8Array(await file.arrayBuffer());
  // Single GCM chunk: [12-byte nonce || ciphertext || 16-byte tag].
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(plaintext),
  );
  const cipher = new Uint8Array(NONCE_LEN + ct.byteLength);
  cipher.set(nonce, 0);
  cipher.set(new Uint8Array(ct), NONCE_LEN);

  const meta = encodeMeta({ name: file.name, type: file.type, size: file.size });

  let fragment: string;
  if (opts.password) {
    const { salt, wrapped } = await wrapKeyWithPassword(opts.password, aesRaw);
    fragment = `slp=${b64urlEncode(cipher)}.${b64urlEncode(wrapped)}.${b64urlEncode(salt)}.${meta}`;
  } else {
    fragment = `sl=${b64urlEncode(cipher)}.${b64urlEncode(aesRaw)}.${meta}`;
  }

  const url = `${window.location.origin}${window.location.pathname}#${fragment}`;
  return { url, size: file.size, passwordProtected: Boolean(opts.password) };
}

/** True when a fragment (with or without leading #) is a self-contained link. */
export function isWebLinkFragment(fragment: string): boolean {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return raw.startsWith("sl=") || raw.startsWith("slp=");
}

export interface ParsedWebLink {
  cipher: Uint8Array;
  name: string;
  type: string;
  size: number;
  /** True until the password is supplied (slp links only). */
  locked: boolean;
  /** Present once unlocked (or immediately for plain sl links). */
  key?: CryptoKey;
  /** Password mode: wrapped key bytes ([nonce || ct]). */
  wrapped?: Uint8Array;
  /** Password mode: Argon2id salt. */
  salt?: Uint8Array;
}

/** Parse a `#sl=...` or `#slp=...` fragment into its parts (does not decrypt yet). */
export async function parseWebLink(fragment: string): Promise<ParsedWebLink | null> {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;

  if (raw.startsWith("sl=")) {
    const [cipherB64, keyB64, metaB64] = raw.slice(3).split(".");
    if (!cipherB64 || !keyB64 || !metaB64) return null;
    const meta = decodeMeta(metaB64);
    return {
      cipher: b64urlDecode(cipherB64),
      name: meta.name,
      type: meta.type,
      size: meta.size,
      locked: false,
      key: await importAesKey(b64urlDecode(keyB64)),
    };
  }

  if (raw.startsWith("slp=")) {
    const [cipherB64, wrappedB64, saltB64, metaB64] = raw.slice(4).split(".");
    if (!cipherB64 || !wrappedB64 || !saltB64 || !metaB64) return null;
    const meta = decodeMeta(metaB64);
    return {
      cipher: b64urlDecode(cipherB64),
      name: meta.name,
      type: meta.type,
      size: meta.size,
      locked: true,
      wrapped: b64urlDecode(wrappedB64),
      salt: b64urlDecode(saltB64),
    };
  }

  return null;
}

/**
 * Unlock a password-protected (slp) link.
 * Throws when the password is wrong. On success the parsed link carries
 * the decryption key and `locked` flips to false.
 */
export async function unlockWebLink(parsed: ParsedWebLink, password: string): Promise<CryptoKey> {
  if (!parsed.locked || !parsed.wrapped || !parsed.salt) {
    throw new Error("link_not_locked");
  }
  const raw = await unwrapKeyWithPassword(password, parsed.salt, parsed.wrapped);
  const key = await importAesKey(raw);
  parsed.key = key;
  parsed.locked = false;
  return key;
}

/** Decrypt a parsed web link back into a Blob. Requires an unlocked link. */
export async function decryptWebLinkBlob(p: ParsedWebLink): Promise<Blob> {
  if (!p.key) throw new Error("link_locked");
  const plain = await decryptChunk(p.key, p.cipher);
  return new Blob([toBlobPartSafe(plain)], { type: p.type || "application/octet-stream" });
}

function toBlobPartSafe(u: Uint8Array): BlobPart {
  // ArrayBuffer view is a valid BlobPart on all modern browsers.
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
