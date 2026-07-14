/**
 * M3 — Persistent storage of the X25519 keypair in IndexedDB.
 *
 * The private key is stored as PKCS8 bytes in IndexedDB under the
 * "filenymous-keystore" database.  This survives page reloads and browser
 * restarts, unlike sessionStorage.
 *
 * Security note (M3 prototype):
 *   The private key is stored unprotected in IndexedDB.  A malicious
 *   extension or XSS could read it.  M4 will wrap it with a WebAuthn
 *   credential (resident key) so the private key bytes never leave the
 *   secure enclave.
 *
 * TODO (M4): replace raw PKCS8 storage with WebAuthn-wrapped key or
 * non-extractable CryptoKey stored in an IndexedDB-backed WebCrypto
 * key storage backend.
 */

import {
  generateX25519KeyPair,
  exportX25519PublicKey,
  exportX25519PrivateKey,
  importX25519PrivateKey,
  type X25519KeyPair,
} from "./ecies";
import { toArrayBuffer } from "./buffer";

const DB_NAME    = "filenymous-keystore";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const KEY_ID     = "x25519";

// ── IndexedDB helpers ────────────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbGet(db: IDBDatabase, key: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as Uint8Array | undefined);
    req.onerror   = () => reject(req.error);
  });
}

async function idbPut(db: IDBDatabase, key: string, value: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

interface StoredKeyPair {
  pair: X25519KeyPair;
  /** Raw 32-byte public key — ready to base64-encode for DHT publish */
  publicKeyBytes: Uint8Array;
}

/**
 * Load the X25519 keypair from IndexedDB, generating one if it doesn't exist.
 *
 * The public key is also returned as raw bytes so the caller can publish it
 * to the DHT without an extra export step.
 */
export async function loadOrCreateKeyPair(): Promise<StoredKeyPair> {
  const db = await openDb();

  let privKeyPkcs8 = await idbGet(db, KEY_ID + "_priv");
  let pubKeyRaw    = await idbGet(db, KEY_ID + "_pub");

  if (!privKeyPkcs8 || !pubKeyRaw) {
    // First time: generate, persist, and return
    const pair        = await generateX25519KeyPair();
    pubKeyRaw         = await exportX25519PublicKey(pair.publicKey);
    privKeyPkcs8      = await exportX25519PrivateKey(pair.privateKey);

    await idbPut(db, KEY_ID + "_pub",  pubKeyRaw);
    await idbPut(db, KEY_ID + "_priv", privKeyPkcs8);

    return { pair, publicKeyBytes: pubKeyRaw };
  }

  // Re-import from stored bytes
  const privateKey = await importX25519PrivateKey(privKeyPkcs8);
  // Public key is re-imported as non-extractable (only used for ECDH by sender)
  const publicKey  = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(pubKeyRaw),
    { name: "X25519" },
    true,
    [],
  );

  return {
    pair: { publicKey, privateKey },
    publicKeyBytes: pubKeyRaw,
  };
}

/**
 * Return only the private key (for decryption in ReceivePanel).
 * Throws if no keypair has been generated yet.
 */
export async function loadPrivateKey(): Promise<CryptoKey> {
  const db = await openDb();
  const privKeyPkcs8 = await idbGet(db, KEY_ID + "_priv");

  if (!privKeyPkcs8) {
    throw new Error(
      "No X25519 private key found. Please verify your identity first (Identity tab).",
    );
  }

  return importX25519PrivateKey(privKeyPkcs8);
}

/**
 * Return the raw 32-byte public key bytes, or null if none.
 */
export async function loadPublicKeyBytes(): Promise<Uint8Array | null> {
  const db = await openDb();
  return (await idbGet(db, KEY_ID + "_pub")) ?? null;
}

/**
 * Wipe the keypair from IndexedDB (RGPD erasure or key rotation).
 */
/**
 * Export the stored keypair as base64 strings for user-controlled backup
 * (downloaded as filenymous-keys.json). Returns null if no keypair exists.
 *
 * Security note: the backup file contains the PRIVATE key. It must stay
 * under the user's exclusive control.
 */
export async function exportKeyPairBackup(): Promise<{ publicKey: string; privateKey: string } | null> {
  const db = await openDb();
  const priv = await idbGet(db, KEY_ID + "_priv");
  const pub  = await idbGet(db, KEY_ID + "_pub");
  if (!priv || !pub) return null;
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  return { publicKey: b64(pub), privateKey: b64(priv) };
}

/**
 * Import a keypair backup (as produced by exportKeyPairBackup) and persist
 * it in IndexedDB, replacing any existing keypair. Both keys are validated
 * by importing them through WebCrypto before anything is written.
 */
export async function importKeyPairBackup(publicKeyB64: string, privateKeyB64: string): Promise<void> {
  const fromB64 = (v: string) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
  const pubRaw    = fromB64(publicKeyB64);
  const privPkcs8 = fromB64(privateKeyB64);

  if (pubRaw.length !== 32) throw new Error("Invalid X25519 public key (expected 32 raw bytes)");
  // Validate both keys — throws if malformed
  await importX25519PrivateKey(privPkcs8);
  await crypto.subtle.importKey("raw", toArrayBuffer(pubRaw), { name: "X25519" }, true, []);

  const db = await openDb();
  await idbPut(db, KEY_ID + "_pub",  pubRaw);
  await idbPut(db, KEY_ID + "_priv", privPkcs8);
}

export async function deleteKeyPair(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, "readwrite");
    const st  = tx.objectStore(STORE_NAME);
    st.delete(KEY_ID + "_pub");
    st.delete(KEY_ID + "_priv");
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}
