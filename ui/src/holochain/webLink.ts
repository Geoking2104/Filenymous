/**
 * Browser-only self-contained encrypted link ("Magic Link").
 *
 * When there is no Holochain conductor (the production reality for
 * filenymous.eu, since the Holo Web Conductor is not deployed), the normal
 * DHT parcel flow cannot run. This module provides a fully client-side
 * fallback: the file is encrypted in the browser and the ciphertext is
 * embedded directly in the URL fragment, together with the AES key.
 *
 * The recipient opens the link; ReceivePanel detects the `sl` scheme and
 * decrypts the blob locally. No server, no conductor, no peer presence.
 *
 * Link format (URL fragment):
 *   #sl=<b64url(ciphertext)>.<b64url(aesRawKey)>.<b64url(json meta)>
 * where meta = { name, type, size }.
 *
 * Security note: the key travels in the link, so the link IS the capability.
 * This matches the standalone app's documented "self-contained link" design.
 */

import { generateAesKey, exportAesKey, importAesKey, decryptChunk } from "../crypto/aes";
import { toArrayBuffer } from "../crypto/buffer";

// Keep the link shareable: URLs get unwieldy past a few MB. Match the
// standalone app's 8 MiB ceiling for inline links.
export const WEB_LINK_MAX_BYTES = 8 * 1024 * 1024;

const NONCE_LEN = 12; // matches aes.ts

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export interface WebLinkResult {
  /** Full URL with the encrypted payload in the fragment. */
  url: string;
  size: number;
}

/**
 * Encrypt `file` entirely in the browser and return a self-contained link.
 * Throws if the file exceeds WEB_LINK_MAX_BYTES.
 */
export async function createWebLink(file: File): Promise<WebLinkResult> {
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

  const meta = b64url(
    new TextEncoder().encode(JSON.stringify({ name: file.name, type: file.type, size: file.size })),
  );

  const fragment = `sl=${b64url(cipher)}.${b64url(aesRaw)}.${meta}`;
  const url = `${window.location.origin}${window.location.pathname}#${fragment}`;
  return { url, size: file.size };
}

export interface ParsedWebLink {
  cipher: Uint8Array;
  key: CryptoKey;
  name: string;
  type: string;
  size: number;
}

/** Parse a `#sl=...` fragment into its parts (does not decrypt yet). */
export async function parseWebLink(fragment: string): Promise<ParsedWebLink | null> {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!raw.startsWith("sl=")) return null;
  const body = raw.slice(3);
  const [cipherB64, keyB64, metaB64] = body.split(".");
  if (!cipherB64 || !keyB64 || !metaB64) return null;

  const cipher = fromB64url(cipherB64);
  const key = await importAesKey(fromB64url(keyB64));
  const meta = JSON.parse(new TextDecoder().decode(fromB64url(metaB64))) as {
    name: string;
    type: string;
    size: number;
  };

  return { cipher, key, name: meta.name, type: meta.type, size: meta.size };
}

/** Decrypt a parsed web link back into a Blob. */
export async function decryptWebLinkBlob(p: ParsedWebLink): Promise<Blob> {
  const plain = await decryptChunk(p.key, p.cipher);
  return new Blob([toBlobPartSafe(plain)], { type: p.type || "application/octet-stream" });
}

function toBlobPartSafe(u: Uint8Array): BlobPart {
  // ArrayBuffer view is a valid BlobPart on all modern browsers.
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
