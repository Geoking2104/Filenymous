use hdi::prelude::*;

// ─── Entrées DHT ──────────────────────────────────────────────────────────────

/// Métadonnées d'un transfert Filenymous.
/// Les chunks réels sont stockés via file_storage_zome (holochain-open-dev).
/// La clé AES est wrappée par ECIES/X25519 pour les agents enregistrés,
/// ou transportée hors-bande dans le fragment # de l'URL pour les non-agents.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct ParcelManifest {
    /// EntryHash du FileMetadata dans le file_storage_zome
    pub file_hash: EntryHash,
    /// Nom original du fichier
    pub file_name: String,
    /// Taille totale en octets (avant chiffrement)
    pub file_size: u64,
    /// Nombre de chunks
    pub chunk_count: u32,
    /// Agent émetteur
    pub sender: AgentPubKey,
    /// SHA-256 hex du contact normalisé du destinataire (email / téléphone)
    pub recipient_contact_hash: String,
    /// Clé AES-256 wrappée par ECIES/X25519 (base64).
    /// Vide si le destinataire n'est pas encore enregistré sur le DHT
    /// (dans ce cas la clé est dans le fragment # de l'URL hors-bande).
    pub encrypted_key_blob: String,
    /// Timestamp d'expiration (microsecondes Unix). 0 = jamais.
    pub expiry_us: i64,
    /// Nombre maximum de téléchargements autorisés. 0 = illimité.
    pub max_downloads: u32,
    /// Timestamp de création (microsecondes)
    pub created_at: Timestamp,
}

/// Enregistre un téléchargement (event immuable sur source-chain).
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct DownloadRecord {
    /// EntryHash du ParcelManifest concerné
    pub parcel_eh: EntryHash,
    /// Agent téléchargeur (None = téléchargement anonyme via Web Bridge)
    pub downloader: Option<AgentPubKey>,
    /// Timestamp du téléchargement (microsecondes)
    pub downloaded_at: Timestamp,
}

/// Signale qu'un parcel est en attente pour un contact non-enregistré.
/// Publié sur le DHT par l'expéditeur quand le destinataire n'a pas de ContactClaim.
/// Supprimé après expiration ou révocation.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct PendingParcel {
    /// EntryHash du ParcelManifest
    pub parcel_eh: EntryHash,
    /// SHA-256 hex du contact destinataire
    pub recipient_contact_hash: String,
    /// Timestamp de création (microsecondes)
    pub created_at: Timestamp,
}

// ─── Registre des types ───────────────────────────────────────────────────────

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    ParcelManifest(ParcelManifest),
    DownloadRecord(DownloadRecord),
    PendingParcel(PendingParcel),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// Expéditeur AgentPubKey → ActionHash du ParcelManifest
    SenderToParcel,
    /// Ancre contact_hash → ActionHash du ParcelManifest (lookup destinataire)
    ContactHashToParcel,
    /// EntryHash du ParcelManifest → ActionHash du DownloadRecord
    ParcelToDownload,
    /// EntryHash du ParcelManifest → ActionHash du PendingParcel
    ParcelToPending,
    /// Ancre "revoked" → ActionHash (marqueur de révocation)
    RevokedParcels,
}

// ─── Validation ───────────────────────────────────────────────────────────────

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::StoreEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::ParcelManifest(m) => validate_parcel_manifest(&m, &action.author),
            EntryTypes::DownloadRecord(d) => validate_download_record(&d),
            EntryTypes::PendingParcel(p) => validate_pending_parcel(&p),
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_parcel_manifest(
    m: &ParcelManifest,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    if &m.sender != author {
        return Ok(ValidateCallbackResult::Invalid(
            "ParcelManifest.sender doit correspondre à l'auteur de l'action".into(),
        ));
    }
    if m.file_name.is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "file_name ne doit pas être vide".into(),
        ));
    }
    if m.chunk_count == 0 {
        return Ok(ValidateCallbackResult::Invalid(
            "chunk_count doit être au moins 1".into(),
        ));
    }
    if m.recipient_contact_hash.len() != 64
        || !m
            .recipient_contact_hash
            .chars()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Ok(ValidateCallbackResult::Invalid(
            "recipient_contact_hash doit être un SHA-256 hex de 64 caractères".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_download_record(d: &DownloadRecord) -> ExternResult<ValidateCallbackResult> {
    if d.downloaded_at == Timestamp::from_micros(0) {
        return Ok(ValidateCallbackResult::Invalid(
            "downloaded_at ne doit pas être zéro".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_pending_parcel(p: &PendingParcel) -> ExternResult<ValidateCallbackResult> {
    if p.recipient_contact_hash.len() != 64 {
        return Ok(ValidateCallbackResult::Invalid(
            "recipient_contact_hash doit être un SHA-256 hex de 64 caractères".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
