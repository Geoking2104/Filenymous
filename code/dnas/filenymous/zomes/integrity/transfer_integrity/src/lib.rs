use hdi::prelude::*;

// ─── Entry types ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Pending,
    Downloaded,
    Expired,
    Revoked,
}

/// Core metadata for a file transfer.
/// The actual file content is stored separately in storage_zome.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct TransferManifest {
    /// Unique identifier for this transfer (UUID v4)
    pub transfer_id: String,
    /// Agent who initiated the transfer
    pub sender: AgentPubKey,
    /// SHA-256 hash of the recipient's contact (email / phone)
    pub recipient_contact_hash: String,
    /// Original file name (metadata only, displayed to recipient)
    pub file_name: String,
    /// File size in bytes
    pub file_size: u64,
    /// Total number of encrypted chunks
    pub chunk_count: u32,
    /// AES-256-GCM key encrypted with the recipient's X25519 public key
    /// (ECIES / HKDF-SHA256 scheme). Base64-encoded.
    pub encrypted_key_blob: String,
    /// Expiry as Unix timestamp in microseconds (0 = never)
    pub expiry_us: i64,
    /// Maximum number of downloads allowed (0 = unlimited)
    pub max_downloads: u32,
    /// Current status of the transfer
    pub status: TransferStatus,
    /// Creation timestamp (microseconds)
    pub created_at: Timestamp,
}

/// Records a status change or download event for a transfer.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct TransferStatusUpdate {
    pub transfer_id: String,
    pub new_status: TransferStatus,
    pub download_count: u32,
    pub updated_at: Timestamp,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    TransferManifest(TransferManifest),
    TransferStatusUpdate(TransferStatusUpdate),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// Anchor (transfer_id string hash) → ActionHash of TransferManifest
    TransferIdToManifest,
    /// Sender AgentPubKey → ActionHash of TransferManifest
    SenderToTransfer,
    /// Recipient contact hash → ActionHash of TransferManifest
    RecipientContactToTransfer,
    /// TransferManifest ActionHash → ActionHash of latest TransferStatusUpdate
    ManifestToStatusUpdate,
}

// ─── Validation ───────────────────────────────────────────────────────────

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::StoreEntry(store_entry) => match store_entry {
            OpEntry::CreateEntry { app_entry, action } => match app_entry {
                EntryTypes::TransferManifest(manifest) => {
                    validate_transfer_manifest(&manifest, &action.author)
                }
                EntryTypes::TransferStatusUpdate(update) => {
                    validate_status_update(&update)
                }
            },
            _ => Ok(ValidateCallbackResult::Valid),
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_transfer_manifest(
    manifest: &TransferManifest,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    if manifest.transfer_id.is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "transfer_id must not be empty".into(),
        ));
    }
    if &manifest.sender != author {
        return Ok(ValidateCallbackResult::Invalid(
            "TransferManifest.sender must equal the action author".into(),
        ));
    }
    if manifest.recipient_contact_hash.len() != 64 {
        return Ok(ValidateCallbackResult::Invalid(
            "recipient_contact_hash must be a 64-char SHA-256 hex string".into(),
        ));
    }
    if manifest.file_name.is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "file_name must not be empty".into(),
        ));
    }
    if manifest.chunk_count == 0 {
        return Ok(ValidateCallbackResult::Invalid(
            "chunk_count must be at least 1".into(),
        ));
    }
    if manifest.encrypted_key_blob.is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "encrypted_key_blob must not be empty".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_status_update(
    update: &TransferStatusUpdate,
) -> ExternResult<ValidateCallbackResult> {
    if update.transfer_id.is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "transfer_id must not be empty".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
