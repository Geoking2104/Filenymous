use hdi::prelude::*;

// ─── Entry types ──────────────────────────────────────────────────────────

/// A single encrypted chunk of a file.
/// Files are split into 256 KB chunks before encryption.
/// Each chunk is stored as an independent DHT entry.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct FileChunk {
    /// Matches TransferManifest.transfer_id
    pub transfer_id: String,
    /// Zero-based index of this chunk in the file sequence
    pub chunk_index: u32,
    /// Total number of chunks for this transfer
    pub total_chunks: u32,
    /// AES-256-GCM encrypted chunk data (raw bytes)
    pub encrypted_data: Vec<u8>,
    /// SHA-256 hex of the encrypted_data for integrity verification
    pub checksum: String,
}

/// Index entry listing all chunk hashes for a transfer.
/// Stored once by the sender after all chunks are published.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct ChunkManifest {
    pub transfer_id: String,
    pub total_chunks: u32,
    /// ActionHash of each FileChunk, ordered by chunk_index
    pub chunk_action_hashes: Vec<ActionHash>,
    /// Total file size in bytes (before encryption)
    pub file_size_bytes: u64,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    FileChunk(FileChunk),
    ChunkManifest(ChunkManifest),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// Anchor (transfer_id) → ActionHash of each FileChunk
    TransferIdToChunk,
    /// Anchor (transfer_id) → ActionHash of ChunkManifest
    TransferIdToChunkManifest,
}

// ─── Validation ───────────────────────────────────────────────────────────

pub const MAX_CHUNK_SIZE_BYTES: usize = 256 * 1024; // 256 KB

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::StoreEntry(store_entry) => match store_entry {
            OpEntry::CreateEntry { app_entry, .. } => match app_entry {
                EntryTypes::FileChunk(chunk) => validate_file_chunk(&chunk),
                EntryTypes::ChunkManifest(manifest) => validate_chunk_manifest(&manifest),
            },
            _ => Ok(ValidateCallbackResult::Valid),
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_file_chunk(chunk: &FileChunk) -> ExternResult<ValidateCallbackResult> {
    if chunk.transfer_id.is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "transfer_id must not be empty".into(),
        ));
    }
    if chunk.encrypted_data.is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "encrypted_data must not be empty".into(),
        ));
    }
    // Allow up to 2x chunk size to account for encryption overhead (nonce, tag)
    if chunk.encrypted_data.len() > MAX_CHUNK_SIZE_BYTES * 2 {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "chunk too large: {} bytes (max {})",
            chunk.encrypted_data.len(),
            MAX_CHUNK_SIZE_BYTES * 2
        )));
    }
    if chunk.checksum.len() != 64 {
        return Ok(ValidateCallbackResult::Invalid(
            "checksum must be a 64-char SHA-256 hex string".into(),
        ));
    }
    if chunk.total_chunks == 0 {
        return Ok(ValidateCallbackResult::Invalid(
            "total_chunks must be at least 1".into(),
        ));
    }
    if chunk.chunk_index >= chunk.total_chunks {
        return Ok(ValidateCallbackResult::Invalid(
            "chunk_index must be less than total_chunks".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_chunk_manifest(manifest: &ChunkManifest) -> ExternResult<ValidateCallbackResult> {
    if manifest.transfer_id.is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "transfer_id must not be empty".into(),
        ));
    }
    if manifest.total_chunks == 0 {
        return Ok(ValidateCallbackResult::Invalid(
            "total_chunks must be at least 1".into(),
        ));
    }
    if manifest.chunk_action_hashes.len() != manifest.total_chunks as usize {
        return Ok(ValidateCallbackResult::Invalid(
            "chunk_action_hashes length must equal total_chunks".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
