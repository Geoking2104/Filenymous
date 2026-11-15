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

// Authorization rules (all ops, so the author's inline validation and the DHT
// authorities both enforce them):
//  * parcel entries are immutable: no updates; deletes only by the original
//    author; links deleted only by their author;
//  * a DownloadRecord names its author as downloader;
//  * links must be created by the agent who owns what they assert:
//    sender → own parcel, contact anchor → own parcel, parcel → own download
//    record / own pending entry for that parcel, "revoked" → only the sender's
//    parcel (otherwise anyone could revoke or exhaust anyone's transfer).
#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::StoreEntry(OpEntry::CreateEntry { app_entry, action })
        | FlatOp::StoreRecord(OpRecord::CreateEntry { app_entry, action }) => {
            validate_entry(&app_entry, &action.author, action.timestamp)
        }
        FlatOp::StoreEntry(OpEntry::UpdateEntry { .. })
        | FlatOp::StoreRecord(OpRecord::UpdateEntry { .. })
        | FlatOp::RegisterUpdate(OpUpdate::Entry { .. }) => {
            invalid("parcel entries are immutable (no updates)")
        }
        FlatOp::StoreRecord(OpRecord::DeleteEntry {
            original_action_hash,
            action,
            ..
        }) => same_author(&original_action_hash, &action.author),
        FlatOp::RegisterDelete(OpDelete { action }) => {
            same_author(&action.deletes_address, &action.author)
        }
        FlatOp::RegisterCreateLink {
            link_type,
            base_address,
            target_address,
            action,
            ..
        }
        | FlatOp::StoreRecord(OpRecord::CreateLink {
            link_type,
            base_address,
            target_address,
            action,
            ..
        }) => validate_create_link(link_type, &base_address, &target_address, &action.author),
        FlatOp::RegisterDeleteLink {
            original_action,
            action,
            ..
        } => Ok(author_rule(&original_action.author, &action.author)),
        FlatOp::StoreRecord(OpRecord::DeleteLink {
            original_action_hash,
            action,
            ..
        }) => {
            let original = must_get_action(original_action_hash)?;
            Ok(author_rule(original.action().author(), &action.author))
        }
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_entry(
    entry: &EntryTypes,
    author: &AgentPubKey,
    ts: Timestamp,
) -> ExternResult<ValidateCallbackResult> {
    match entry {
        EntryTypes::ParcelManifest(m) => validate_parcel_manifest(m, author, ts),
        EntryTypes::DownloadRecord(d) => validate_download_record(d, author),
        EntryTypes::PendingParcel(p) => validate_pending_parcel(p),
    }
}

fn invalid(msg: &str) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(msg.into()))
}

/// Pure rule (unit-tested): `who` may delete what `owner` created.
pub fn author_rule(owner: &AgentPubKey, who: &AgentPubKey) -> ValidateCallbackResult {
    if owner == who {
        ValidateCallbackResult::Valid
    } else {
        ValidateCallbackResult::Invalid("seul l'auteur d'origine peut supprimer".into())
    }
}

fn same_author(
    original: &ActionHash,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    let original = must_get_action(original.clone())?;
    Ok(author_rule(original.action().author(), author))
}

/// Same anchors as the coordinator (`contact_path`, `revoked_path`).
pub fn contact_anchor(contact_hash: &str) -> ExternResult<AnyLinkableHash> {
    Ok(Path::from(format!("parcels.contact.{contact_hash}"))
        .path_entry_hash()?
        .into())
}

pub fn revoked_anchor() -> ExternResult<AnyLinkableHash> {
    Ok(Path::from("parcels.revoked").path_entry_hash()?.into())
}

/// Link target as a record created by the link author.
fn own_record<T>(target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<Option<T>>
where
    T: TryFrom<SerializedBytes, Error = SerializedBytesError>,
{
    let Some(ah) = target.clone().into_action_hash() else {
        return Ok(None);
    };
    let record = must_get_valid_record(ah)?;
    if record.action().author() != author {
        return Ok(None);
    }
    Ok(record.entry().to_app_option::<T>().ok().flatten())
}

fn validate_create_link(
    link_type: LinkTypes,
    base: &AnyLinkableHash,
    target: &AnyLinkableHash,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    match link_type {
        LinkTypes::SenderToParcel => {
            if base.clone().into_agent_pub_key().as_ref() != Some(author) {
                return invalid("SenderToParcel doit partir de la clé de l'auteur");
            }
            if own_record::<ParcelManifest>(target, author)?.is_none() {
                return invalid("SenderToParcel doit viser un ParcelManifest de l'auteur");
            }
        }
        LinkTypes::ContactHashToParcel => {
            let Some(m) = own_record::<ParcelManifest>(target, author)? else {
                return invalid("ContactHashToParcel doit viser un ParcelManifest de l'auteur");
            };
            if &contact_anchor(&m.recipient_contact_hash)? != base {
                return invalid("ContactHashToParcel : ancre de contact incorrecte");
            }
        }
        LinkTypes::ParcelToDownload => {
            let Some(d) = own_record::<DownloadRecord>(target, author)? else {
                return invalid("ParcelToDownload doit viser un DownloadRecord de l'auteur");
            };
            if base.clone().into_entry_hash().as_ref() != Some(&d.parcel_eh) {
                return invalid("ParcelToDownload : le parcel ne correspond pas");
            }
        }
        LinkTypes::ParcelToPending => {
            let Some(p) = own_record::<PendingParcel>(target, author)? else {
                return invalid("ParcelToPending doit viser un PendingParcel de l'auteur");
            };
            if base.clone().into_entry_hash().as_ref() != Some(&p.parcel_eh) {
                return invalid("ParcelToPending : le parcel ne correspond pas");
            }
        }
        LinkTypes::RevokedParcels => {
            if base != &revoked_anchor()? {
                return invalid("RevokedParcels : ancre incorrecte");
            }
            let Some(eh) = target.clone().into_entry_hash() else {
                return invalid("RevokedParcels doit viser l'EntryHash d'un parcel");
            };
            let manifest = ParcelManifest::try_from(must_get_entry(eh)?.content)
                .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e:?}"))))
                .ok();
            match manifest {
                Some(m) if &m.sender == author => {}
                _ => return invalid("seul l'expéditeur peut révoquer ce parcel"),
            }
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_parcel_manifest(
    m: &ParcelManifest,
    author: &AgentPubKey,
    action_ts: Timestamp,
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
    if m.expiry_us < 0 {
        return Ok(ValidateCallbackResult::Invalid(
            "expiry_us ne doit pas être négatif".into(),
        ));
    }
    // Règle : l'expiration doit être dans le futur au moment de la création.
    if m.expiry_us > 0 && m.expiry_us <= action_ts.as_micros() {
        return Ok(ValidateCallbackResult::Invalid(
            "La date d'expiration doit être supérieure à la date de création.".into(),
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

fn validate_download_record(
    d: &DownloadRecord,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    // Le téléchargeur est toujours l'auteur : personne ne peut enregistrer un
    // téléchargement au nom d'un autre (ni anonymement, ce qui permettrait
    // d'épuiser le quota max_downloads d'un parcel).
    if d.downloader.as_ref() != Some(author) {
        return Ok(ValidateCallbackResult::Invalid(
            "DownloadRecord.downloader doit être l'auteur de l'action".into(),
        ));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(b: u8) -> AgentPubKey {
        AgentPubKey::from_raw_32(vec![b; 32])
    }

    fn record(downloader: Option<AgentPubKey>) -> DownloadRecord {
        DownloadRecord {
            parcel_eh: EntryHash::from_raw_32(vec![9; 32]),
            downloader,
            downloaded_at: Timestamp::from_micros(1),
        }
    }

    #[test]
    fn download_record_downloader_must_be_the_author() {
        let me = agent(1);
        assert_eq!(
            validate_download_record(&record(Some(me.clone())), &me).unwrap(),
            ValidateCallbackResult::Valid
        );
        assert!(matches!(
            validate_download_record(&record(Some(agent(2))), &me).unwrap(),
            ValidateCallbackResult::Invalid(_)
        ));
        assert!(matches!(
            validate_download_record(&record(None), &me).unwrap(),
            ValidateCallbackResult::Invalid(_)
        ));
    }

    #[test]
    fn only_the_original_author_may_delete() {
        assert_eq!(
            author_rule(&agent(1), &agent(1)),
            ValidateCallbackResult::Valid
        );
        assert!(matches!(
            author_rule(&agent(1), &agent(2)),
            ValidateCallbackResult::Invalid(_)
        ));
    }
}
