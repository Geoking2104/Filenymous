/**
 * AES-256-GCM encrypt / decrypt using the browser's native SubtleCrypto API.
 *
 * Chunk format on the DHT:
 *   [ 12-byte nonce || ciphertext || 16-byte authentication tag ]
 *
 * The AES key itself is generated once per transfer and wrapped with the
 * recipient's X25519 public key (ECIES scheme — see ecies.ts, M3).
 * For M2 the key is transmitted in the link URL for simplicity (marked TODO).
 */

const AES_ALGO  = "AES-GCM";
const KEY_BITS  = 256;
const NONCE_LEN = 12; // 96-bit nonce recommended for GCM

/** Generate a fresh AES-256-GCM key for a transfer */
export async function generateAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: AES_ALGO, length: KEY_BITS },
    true,       // extractable — needed to export for transmission
    ["encrypt", "decrypt"]
  );
}

/** Export a CryptoKey to raw bytes (32 bytes for AES-256) */
export async function exportAesKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

/** Import raw bytes as an AES-256-GCM CryptoKey */
export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: AES_ALGO, length: KEY_BITS },
    false,
    ["decrypt"]
  );
}

/**
 * Encrypt a chunk of plaintext.
 * Returns: Uint8Array = [nonce (12 B)] + [ciphertext + tag]
 */
export async function encryptChunk(
  key: CryptoKey,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_ALGO, iv: nonce },
    key,
    plaintext
  );
  const result = new Uint8Array(NONCE_LEN + ciphertext.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(ciphertext), NONCE_LEN);
  return result;
}

/**
 * Decrypt a chunk.
 * Input: Uint8Array = [nonce (12 B)] + [ciphertext + tag]
 */
export async function decryptChunk(
  key: CryptoKey,
  encrypted: Uint8Array
): Promise<Uint8Array> {
  const nonce      = encrypted.slice(0, NONCE_LEN);
  const ciphertext = encrypted.slice(NONCE_LEN);
  const plaintext  = await crypto.subtle.decrypt(
    { name: AES_ALGO, iv: nonce },
    key,
    ciphertext
  );
  return new Uint8Array(plaintext);
}

/** SHA-256 hex of a buffer (used for chunk integrity) */
export async function sha256hex(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(h))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
