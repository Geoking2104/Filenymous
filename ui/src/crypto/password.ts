/**
 * Password-based key protection for Filenymous transfers.
 *
 * Zero-knowledge design (SwissTransfer-style "optional password"):
 *   - The file key is a random AES-256 key.
 *   - When a password is set, the file key is wrapped with a KEK derived
 *     from the password via Argon2id (memory-hard KDF).
 *   - Only the KDF salt (public) and the wrapped key travel in the link.
 *     The password itself never leaves the browser and never travels.
 *
 * Wrapped blob format: [ 12-byte nonce || AES-256-GCM ciphertext+tag ].
 * Parameters follow the OWASP baseline for Argon2id (19 MiB, t=2, p=1).
 */

import { argon2id } from "hash-wasm";
import { toArrayBuffer } from "./buffer";

export const ARGON2ID_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19456, // KiB (~19 MiB)
  hashLength: 32,
} as const;

export const SALT_LEN = 16;
const NONCE_LEN = 12;

export function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

function importKek(kekBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(kekBytes), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Derive a KEK (key-encryption key) from a password + salt via Argon2id. */
export async function deriveKek(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const kekBytes = await argon2id({
    password,
    salt,
    parallelism: ARGON2ID_PARAMS.parallelism,
    iterations: ARGON2ID_PARAMS.iterations,
    memorySize: ARGON2ID_PARAMS.memorySize,
    hashLength: ARGON2ID_PARAMS.hashLength,
    outputType: "binary",
  });
  return importKek(kekBytes);
}

export interface WrappedKey {
  /** Random KDF salt (16 bytes) — not secret. */
  salt: Uint8Array;
  /** [nonce || ciphertext+tag] of the raw file key under the KEK. */
  wrapped: Uint8Array;
}

/** Wrap a raw AES key with a password-derived KEK (random salt). */
export async function wrapKeyWithPassword(
  password: string,
  rawKey: Uint8Array,
): Promise<WrappedKey> {
  const salt = randomBytes(SALT_LEN);
  const kek = await deriveKek(password, salt);
  const nonce = randomBytes(NONCE_LEN);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce) },
      kek,
      toArrayBuffer(rawKey),
    ),
  );
  const wrapped = new Uint8Array(NONCE_LEN + ct.length);
  wrapped.set(nonce, 0);
  wrapped.set(ct, NONCE_LEN);
  return { salt, wrapped };
}

/**
 * Unwrap a raw AES key using a password.
 * Throws (OperationError) when the password is wrong.
 */
export async function unwrapKeyWithPassword(
  password: string,
  salt: Uint8Array,
  wrapped: Uint8Array,
): Promise<Uint8Array> {
  const kek = await deriveKek(password, salt);
  const nonce = wrapped.slice(0, NONCE_LEN);
  const ct = wrapped.slice(NONCE_LEN);
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    kek,
    toArrayBuffer(ct),
  );
  return new Uint8Array(raw);
}
