//! TEST-ONLY: unauthorized writes against parcel_integrity (see tests/sweettest).
use hdk::prelude::*;
use parcel_integrity::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct DownloadInput {
    pub parcel_eh: EntryHash,
    pub downloader: Option<AgentPubKey>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LinkDownloadInput {
    pub parcel_eh: EntryHash,
    pub target: ActionHash,
}

#[hdk_extern]
pub fn create_download_record(input: DownloadInput) -> ExternResult<ActionHash> {
    create_entry(EntryTypes::DownloadRecord(DownloadRecord {
        parcel_eh: input.parcel_eh,
        downloader: input.downloader,
        downloaded_at: sys_time()?,
    }))
}

/// Quota-exhaustion attempt: link a parcel to a record that isn't a download of it.
#[hdk_extern]
pub fn link_download(input: LinkDownloadInput) -> ExternResult<ActionHash> {
    create_link(
        input.parcel_eh,
        input.target,
        LinkTypes::ParcelToDownload,
        (),
    )
}

/// Revoke someone else's parcel.
#[hdk_extern]
pub fn mark_revoked(parcel_eh: EntryHash) -> ExternResult<ActionHash> {
    create_link(revoked_anchor()?, parcel_eh, LinkTypes::RevokedParcels, ())
}

#[hdk_extern]
pub fn delete_entry_of(ah: ActionHash) -> ExternResult<ActionHash> {
    delete_entry(ah)
}

#[hdk_extern]
pub fn delete_link_of(ah: ActionHash) -> ExternResult<ActionHash> {
    delete_link(ah, GetOptions::default())
}

#[hdk_extern]
pub fn contact_links(contact_hash: String) -> ExternResult<Vec<ActionHash>> {
    Ok(get_links(
        LinkQuery::try_new(
            contact_anchor(&contact_hash)?,
            LinkTypes::ContactHashToParcel,
        )?,
        GetStrategy::default(),
    )?
    .into_iter()
    .map(|l| l.create_link_hash)
    .collect())
}
