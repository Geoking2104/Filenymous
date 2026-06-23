import type { RoomHistorySnapshot } from "./types";

const DB_NAME = "filenymous-room-history";
const DB_VERSION = 1;
const STORE = "history";
const KEY = "primary";
const KDF_ITERATIONS = 310_000;
const B64_CHUNK_SIZE = 0x8000;

export interface EncryptedRoomHistoryRecord {
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  saltB64: string;
  nonceB64: string;
  ciphertextB64: string;
  updatedAt: string;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += B64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + B64_CHUNK_SIZE));
  }
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    toBuffer(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toBuffer(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function assertEncryptedRecord(record: EncryptedRoomHistoryRecord): void {
  if (
    record.version !== 1 ||
    record.kdf !== "PBKDF2-SHA256" ||
    record.iterations !== KDF_ITERATIONS ||
    !record.saltB64 ||
    !record.nonceB64 ||
    !record.ciphertextB64
  ) {
    throw new Error("invalid room history record");
  }
}

function assertSnapshot(value: unknown): asserts value is RoomHistorySnapshot {
  if (!value || typeof value !== "object") throw new Error("invalid room history snapshot");

  const snapshot = value as Partial<RoomHistorySnapshot>;
  if (
    !Array.isArray(snapshot.rooms) ||
    !Array.isArray(snapshot.peers) ||
    !Array.isArray(snapshot.messages) ||
    !Array.isArray(snapshot.transfers)
  ) {
    throw new Error("invalid room history snapshot");
  }
}

export async function encryptRoomHistory(
  snapshot: RoomHistorySnapshot,
  password: string,
): Promise<EncryptedRoomHistoryRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: toBuffer(nonce) }, key, toBuffer(plaintext)),
  );

  return {
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    saltB64: bytesToB64(salt),
    nonceB64: bytesToB64(nonce),
    ciphertextB64: bytesToB64(ciphertext),
    updatedAt: new Date().toISOString(),
  };
}

export async function decryptRoomHistory(
  record: EncryptedRoomHistoryRecord,
  password: string,
): Promise<RoomHistorySnapshot> {
  try {
    assertEncryptedRecord(record);
    const salt = b64ToBytes(record.saltB64);
    const nonce = b64ToBytes(record.nonceB64);
    const ciphertext = b64ToBytes(record.ciphertextB64);
    const key = await deriveKey(password, salt, record.iterations);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBuffer(nonce) },
      key,
      toBuffer(ciphertext),
    );
    const snapshot = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    assertSnapshot(snapshot);
    return snapshot;
  } catch {
    throw new Error("Unable to unlock room history");
  }
}

function openDb(): Promise<IDBDatabase> {
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

export async function saveRoomHistory(record: EncryptedRoomHistoryRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadRoomHistory(): Promise<EncryptedRoomHistoryRecord | null> {
  const db = await openDb();
  const record = await new Promise<EncryptedRoomHistoryRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as EncryptedRoomHistoryRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return record;
}

export async function clearRoomHistory(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
