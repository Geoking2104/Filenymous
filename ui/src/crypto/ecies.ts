/**
 * M3 — ECIES (Elliptic Curve Integrated Encryption Scheme)
 * using X25519 Diffie-Hellman + HKDF-SHA256 + AES-256-GCM.
 *
 * All crypto via native WebCrypto API (no deps, cross-browser).
 *
 * Wire format of `encrypted_key_blob` (total: 32 + 12 + 48 = 92 bytes):
 *   [0..32]  ephemeral X25519 public key (raw, 32 bytes)
 *   [32..44] AES-GCM nonce (12 bytes)
 *   [44..92] AES-GCM ciphertext of the 32-byte AES session key
 *            + 16-byte authentication tag (32 + 16 = 48 bytes)
 */

// ── Key generation ───────────────────────────────────────────────────────────

export interface X25519KeyPair {
  publicKey: CryptoKey;   // extractable, raw = 32 bytes
  privateKey: CryptoKey;  // extractable for IndexedDB storage
}

/**
 * Generate an X25519 keypair for ECIES.
 * Both keys are extractable so they can be persisted in IndexedDB.
 */
export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "X25519" },
    true,               // extractable — needed for IDB storage + DHT publish
    ["deriveKey", "deriveBits"],
  ) as CryptoKeyPair;

  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/**
 * Export an X25519 public key to raw 32-byte Uint8Array.
 */
export async function exportX25519PublicKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

/**
 * Export an X25519 private key to PKCS8 bytes (for IndexedDB storage).
 */
export async function exportX25519PrivateKey(key: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key);
  return new Uint8Array(pkcs8);
}

/**
 * Import a raw 32-byte X25519 public key (received from DHT).
 */
export async function importX25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "X25519" },
    false,
    [],   // public key has no usages in WebCrypto; ECDH is initiated by the private key
  );
}

/**
 * Import an X25519 private key from PKCS8 bytes (from IndexedDB).
 */
export async function importX25519PrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "X25519" },
    false,
    ["deriveKey", "deriveBits"],
  );
}

// ── ECIES encrypt ────────────────────────────────────────────────────────────

/**
 * Encrypt a 32-byte AES session key for a recipient identified by their
 * X25519 public key.
 *
 * @param aesKeyBytes   Raw 32-byte AES-256 session key.
 * @param recipientPubKey  Recipient's X25519 public key (from DHT).
 * @returns  92-byte blob: [ephemeralPub(32) | nonce(12) | ciphertext+tag(48)]
 */
export async function encryptAesKeyForRecipient(
  aesKeyBytes: Uint8Array,
  recipientPubKey: CryptoKey,
): Promise<Uint8Array> {
  if (aesKeyBytes.length !== 32) {
    throw new Error("AES session key must be 32 bytes");
  }

  // 1. Generate ephemeral X25519 keypair for this transfer
  const ephemeral = await generateX25519KeyPair();
  const ephemeralPubRaw = await exportX25519PublicKey(ephemeral.publicKey);

  // 2. ECDH: derive shared secret bytes
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: recipientPubKey },
    ephemeral.privateKey,
    256, // 32 bytes of shared secret
  );

  // 3. HKDF-SHA256: derive a wrapping key from the shared secret
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ephemeralPubRaw,   // ephemeral public key as salt for domain separation
      info: new TextEncoder().encode("filenymous-v1-key-wrap"),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  // 4. AES-GCM encrypt the 32-byte AES session key
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    wrappingKey,
    aesKeyBytes,
  );

  // 5. Assemble blob: ephemeralPub(32) | nonce(12) | ciphertext+tag(48)
  const blob = new Uint8Array(32 + 12 + ciphertext.byteLength);
  blob.set(ephemeralPubRaw, 0);
  blob.set(nonce, 32);
  blob.set(new Uint8Array(ciphertext), 44);
  return blob;
}

// ── ECIES decrypt ────────────────────────────────────────────────────────────

/**
 * Decrypt the `encrypted_key_blob` stored in the TransferManifest.
 *
 * @param blob           92-byte blob from TransferManifest.encrypted_key_blob.
 * @param recipientPrivKey  Recipient's X25519 private key (from IndexedDB).
 * @returns  Raw 32-byte AES-256 session key.
 */
export async function decryptAesKeyFromBlob(
  blob: Uint8Array,
  recipientPrivKey: CryptoKey,
): Promise<Uint8Array> {
  if (blob.length < 92) {
    throw new Error(`encrypted_key_blob too short: ${blob.length} bytes (expected 92)`);
  }

  // 1. Parse blob
  const ephemeralPubRaw = blob.slice(0, 32);
  const nonce           = blob.slice(32, 44);
  const ciphertext      = blob.slice(44);

  // 2. Import ephemeral public key
  const ephemeralPubKey = await importX25519PublicKey(ephemeralPubRaw);

  // 3. ECDH: derive shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: ephemeralPubKey },
    recipientPrivKey,
    256,
  );

  // 4. HKDF-SHA256: same derivation as sender
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ephemeralPubRaw,
      info: new TextEncoder().encode("filenymous-v1-key-wrap"),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // 5. AES-GCM decrypt
  const aesKeyBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    wrappingKey,
    ciphertext,
  );

  return new Uint8Array(aesKeyBytes);
}
