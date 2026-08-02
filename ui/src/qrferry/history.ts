/**
 * Optical transfer history stored in IndexedDB.
 *
 * Records each completed transfer with metadata for display in the UI.
 * Prunes entries older than 30 days automatically.
 */

const DB_NAME = "filenymous-optical-history";
const DB_VERSION = 1;
const STORE_NAME = "transfers";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface HistoryEntry {
  id?: number;
  timestamp: number;
  direction: "sent" | "received";
  filename: string;
  fileSize: number;
  profile: string;
  durationSeconds: number;
  compressed: boolean;
  success: boolean;
  errorMessage?: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("direction", "direction", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Append a transfer record. */
export async function addHistoryEntry(entry: Omit<HistoryEntry, "id">): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).add(entry);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Get all entries, newest first. */
export async function getHistoryEntries(): Promise<HistoryEntry[]> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const entries = await new Promise<HistoryEntry[]>((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as HistoryEntry[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return entries.sort((a, b) => b.timestamp - a.timestamp);
}

/** Delete a single entry by id. */
export async function deleteHistoryEntry(id: number): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Clear all history. */
export async function clearHistory(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Prune entries older than MAX_AGE_MS. */
export async function pruneOldEntries(): Promise<number> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index("timestamp");
  const cutoff = Date.now() - MAX_AGE_MS;
  const range = IDBKeyRange.upperBound(cutoff);
  let pruned = 0;

  const req = index.openCursor(range);
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      cursor.delete();
      pruned += 1;
      cursor.continue();
    }
  };

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
  return pruned;
}
