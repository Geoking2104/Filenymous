/**
 * TypeScript types mirroring the Rust entry structs defined in the Holochain zomes.
 * Keep in sync with dnas/filenymous/zomes/integrity/*/src/lib.rs
 */

import type { ActionHash, AgentPubKey, Timestamp } from "@holochain/client";

// ── identity_integrity ───────────────────────────────────────────────────

export interface ContactClaim {
  contact_hash: string;        // SHA-256 hex of normalised email / phone
  agent: AgentPubKey;
  created_at: Timestamp;
}

// ── transfer_integrity ───────────────────────────────────────────────────

export type TransferStatus = "pending" | "downloaded" | "expired" | "revoked";

export interface TransferManifest {
  transfer_id: string;
  sender: AgentPubKey;
  recipient_contact_hash: string;
  file_name: string;
  file_size: number;
  chunk_count: number;
  /** AES-256-GCM key encrypted with recipient's X25519 pubkey (base64) */
  encrypted_key_blob: string;
  /** Unix timestamp microseconds; 0 = never */
  expiry_us: number;
  /** 0 = unlimited */
  max_downloads: number;
  status: TransferStatus;
  created_at: Timestamp;
}

export interface TransferStatusUpdate {
  transfer_id: string;
  new_status: TransferStatus;
  download_count: number;
  updated_at: Timestamp;
}

// ── storage_integrity ────────────────────────────────────────────────────

export interface FileChunk {
  transfer_id: string;
  chunk_index: number;
  total_chunks: number;
  encrypted_data: Uint8Array;
  checksum: string;            // SHA-256 hex of encrypted_data
}

export interface ChunkManifest {
  transfer_id: string;
  total_chunks: number;
  chunk_action_hashes: ActionHash[];
  file_size_bytes: number;
}

// ── Zome input types ─────────────────────────────────────────────────────

export interface CreateTransferInput {
  transfer_id: string;
  recipient_contact_hash: string;
  file_name: string;
  file_size: number;
  chunk_count: number;
  encrypted_key_blob: string;
  expiry_us: number;
  max_downloads: number;
}

export interface StoreChunkInput {
  transfer_id: string;
  chunk_index: number;
  total_chunks: number;
  encrypted_data: number[];   // Vec<u8> serialised as number array for msgpack
  checksum: string;
}

export interface FinalizeStorageInput {
  transfer_id: string;
  total_chunks: number;
  chunk_action_hashes: ActionHash[];
  file_size_bytes: number;
}

export interface GetTransferOutput {
  manifest: TransferManifest;
  action_hash: ActionHash;
}

export interface GetChunksOutput {
  chunks: Array<{ action_hash: ActionHash; chunk: FileChunk }>;
}

export interface RecordDownloadInput {
  transfer_id: string;
  download_count: number;
}
