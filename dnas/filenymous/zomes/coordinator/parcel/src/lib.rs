use hdk::prelude::*;
use parcel_integrity::*;

// ─── Types d'entrée ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateParcelInput {
    pub file_hash: EntryHash,
    pub file_name: String,
    pub file_size: u64,
    pub chunk_count: u32,
    pub recipient_contact_hash: String,
    /// Clé AES wrappée ECIES (base64). Vide si destinataire anonyme.
    pub encrypted_key_blob: String,
    /// 0 = jamais
    pub expiry_us: i64,
    /// 0 = illimité
    pub max_downloads: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ParcelOutput {
    pub parcel_eh: EntryHash,
    pub action_hash: ActionHash,
    pub manifest: ParcelManifest,
    pub download_count: u32,
    pub is_revoked: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum FilenymousSignal {
    /// Notifie un agent qu'un parcel l'attend
    IncomingParcel {
        parcel_eh: EntryHash,
        sender: AgentPubKey,
        file_name: String,
        file_size: u64,
    },
}

// ─── Fonctions exportées ──────────────────────────────────────────────────────

/// Crée un ParcelManifest sur le DHT, puis :
///  - Si le destinataire a un agent connu → envoie un remote_signal + crée PendingParcel
///  - Sinon → crée uniquement un PendingParcel (le lien suffit pour le téléchargement)
#[hdk_extern]
pub fn create_parcel(input: CreateParcelInput) -> ExternResult<ParcelOutput> {
    let sender = agent_info()?.agent_initial_pubkey;
    let now = sys_time()?;

    let manifest = ParcelManifest {
        file_hash: input.file_hash.clone(),
        file_name: input.file_name.clone(),
        file_size: input.file_size,
        chunk_count: input.chunk_count,
        sender: sender.clone(),
        recipient_contact_hash: input.recipient_contact_hash.clone(),
        encrypted_key_blob: input.encrypted_key_blob.clone(),
        expiry_us: input.expiry_us,
        max_downloads: input.max_downloads,
        created_at: now,
    };

    let action_hash = create_entry(EntryTypes::ParcelManifest(manifest.clone()))?;
    let parcel_eh = hash_entry(EntryTypes::ParcelManifest(manifest.clone()))?;

    // Lien expéditeur → parcel (pour get_my_sent_parcels)
    create_link(
        sender.clone(),
        action_hash.clone(),
        LinkTypes::SenderToParcel,
        (),
    )?;

    // Lien contact_hash destinataire → parcel (pour résolution DHT)
    let contact_anchor = contact_path(&input.recipient_contact_hash)?;
    create_link(
        contact_anchor,
        action_hash.clone(),
        LinkTypes::ContactHashToParcel,
        (),
    )?;

    // PendingParcel sur DHT (persistant pour les agents offline)
    let pending = PendingParcel {
        parcel_eh: parcel_eh.clone(),
        recipient_contact_hash: input.recipient_contact_hash.clone(),
        created_at: now,
    };
    let pending_ah = create_entry(EntryTypes::PendingParcel(pending))?;
    create_link(
        parcel_eh.clone(),
        pending_ah,
        LinkTypes::ParcelToPending,
        (),
    )?;

    // Tente de notifier l'agent destinataire en temps réel via cross-call identity
    // (non bloquant — échec silencieux si agent non trouvé ou offline)
    let _ = notify_recipient_if_online(
        &input.recipient_contact_hash,
        &parcel_eh,
        &sender,
        &input.file_name,
        input.file_size,
    );

    Ok(ParcelOutput {
        parcel_eh,
        action_hash,
        manifest,
        download_count: 0,
        is_revoked: false,
    })
}

/// Récupère un ParcelManifest par son EntryHash.
#[hdk_extern]
pub fn get_parcel(parcel_eh: EntryHash) -> ExternResult<Option<ParcelOutput>> {
    let record = get(parcel_eh.clone(), GetOptions::default())?;
    match record {
        None => Ok(None),
        Some(r) => {
            let manifest: ParcelManifest = r
                .entry()
                .to_app_option()
                .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("Déserialisation: {e}"))))?
                .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("Entrée vide".into())))?;

            let download_count = count_downloads(&parcel_eh)?;
            let is_revoked = check_revoked(&parcel_eh)?;

            Ok(Some(ParcelOutput {
                parcel_eh,
                action_hash: r.action_address().clone(),
                manifest,
                download_count,
                is_revoked,
            }))
        }
    }
}

/// Liste tous les parcels envoyés par cet agent.
#[hdk_extern]
pub fn get_my_sent_parcels(_: ()) -> ExternResult<Vec<ParcelOutput>> {
    let agent = agent_info()?.agent_initial_pubkey;
    let links = get_links(
        LinkQuery::try_new(agent, LinkTypes::SenderToParcel)?,
        GetStrategy::default(),
    )?;

    let mut results = Vec::new();
    for link in links {
        let ah = ActionHash::try_from(link.target)
            .map_err(|_| wasm_error!(WasmErrorInner::Guest("Cible de lien invalide".into())))?;
        if let Some(record) = get(ah.clone(), GetOptions::default())? {
            if let Ok(Some(manifest)) = record.entry().to_app_option::<ParcelManifest>() {
                let parcel_eh = hash_entry(EntryTypes::ParcelManifest(manifest.clone()))?;
                let download_count = count_downloads(&parcel_eh)?;
                let is_revoked = check_revoked(&parcel_eh)?;
                results.push(ParcelOutput {
                    parcel_eh,
                    action_hash: ah,
                    manifest,
                    download_count,
                    is_revoked,
                });
            }
        }
    }
    Ok(results)
}

/// Liste les parcels en attente pour un contact_hash donné.
/// Utilisé par le destinataire pour voir ses fichiers entrants.
#[hdk_extern]
pub fn get_pending_parcels_for_contact(contact_hash: String) -> ExternResult<Vec<ParcelOutput>> {
    let contact_anchor = contact_path(&contact_hash)?;
    let links = get_links(
        LinkQuery::try_new(contact_anchor, LinkTypes::ContactHashToParcel)?,
        GetStrategy::default(),
    )?;

    let mut results = Vec::new();
    for link in links {
        let ah = ActionHash::try_from(link.target)
            .map_err(|_| wasm_error!(WasmErrorInner::Guest("Cible invalide".into())))?;
        if let Some(record) = get(ah.clone(), GetOptions::default())? {
            if let Ok(Some(manifest)) = record.entry().to_app_option::<ParcelManifest>() {
                let parcel_eh = hash_entry(EntryTypes::ParcelManifest(manifest.clone()))?;
                let download_count = count_downloads(&parcel_eh)?;
                let is_revoked = check_revoked(&parcel_eh)?;
                // Filtre les parcels expirés ou révoqués
                if is_revoked {
                    continue;
                }
                if manifest.expiry_us > 0 {
                    let now_us = sys_time()?.as_micros();
                    if now_us > manifest.expiry_us {
                        continue;
                    }
                }
                // Filtre les parcels au max de téléchargements
                if manifest.max_downloads > 0 && download_count >= manifest.max_downloads {
                    continue;
                }
                results.push(ParcelOutput {
                    parcel_eh,
                    action_hash: ah,
                    manifest,
                    download_count,
                    is_revoked,
                });
            }
        }
    }
    Ok(results)
}

/// Enregistre un téléchargement (append-only, immuable).
/// Appelé après déchiffrement réussi côté client.
#[hdk_extern]
pub fn confirm_download(parcel_eh: EntryHash) -> ExternResult<ActionHash> {
    let downloader = agent_info()?.agent_initial_pubkey;
    let record = DownloadRecord {
        parcel_eh: parcel_eh.clone(),
        downloader: Some(downloader),
        downloaded_at: sys_time()?,
    };
    let ah = create_entry(EntryTypes::DownloadRecord(record))?;
    create_link(parcel_eh, ah.clone(), LinkTypes::ParcelToDownload, ())?;
    Ok(ah)
}

/// Révoque un parcel (seul l'expéditeur peut révoquer).
/// Crée une entrée de marquage dans la source-chain de l'expéditeur et
/// supprime le lien ContactHashToParcel pour retirer le parcel de la DHT.
#[hdk_extern]
pub fn revoke_parcel(parcel_eh: EntryHash) -> ExternResult<ActionHash> {
    // Vérification que l'appelant est bien l'expéditeur
    let agent = agent_info()?.agent_initial_pubkey;
    let parcel = get(parcel_eh.clone(), GetOptions::default())?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("Parcel introuvable".into())))?;
    let manifest: ParcelManifest = parcel
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("{e}"))))?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("Entrée vide".into())))?;

    if manifest.sender != agent {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "Seul l'expéditeur peut révoquer ce parcel".into()
        )));
    }

    // Ancre de révocation (lookup rapide)
    let revoke_anchor = revoked_path()?;
    let ah = create_link(
        revoke_anchor,
        parcel_eh.clone(),
        LinkTypes::RevokedParcels,
        (),
    )?;

    // Supprime le lien contact → parcel (retire du listing DHT)
    let contact_anchor = contact_path(&manifest.recipient_contact_hash)?;
    let links = get_links(
        LinkQuery::try_new(contact_anchor, LinkTypes::ContactHashToParcel)?,
        GetStrategy::default(),
    )?;
    for link in links {
        if let Ok(target_ah) = ActionHash::try_from(link.target.clone()) {
            if target_ah == parcel.action_address().clone() {
                delete_link(link.create_link_hash, GetOptions::default())?;
                break;
            }
        }
    }

    Ok(ah)
}

// ─── Helpers internes ─────────────────────────────────────────────────────────

fn contact_path(contact_hash: &str) -> ExternResult<AnyLinkableHash> {
    let path = Path::from(format!("parcels.contact.{contact_hash}"));
    Ok(path.path_entry_hash()?.into())
}

fn revoked_path() -> ExternResult<AnyLinkableHash> {
    let path = Path::from("parcels.revoked");
    Ok(path.path_entry_hash()?.into())
}

fn count_downloads(parcel_eh: &EntryHash) -> ExternResult<u32> {
    let links = get_links(
        LinkQuery::try_new(parcel_eh.clone(), LinkTypes::ParcelToDownload)?,
        GetStrategy::default(),
    )?;
    Ok(links.len() as u32)
}

fn check_revoked(parcel_eh: &EntryHash) -> ExternResult<bool> {
    let anchor = revoked_path()?;
    let links = get_links(
        LinkQuery::try_new(anchor, LinkTypes::RevokedParcels)?,
        GetStrategy::default(),
    )?;
    for link in links {
        if let Ok(eh) = EntryHash::try_from(link.target) {
            if &eh == parcel_eh {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Tente un remote_signal vers l'agent destinataire.
/// Non bloquant : les erreurs sont ignorées (agent offline, non enregistré).
fn notify_recipient_if_online(
    contact_hash: &str,
    parcel_eh: &EntryHash,
    sender: &AgentPubKey,
    file_name: &str,
    file_size: u64,
) -> ExternResult<()> {
    // Résoudre le contact → agent via cross-call identity zome
    let recipient_agent: Option<AgentPubKey> = call(
        CallTargetCell::Local,
        "identity",
        "get_agent_for_contact".into(),
        None,
        contact_hash.to_string(),
    )
    .ok()
    .and_then(|r| match r {
        ZomeCallResponse::Ok(v) => v.decode().ok(),
        _ => None,
    });

    if let Some(agent) = recipient_agent {
        let signal = FilenymousSignal::IncomingParcel {
            parcel_eh: parcel_eh.clone(),
            sender: sender.clone(),
            file_name: file_name.to_string(),
            file_size,
        };
        let _ = send_remote_signal(
            ExternIO::encode(signal)
                .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("Encode signal: {e}"))))?,
            vec![agent],
        );
    }

    Ok(())
}
