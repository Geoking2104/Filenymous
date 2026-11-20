/**
 * Local messenger storage (IndexedDB "fny-profile"): the device identity
 * (sealed), the profile (name, photo, privacy switches) and the friend list.
 * Nothing here is ever sent anywhere in M1; later phases sync through the
 * encrypted relay mailbox.
 */
import { emitMessengerChanged } from "./link";

const DB = "fny-profile";
const VERSION = 1;

export interface Profile {
  displayName: string;
  avatar?: Blob;
  /** "Visible par mes amis" (presence, M3). */
  discoverable: boolean;
  /** "Montrer mon statut hors ligne" (M3). */
  shareOfflineStatus: boolean;
  hideLastSeen: boolean;
  hideReadReceipts: boolean;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_PRIVACY = { discoverable: false, shareOfflineStatus: false, hideLastSeen: false, hideReadReceipts: false } as const;

/**
 * friend    — mutual friend (both sides accepted)
 * incoming  — someone invited me; waiting for my answer
 * reply     — someone accepted my invite; waiting for my confirmation
 * outgoing  — request I prepared (e.g. imported vault contact), not answered yet
 */
export type FriendStatus = "friend" | "incoming" | "reply" | "outgoing";

export interface Friend {
  /** Messenger handle, or "safe:<vault handle>" for an outgoing request to a vault contact. */
  id: string;
  status: FriendStatus;
  name: string;
  handle?: string;
  card?: string;
  source: "link" | "safe";
  createdAt: number;
  /** The other person's vault card (sent with their invite, or the vault contact I invited). */
  ref?: string;
  /** Request id of an outgoing request / echoed by a reply. */
  rid?: string;
  /** Signed invite hash I received (incoming / reply), kept to re-verify. */
  invite?: string;
  /** Outgoing request to a vault contact: my own vault card, sent along so they recognise me. */
  myRef?: string;
  /** My reply link once I accepted, to send again if needed. */
  replyLink?: string;
}

export interface StoredIdentity {
  key: CryptoKey;
  iv: Uint8Array;
  ct: Uint8Array;
  handle: string;
  card: string;
}

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((ok, ko) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("friends")) db.createObjectStore("friends", { keyPath: "id" });
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => {
        r.result.close();
        dbp = null;
      };
      ok(r.result);
    };
    r.onerror = () => {
      dbp = null;
      ko(r.error ?? new Error("idb-open"));
    };
  });
  return dbp;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, ko) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error ?? new Error("idb"));
  });
}

async function tx<T>(store: "kv" | "friends", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  const t = db.transaction(store, mode);
  const done = new Promise<void>((ok, ko) => {
    t.oncomplete = () => ok();
    t.onerror = () => ko(t.error ?? new Error("idb-tx"));
    t.onabort = () => ko(t.error ?? new Error("idb-abort"));
  });
  const out = req(fn(t.objectStore(store)));
  await done;
  return out;
}

export async function getIdentity(): Promise<StoredIdentity | undefined> {
  return tx("kv", "readonly", (s) => s.get("identity") as IDBRequest<StoredIdentity | undefined>);
}

export async function putIdentity(v: StoredIdentity): Promise<void> {
  await tx("kv", "readwrite", (s) => s.put(v, "identity"));
}

export async function getProfile(): Promise<Profile | undefined> {
  return tx("kv", "readonly", (s) => s.get("profile") as IDBRequest<Profile | undefined>);
}

export async function putProfile(p: Profile): Promise<void> {
  await tx("kv", "readwrite", (s) => s.put(p, "profile"));
  emitMessengerChanged();
}

export async function listFriends(): Promise<Friend[]> {
  const all = await tx("friends", "readonly", (s) => s.getAll() as IDBRequest<Friend[]>);
  return all.sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
}

export async function getFriend(id: string): Promise<Friend | undefined> {
  return tx("friends", "readonly", (s) => s.get(id) as IDBRequest<Friend | undefined>);
}

export async function putFriend(f: Friend): Promise<void> {
  await tx("friends", "readwrite", (s) => s.put(f));
  emitMessengerChanged();
}

export async function deleteFriend(id: string): Promise<void> {
  await tx("friends", "readwrite", (s) => s.delete(id));
  emitMessengerChanged();
}

/** Number of invitations waiting for my answer (badge on the 💬 button). */
export async function pendingCount(): Promise<number> {
  // Don't create the database just to count: most visitors never open the messenger.
  if (typeof indexedDB.databases === "function") {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === DB)) return 0;
  }
  const all = await tx("friends", "readonly", (s) => s.getAll() as IDBRequest<Friend[]>);
  return all.filter((f) => f.status === "incoming" || f.status === "reply").length;
}

/** "Supprimer mon profil": wipes identity, profile and friends on this device. */
export async function wipeAll(): Promise<void> {
  await tx("kv", "readwrite", (s) => s.clear());
  await tx("friends", "readwrite", (s) => s.clear());
  emitMessengerChanged();
}
