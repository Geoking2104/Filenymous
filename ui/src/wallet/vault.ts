import type { EncryptedVaultRecord } from "./types";

const KDF_ITERATIONS = 310_000;
const DB_NAME = "filenymous-wallet";
const DB_VERSION = 1;
const STORE = "vault";
const VAULT_KEY = "primary";

function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function b64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveWrappingKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations: KDF_ITERATIONS },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSeed(
  seed: Uint8Array,
  password: string,
): Promise<EncryptedVaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWrappingKey(password, salt);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce) },
      key,
      toArrayBuffer(seed),
    ),
  );
  const now = new Date().toISOString();
  return {
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    saltB64: bytesToB64(salt),
    nonceB64: bytesToB64(nonce),
    ciphertextB64: bytesToB64(encrypted),
    createdAt: now,
    updatedAt: now,
  };
}

export async function decryptSeed(
  record: EncryptedVaultRecord,
  password: string,
): Promise<Uint8Array> {
  try {
    const salt = b64ToBytes(record.saltB64);
    const nonce = b64ToBytes(record.nonceB64);
    const ciphertext = b64ToBytes(record.ciphertextB64);
    const key = await deriveWrappingKey(password, salt);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(nonce) },
        key,
        toArrayBuffer(ciphertext),
      ),
    );
  } catch {
    throw new Error("Unable to unlock wallet");
  }
}

function openWalletDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveVault(record: EncryptedVaultRecord): Promise<void> {
  const db = await openWalletDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record, VAULT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadVault(): Promise<EncryptedVaultRecord | null> {
  const db = await openWalletDb();
  const result = await new Promise<EncryptedVaultRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(VAULT_KEY);
    req.onsuccess = () => resolve((req.result as EncryptedVaultRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function deleteVault(): Promise<void> {
  const db = await openWalletDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(VAULT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
