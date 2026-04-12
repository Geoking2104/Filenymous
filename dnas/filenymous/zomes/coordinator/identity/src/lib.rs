use hdk::prelude::*;
use identity_integrity::*;

// ─── Input structs ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct ClaimContactInput {
    /// SHA-256 hex of the normalised contact (email lowercase / e.164 phone)
    pub contact_hash: String,
}

// ─── Exported functions ───────────────────────────────────────────────────

/// Publish a ContactClaim linking this agent to a contact hash.
/// Called after OTP verification (the bridge validates the OTP externally;
/// this function trusts the caller and stores the claim on the DHT).
#[hdk_extern]
pub fn claim_contact(input: ClaimContactInput) -> ExternResult<ActionHash> {
    let agent = agent_info()?.agent_latest_pubkey;
    let claim = ContactClaim {
        contact_hash: input.contact_hash.clone(),
        agent: agent.clone(),
        created_at: sys_time()?,
    };

    let action_hash = create_entry(EntryTypes::ContactClaim(claim))?;

    // Link: contact_hash anchor → ActionHash (for resolution by other agents)
    let contact_anchor = anchor_for_contact(&input.contact_hash)?;
    create_link(
        contact_anchor,
        action_hash.clone(),
        LinkTypes::ContactHashToAgent,
        (),
    )?;

    // Link: agent → ActionHash (for self-lookup / revocation)
    create_link(
        agent,
        action_hash.clone(),
        LinkTypes::AgentToContactClaim,
        (),
    )?;

    Ok(action_hash)
}

/// Resolve a contact hash to an AgentPubKey.
/// Returns None if no ContactClaim exists for this hash.
#[hdk_extern]
pub fn get_agent_for_contact(contact_hash: String) -> ExternResult<Option<AgentPubKey>> {
    let contact_anchor = anchor_for_contact(&contact_hash)?;

    let links = get_links(
        GetLinksInputBuilder::try_new(contact_anchor, LinkTypes::ContactHashToAgent)?.build(),
    )?;

    // Take the most recent claim (last link created)
    let latest = links.into_iter().max_by_key(|l| l.timestamp);

    match latest {
        None => Ok(None),
        Some(link) => {
            let action_hash = ActionHash::try_from(link.target)
                .map_err(|_| wasm_error!(WasmErrorInner::Guest("Invalid link target".into())))?;
            let record = get(action_hash, GetOptions::default())?;
            match record {
                None => Ok(None),
                Some(record) => {
                    let claim: ContactClaim = record
                        .entry()
                        .to_app_option()
                        .map_err(|e| {
                            wasm_error!(WasmErrorInner::Guest(format!(
                                "Deserialisation failed: {e}"
                            )))
                        })?
                        .ok_or_else(|| {
                            wasm_error!(WasmErrorInner::Guest("Empty entry".into()))
                        })?;
                    Ok(Some(claim.agent))
                }
            }
        }
    }
}

/// Delete this agent's ContactClaim (RGPD right to erasure).
/// Removes both links and the entry itself.
#[hdk_extern]
pub fn revoke_contact_claim(contact_hash: String) -> ExternResult<ActionHash> {
    let agent = agent_info()?.agent_latest_pubkey;

    let links = get_links(
        GetLinksInputBuilder::try_new(agent.clone(), LinkTypes::AgentToContactClaim)?.build(),
    )?;

    for link in links {
        let action_hash = ActionHash::try_from(link.target.clone())
            .map_err(|_| wasm_error!(WasmErrorInner::Guest("Invalid link target".into())))?;
        let record = get(action_hash.clone(), GetOptions::default())?;
        if let Some(record) = record {
            let claim: Option<ContactClaim> = record.entry().to_app_option().ok().flatten();
            if let Some(c) = claim {
                if c.contact_hash == contact_hash {
                    delete_entry(action_hash.clone())?;
                    delete_link(link.create_link_hash)?;
                    return Ok(action_hash);
                }
            }
        }
    }

    Err(wasm_error!(WasmErrorInner::Guest(
        "No ContactClaim found for this contact_hash".into()
    )))
}

// ─── M3: X25519 key management ───────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct PublishX25519KeyInput {
    /// Raw 32-byte X25519 public key, base64-encoded.
    pub x25519_pubkey_b64: String,
}

/// Publish (or replace) this agent's X25519 public key on the DHT.
/// The UI calls this once after generating a keypair in the browser.
#[hdk_extern]
pub fn publish_x25519_key(input: PublishX25519KeyInput) -> ExternResult<ActionHash> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let raw = STANDARD
        .decode(&input.x25519_pubkey_b64)
        .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("base64 decode: {e}"))))?;

    if raw.len() != 32 {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "x25519 public key must be exactly 32 bytes".into()
        )));
    }

    let agent = agent_info()?.agent_latest_pubkey;
    let key_entry = AgentX25519Key {
        x25519_pubkey: raw,
        agent: agent.clone(),
        created_at: sys_time()?,
    };

    let action_hash = create_entry(EntryTypes::AgentX25519Key(key_entry))?;

    // Remove any previous X25519 key links from this agent
    let old_links = get_links(
        GetLinksInputBuilder::try_new(agent.clone(), LinkTypes::AgentToX25519Key)?.build(),
    )?;
    for link in old_links {
        delete_link(link.create_link_hash)?;
    }

    // Create the canonical link: agent → this key entry
    create_link(
        agent,
        action_hash.clone(),
        LinkTypes::AgentToX25519Key,
        (),
    )?;

    Ok(action_hash)
}

/// Retrieve an agent's X25519 public key (raw 32 bytes, base64-encoded).
/// Returns None if the agent has not published a key yet.
#[hdk_extern]
pub fn get_x25519_key(agent: AgentPubKey) -> ExternResult<Option<String>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let links = get_links(
        GetLinksInputBuilder::try_new(agent, LinkTypes::AgentToX25519Key)?.build(),
    )?;

    // Most recent link wins
    let latest = links.into_iter().max_by_key(|l| l.timestamp);

    match latest {
        None => Ok(None),
        Some(link) => {
            let action_hash = ActionHash::try_from(link.target)
                .map_err(|_| wasm_error!(WasmErrorInner::Guest("Invalid link target".into())))?;
            let record = get(action_hash, GetOptions::default())?;
            match record {
                None => Ok(None),
                Some(record) => {
                    let key_entry: AgentX25519Key = record
                        .entry()
                        .to_app_option()
                        .map_err(|e| {
                            wasm_error!(WasmErrorInner::Guest(format!("Deserialise: {e}")))
                        })?
                        .ok_or_else(|| {
                            wasm_error!(WasmErrorInner::Guest("Empty entry".into()))
                        })?;
                    Ok(Some(STANDARD.encode(&key_entry.x25519_pubkey)))
                }
            }
        }
    }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

fn anchor_for_contact(contact_hash: &str) -> ExternResult<AnyLinkableHash> {
    // Use the contact_hash string as a path component → deterministic DHT address
    let path = Path::from(format!("contacts.{contact_hash}"));
    Ok(path.path_entry_hash()?.into())
}
