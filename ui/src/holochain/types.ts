/**
 * Types TypeScript alignés sur les entrées Rust v2.
 * Sources :
 *   - parcel_integrity/src/lib.rs  → ParcelManifest, DownloadRecord, PendingParcel
 *   - identity_integrity/src/lib.rs → ContactClaim, AgentX25519Key
 *   - file_storage (holochain-open-dev) → FileMetadata, FileChunk
 */

import type { ActionHash, AgentPubKey, EntryHash, Timestamp } from "@holochain/client";

// ── identity_integrity ────────────────────────────────────────────────────────

export interface ContactClaim {
  contact_hash: string;   // SHA-256 hex du contact normalisé
  agent:        AgentPubKey;
  created_at:   Timestamp;
}

export interface AgentX25519Key {
  x25519_pubkey: Uint8Array;  // 32 octets
  agent:         AgentPubKey;
  created_at:    Timestamp;
}

export interface PublishX25519KeyInput {
  x25519_pubkey_b64: string;  // base64(32 bytes)
}

// ── parcel_integrity ──────────────────────────────────────────────────────────

export interface ParcelManifest {
  file_hash:              EntryHash;
  file_name:              string;
  file_size:              number;
  chunk_count:            number;
  sender:                 AgentPubKey;
  recipient_contact_hash: string;
  /** Clé AES wrappée ECIES (base64). Vide pour livraison anonyme par lien. */
  encrypted_key_blob:     string;
  /** 0 = jamais */
  expiry_us:              number;
  /** 0 = illimité */
  max_downloads:          number;
  created_at:             Timestamp;
}

export interface ParcelOutput {
  parcel_eh:      EntryHash;
  action_hash:    ActionHash;
  manifest:       ParcelManifest;
  download_count: number;
  is_revoked:     boolean;
}

export interface CreateParcelInput {
  file_hash:              EntryHash;
  file_name:              string;
  file_size:              number;
  chunk_count:            number;
  recipient_contact_hash: string;
  encrypted_key_blob:     string;
  expiry_us:              number;
  max_downloads:          number;
}

// ── file_storage (holochain-open-dev) ────────────────────────────────────────

export interface FileMetadata {
  name:          string;
  size:          number;
  chunk_hashes:  EntryHash[];
  author:        AgentPubKey;
  created_at:    Timestamp;
}

export interface FileChunkEntry {
  content: Uint8Array;
}

export interface CreateFileInput {
  name:   string;
  /** Chunks déjà chiffrés (AES-256-GCM), encodés en tableau d'octets */
  chunks: number[][];
}

// ── Signal Holochain ──────────────────────────────────────────────────────────

export interface IncomingParcelSignal {
  type:      "IncomingParcel";
  parcel_eh: EntryHash;
  sender:    AgentPubKey;
  file_name: string;
  file_size: number;
}

export type FilenymousSignal = IncomingParcelSignal;

// ── Helpers locaux (état UI) ──────────────────────────────────────────────────

export interface LocalParcel {
  parcel_eh:  string;   // EntryHash (base64url)
  file_name:  string;
  to:         string;   // contact saisi (email/téléphone)
  size:       number;
  date:       string;   // date locale FR
  status:     "pending" | "downloaded" | "revoked" | "expired";
  downloads:  number;
  max_dl:     number;
  /** Lien de téléchargement. Contient la clé AES dans le fragment # si livraison anonyme. */
  link:       string;
  /** Mode de livraison utilisé */
  mode:       "agent" | "link";
}

// Legacy v1 wrappers kept for compatibility with old screens/scripts.
// The active v2 flow uses fileStorage.ts and delivery.ts.
export interface StoreChunkInput {
  transfer_id: string;
  chunk_index: number;
  total_chunks: number;
  bytes: number[];
  checksum: string;
}

export interface FinalizeStorageInput {
  transfer_id: string;
  file_name: string;
  file_size: number;
  mime_type?: string;
}

export interface ChunkManifest {
  transfer_id: string;
  file_name: string;
  file_size: number;
  total_chunks: number;
  chunk_hashes: ActionHash[];
}

export interface GetChunksOutput {
  manifest: ChunkManifest | null;
  chunks: number[][];
}

export interface CreateTransferInput {
  transfer_id: string;
  recipient_contact_hash: string;
  file_name: string;
  file_size: number;
  expires_at?: Timestamp;
  max_downloads?: number;
}

export interface GetTransferOutput {
  action_hash: ActionHash;
  transfer_id: string;
  sender: AgentPubKey;
  recipient_contact_hash: string;
  file_name: string;
  file_size: number;
  created_at: Timestamp;
  status: "pending" | "downloaded" | "revoked" | "expired";
  downloads: number;
}

export interface RecordDownloadInput {
  transfer_id: string;
}
