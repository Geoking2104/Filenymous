use hdk::prelude::*;
use transfer_integrity::*;

// ─── Input / Output structs ───────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateTransferInput {
    pub transfer_id: String,
    pub recipient_contact_hash: String,
    pub file_name: String,
    pub file_size: u64,
    pub chunk_count: u32,
    /// AES key encrypted for the recipient (ECIES / X25519). Base64.
    pub encrypted_key_blob: String,
    /// Unix timestamp in microseconds; 0 = no expiry
    pub expiry_us: i64,
    /// 0 = unlimited
    pub max_downloads: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordTransferDownloadInput {
    pub transfer_id: String,
    /// New total download count (caller increments on their side)
    pub download_count: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GetTransferOutput {
    pub manifest: TransferManifest,
    pub action_hash: ActionHash,
}

// ─── Exported functions ───────────────────────────────────────────────────

/// Create a new TransferManifest entry and publish it on the DHT.
#[hdk_extern]
pub fn create_transfer(input: CreateTransferInput) -> ExternResult<ActionHash> {
    let sender = agent_info()?.agent_latest_pubkey;
    let manifest = TransferManifest {
        transfer_id: input.transfer_id.clone(),
        sender: sender.clone(),
        recipient_contact_hash: input.recipient_contact_hash.clone(),
        file_name: input.file_name,
        file_size: input.file_size,
        chunk_count: input.chunk_count,
        encrypted_key_blob: input.encrypted_key_blob,
        expiry_us: input.expiry_us,
        max_downloads: input.max_downloads,
        status: TransferStatus::Pending,
        created_at: sys_time()?,
    };

    let action_hash = create_entry(EntryTypes::TransferManifest(manifest))?;

    // Anchor: transfer_id → manifest (for recipient resolution)
    let anchor = transfer_anchor(&input.transfer_id)?;
    create_link(
        anchor,
        action_hash.clone(),
        LinkTypes::TransferIdToManifest,
        (),
    )?;

    // Sender index: find all outgoing transfers
    create_link(
        sender,
        action_hash.clone(),
        LinkTypes::SenderToTransfer,
        (),
    )?;

    // Recipient index: find incoming transfers by contact hash
    let recipient_anchor = recipient_contact_anchor(&input.recipient_contact_hash)?;
    create_link(
        recipient_anchor,
        action_hash.clone(),
        LinkTypes::RecipientContactToTransfer,
        (),
    )?;

    Ok(action_hash)
}

/// Retrieve a TransferManifest by transfer_id.
#[hdk_extern]
pub fn get_transfer(transfer_id: String) -> ExternResult<Option<GetTransferOutput>> {
    let anchor = transfer_anchor(&transfer_id)?;
    let links = get_links(
        GetLinksInputBuilder::try_new(anchor, LinkTypes::TransferIdToManifest)?.build(),
    )?;

    let latest = links.into_iter().max_by_key(|l| l.timestamp);
    match latest {
        None => Ok(None),
        Some(link) => {
            let action_hash = ActionHash::try_from(link.target)
                .map_err(|_| wasm_error!(WasmErrorInner::Guest("Invalid link target".into())))?;
            let record = get(action_hash.clone(), GetOptions::default())?;
            match record {
                None => Ok(None),
                Some(record) => {
                    let manifest: TransferManifest = record
                        .entry()
                        .to_app_option()
                        .map_err(|e| {
                            wasm_error!(WasmErrorInner::Guest(format!("Deserialize error: {e}")))
                        })?
                        .ok_or_else(|| {
                            wasm_error!(WasmErrorInner::Guest("Empty entry".into()))
                        })?;
                    Ok(Some(GetTransferOutput { manifest, action_hash }))
                }
            }
        }
    }
}

/// Return all transfers sent by the calling agent.
#[hdk_extern]
pub fn get_my_sent_transfers(_: ()) -> ExternResult<Vec<GetTransferOutput>> {
    let agent = agent_info()?.agent_latest_pubkey;
    let links = get_links(
        GetLinksInputBuilder::try_new(agent, LinkTypes::SenderToTransfer)?.build(),
    )?;
    collect_manifests(links)
}

/// Return all incoming transfers for a given contact hash.
/// Intended to be called by the recipient after resolving their own contact.
#[hdk_extern]
pub fn get_transfers_for_contact(contact_hash: String) -> ExternResult<Vec<GetTransferOutput>> {
    let anchor = recipient_contact_anchor(&contact_hash)?;
    let links = get_links(
        GetLinksInputBuilder::try_new(anchor, LinkTypes::RecipientContactToTransfer)?.build(),
    )?;
    collect_manifests(links)
}

/// Record a download event (status update) on the DHT.
/// Called by the recipient after successfully downloading the file.
#[hdk_extern]
pub fn record_download(input: RecordTransferDownloadInput) -> ExternResult<ActionHash> {
    publish_status_update(
        &input.transfer_id,
        TransferStatus::Downloaded,
        input.download_count,
    )
}

/// Mark a transfer as Revoked. Only the sender should call this.
#[hdk_extern]
pub fn revoke_transfer(transfer_id: String) -> ExternResult<ActionHash> {
    publish_status_update(&transfer_id, TransferStatus::Revoked, 0)
}

/// Mark a transfer as Expired (called automatically by the client on expiry).
#[hdk_extern]
pub fn expire_transfer(transfer_id: String) -> ExternResult<ActionHash> {
    publish_status_update(&transfer_id, TransferStatus::Expired, 0)
}

// ─── Internal helpers ─────────────────────────────────────────────────────

fn transfer_anchor(transfer_id: &str) -> ExternResult<AnyLinkableHash> {
    let path = Path::from(format!("transfers.{transfer_id}"));
    Ok(path.path_entry_hash()?.into())
}

fn recipient_contact_anchor(contact_hash: &str) -> ExternResult<AnyLinkableHash> {
    let path = Path::from(format!("recipients.{contact_hash}"));
    Ok(path.path_entry_hash()?.into())
}

fn publish_status_update(
    transfer_id: &str,
    status: TransferStatus,
    download_count: u32,
) -> ExternResult<ActionHash> {
    let update = TransferStatusUpdate {
        transfer_id: transfer_id.to_string(),
        new_status: status,
        download_count,
        updated_at: sys_time()?,
    };
    create_entry(EntryTypes::TransferStatusUpdate(update))
}

fn collect_manifests(links: Vec<Link>) -> ExternResult<Vec<GetTransferOutput>> {
    let mut results = Vec::new();
    for link in links {
        let action_hash = ActionHash::try_from(link.target)
            .map_err(|_| wasm_error!(WasmErrorInner::Guest("Invalid link target".into())))?;
        if let Some(record) = get(action_hash.clone(), GetOptions::default())? {
            if let Ok(Some(manifest)) = record.entry().to_app_option::<TransferManifest>() {
                results.push(GetTransferOutput { manifest, action_hash });
            }
        }
    }
    Ok(results)
}
