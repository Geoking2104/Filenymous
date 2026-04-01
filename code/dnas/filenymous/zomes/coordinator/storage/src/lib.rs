use hdk::prelude::*;
use storage_integrity::*;

// ─── Input structs ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct StoreChunkInput {
    pub transfer_id: String,
    pub chunk_index: u32,
    pub total_chunks: u32,
    /// Raw AES-256-GCM encrypted bytes (nonce prepended: 12 bytes || ciphertext || 16-byte tag)
    pub encrypted_data: Vec<u8>,
    /// SHA-256 hex of encrypted_data
    pub checksum: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct FinalizeStorageInput {
    pub transfer_id: String,
    pub total_chunks: u32,
    pub chunk_action_hashes: Vec<ActionHash>,
    pub file_size_bytes: u64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GetChunksOutput {
    pub chunks: Vec<ChunkWithHash>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ChunkWithHash {
    pub action_hash: ActionHash,
    pub chunk: FileChunk,
}

// ─── Exported functions ───────────────────────────────────────────────────

/// Store a single encrypted file chunk on the DHT.
/// Called once per chunk during upload. Returns the chunk's ActionHash.
#[hdk_extern]
pub fn store_chunk(input: StoreChunkInput) -> ExternResult<ActionHash> {
    let chunk = FileChunk {
        transfer_id: input.transfer_id.clone(),
        chunk_index: input.chunk_index,
        total_chunks: input.total_chunks,
        encrypted_data: input.encrypted_data,
        checksum: input.checksum,
    };

    let action_hash = create_entry(EntryTypes::FileChunk(chunk))?;

    // Index link so any agent can find chunks by transfer_id
    let anchor = transfer_chunks_anchor(&input.transfer_id)?;
    create_link(
        anchor,
        action_hash.clone(),
        LinkTypes::TransferIdToChunk,
        // Tag = chunk_index as little-endian u32 (for ordering)
        LinkTag::new(input.chunk_index.to_le_bytes().to_vec()),
    )?;

    Ok(action_hash)
}

/// After all chunks are stored, publish a ChunkManifest that indexes them.
/// The sender calls this once, providing ordered ActionHashes.
#[hdk_extern]
pub fn finalize_storage(input: FinalizeStorageInput) -> ExternResult<ActionHash> {
    let manifest = ChunkManifest {
        transfer_id: input.transfer_id.clone(),
        total_chunks: input.total_chunks,
        chunk_action_hashes: input.chunk_action_hashes,
        file_size_bytes: input.file_size_bytes,
    };

    let action_hash = create_entry(EntryTypes::ChunkManifest(manifest))?;

    let anchor = transfer_manifest_anchor(&input.transfer_id)?;
    create_link(
        anchor,
        action_hash.clone(),
        LinkTypes::TransferIdToChunkManifest,
        (),
    )?;

    Ok(action_hash)
}

/// Retrieve the ChunkManifest for a transfer (if available).
#[hdk_extern]
pub fn get_chunk_manifest(transfer_id: String) -> ExternResult<Option<ChunkManifest>> {
    let anchor = transfer_manifest_anchor(&transfer_id)?;
    let links = get_links(
        GetLinksInputBuilder::try_new(anchor, LinkTypes::TransferIdToChunkManifest)?.build(),
    )?;

    let latest = links.into_iter().max_by_key(|l| l.timestamp);
    match latest {
        None => Ok(None),
        Some(link) => {
            let action_hash = ActionHash::try_from(link.target)
                .map_err(|_| wasm_error!(WasmErrorInner::Guest("Invalid link target".into())))?;
            let record = get(action_hash, GetOptions::default())?;
            match record {
                None => Ok(None),
                Some(r) => Ok(r.entry().to_app_option().ok().flatten()),
            }
        }
    }
}

/// Retrieve all chunks for a transfer, ordered by chunk_index.
/// Returns them sorted so the caller can reassemble the file.
#[hdk_extern]
pub fn get_chunks(transfer_id: String) -> ExternResult<GetChunksOutput> {
    let anchor = transfer_chunks_anchor(&transfer_id)?;
    let mut links = get_links(
        GetLinksInputBuilder::try_new(anchor, LinkTypes::TransferIdToChunk)?.build(),
    )?;

    // Sort links by chunk_index embedded in the tag
    links.sort_by_key(|l| {
        let tag = l.tag.as_ref();
        if tag.len() >= 4 {
            u32::from_le_bytes([tag[0], tag[1], tag[2], tag[3]])
        } else {
            u32::MAX
        }
    });

    let mut chunks = Vec::new();
    for link in links {
        let action_hash = ActionHash::try_from(link.target)
            .map_err(|_| wasm_error!(WasmErrorInner::Guest("Invalid link target".into())))?;
        if let Some(record) = get(action_hash.clone(), GetOptions::default())? {
            if let Ok(Some(chunk)) = record.entry().to_app_option::<FileChunk>() {
                chunks.push(ChunkWithHash { action_hash, chunk });
            }
        }
    }

    Ok(GetChunksOutput { chunks })
}

/// Delete all chunks for a transfer (called on expiry or revocation).
/// Returns the list of deleted ActionHashes.
#[hdk_extern]
pub fn delete_chunks(transfer_id: String) -> ExternResult<Vec<ActionHash>> {
    let anchor = transfer_chunks_anchor(&transfer_id)?;
    let links = get_links(
        GetLinksInputBuilder::try_new(anchor.clone(), LinkTypes::TransferIdToChunk)?.build(),
    )?;

    let mut deleted = Vec::new();
    for link in links {
        let action_hash = ActionHash::try_from(link.target)
            .map_err(|_| wasm_error!(WasmErrorInner::Guest("Invalid link target".into())))?;
        delete_entry(action_hash.clone())?;
        delete_link(link.create_link_hash)?;
        deleted.push(action_hash);
    }

    // Also delete the ChunkManifest if present
    let manifest_anchor = transfer_manifest_anchor(&transfer_id)?;
    let manifest_links = get_links(
        GetLinksInputBuilder::try_new(manifest_anchor, LinkTypes::TransferIdToChunkManifest)?.build(),
    )?;
    for link in manifest_links {
        let action_hash = ActionHash::try_from(link.target)
            .map_err(|_| wasm_error!(WasmErrorInner::Guest("Invalid link target".into())))?;
        delete_entry(action_hash.clone())?;
        delete_link(link.create_link_hash)?;
        deleted.push(action_hash);
    }

    Ok(deleted)
}

// ─── Internal helpers ─────────────────────────────────────────────────────

fn transfer_chunks_anchor(transfer_id: &str) -> ExternResult<AnyLinkableHash> {
    let path = Path::from(format!("chunks.{transfer_id}"));
    path.ensure()?;
    Ok(path.path_entry_hash()?.into())
}

fn transfer_manifest_anchor(transfer_id: &str) -> ExternResult<AnyLinkableHash> {
    let path = Path::from(format!("chunk_manifests.{transfer_id}"));
    path.ensure()?;
    Ok(path.path_entry_hash()?.into())
}
