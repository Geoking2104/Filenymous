/**
 * Tiny promise wrapper over IndexedDB for the Document tab (no dependency).
 * One database, two object stores: "sessions" (small records) and "blobs"
 * (image bytes kept apart from the HTML).
 */
export type StoreName = "sessions" | "blobs";

const DB_NAME = "fny-document";
const DB_VERSION = 1;
const STORES: StoreName[] = ["sessions", "blobs"];

let dbPromise: Promise<IDBDatabase> | null = null;

export function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => {
      const db = r.result;
      // Another tab upgrading the schema: let it, reopen lazily next time.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      res(db);
    };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("idb-blocked"));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/** Runs `fn` in one transaction and resolves once it is committed (so quota errors surface here). */
async function tx<T>(stores: StoreName[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await open();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onabort = () => rej(t.error ?? new Error("idb-abort"));
    t.onerror = () => rej(t.error ?? new Error("idb-error"));
  });
  let out: T;
  try {
    out = await fn(t);
  } catch (e) {
    try {
      t.abort();
    } catch {
      /* already finished */
    }
    await done.catch(() => undefined);
    throw e;
  }
  await done;
  return out;
}

export function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return tx([store], "readonly", (t) => req(t.objectStore(store).get(key)) as Promise<T | undefined>);
}

export function idbKeys(store: StoreName): Promise<string[]> {
  return tx([store], "readonly", async (t) => (await req(t.objectStore(store).getAllKeys())).map(String));
}

/** Puts and deletes across stores atomically. */
export function idbWrite(ops: { store: StoreName; key: string; value?: unknown; del?: boolean }[]): Promise<void> {
  const stores = Array.from(new Set(ops.map((o) => o.store)));
  if (!stores.length) return Promise.resolve();
  return tx(stores, "readwrite", (t) => {
    for (const o of ops) {
      const s = t.objectStore(o.store);
      if (o.del) s.delete(o.key);
      else s.put(o.value, o.key);
    }
  });
}

export function idbClear(store: StoreName): Promise<void> {
  return tx([store], "readwrite", (t) => {
    t.objectStore(store).clear();
  });
}

/** For tests: forget the cached connection (after deleting the database). */
export function resetIdbForTests(): void {
  dbPromise?.then((d) => d.close()).catch(() => undefined);
  dbPromise = null;
}

export function isQuotaError(e: unknown): boolean {
  const err = e as { name?: string; code?: number; message?: string } | null;
  if (!err) return false;
  return err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED" || err.code === 22 || err.code === 1014 || /quota/i.test(err.message ?? "");
}
