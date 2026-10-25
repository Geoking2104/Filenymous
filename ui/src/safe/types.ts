import type { VectorClock } from "./clock";

export type Category = "login" | "note" | "api_key" | "file";
export type Role = "reader" | "editor" | "admin";
export const CATEGORIES: Category[] = ["login", "note", "api_key", "file"];
export const ROLES: Role[] = ["reader", "editor", "admin"];

export interface FileMeta {
  name: string;
  size: number;
  type: string;
  chunks: number;
  /** Hex SHA-256 Merkle root over the encrypted chunks stored in this vault. */
  root: string;
}

/** Owner side: who this item was shared with (enforced by the recipient's client). */
export interface ShareGrant {
  peerId: string;
  role: Role;
  expiresAt?: number;
  at: number;
}

/** Recipient side: where a shared item came from and with which rights. */
export interface Received {
  from: string;
  role: Role;
  expiresAt?: number;
  at: number;
}

/** Decrypted item (lives only in the vault worker's RAM, and on screen while open). */
export interface ItemData {
  category: Category;
  title: string;
  tags: string[];
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  apiKey?: string;
  service?: string;
  file?: FileMeta;
  clock: VectorClock;
  grants?: ShareGrant[];
  received?: Received;
}

/** Editable fields (what a share/update carries). */
export type ItemFields = Omit<ItemData, "clock" | "grants" | "received" | "file">;

export interface ItemSummary {
  id: string;
  category: Category;
  title: string;
  tags: string[];
  subtitle: string;
  url?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  hasConflict: boolean;
  conflicts: number;
  received?: Received;
  grants: number;
  file?: FileMeta;
  hasSecret: boolean;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  passkey: { credId: string; salt: string } | null;
  handle?: string;
  card?: string;
  needsNewPassword?: boolean;
  settings: VaultSettings;
}

export interface VaultSettings {
  autoLockMin: number;
  semantic: boolean;
  /** When an encrypted backup file was last exported (ms epoch). */
  lastBackupAt?: number;
}

export const DEFAULT_SETTINGS: VaultSettings = { autoLockMin: 5, semantic: false };

export interface Peer {
  peerId: string; // handle
  alias: string;
  card: string;
  trust: number;
  lastSeen: number;
}

export interface VersionInfo {
  version: number;
  at: number;
  current: boolean;
}

export interface ConflictInfo {
  conflictId: string;
  author: string;
  authorAlias?: string;
  at: number;
  data: ItemData;
}

export interface SecurityReport {
  total: number;
  logins: number;
  weak: { id: string; title: string; bits: number }[];
  reused: { ids: string[]; titles: string[] }[];
  old: { id: string; title: string; days: number }[];
}

/** A signed, encrypted share packet ready for transport (WebRTC now; an encrypted mailbox later). */
export interface Envelope {
  /** Signed JSON header (string), see share.ts. */
  h: string;
  /** Ed25519 signature over `h` (b64u). */
  sig: string;
  /** Encrypted chunks (only for file items in a first share). */
  chunks: Uint8Array[];
}

export interface Outgoing {
  peerId: string;
  alias: string;
  inbox: string;
  envelope: Envelope;
}

export type ReceiveResult =
  | { status: "new" | "updated" | "stale" | "conflict"; id: string; from: string; alias?: string; title: string }
  | { status: "pending"; pendingId: string; from: string; title: string; card: string }
  | { status: "rejected"; reason: string; from?: string };
