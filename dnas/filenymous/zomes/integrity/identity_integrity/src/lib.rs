use hdi::prelude::*;

/// A ContactClaim binds a contact hash (SHA-256 of email or phone)
/// to the agent's public key.  Published on the DHT so other agents
/// can resolve an email/phone to an AgentPubKey without a central DB.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct ContactClaim {
    /// SHA-256 hex of normalised contact (lowercase email, e.164 phone)
    pub contact_hash: String,
    /// Redundant with the source chain author, stored for direct lookup.
    pub agent: AgentPubKey,
    /// Unix timestamp (microseconds) of claim creation.
    pub created_at: Timestamp,
}

/// M3 — An agent's X25519 Diffie-Hellman public key, published on the DHT
/// so that senders can ECIES-wrap the AES session key for that recipient.
/// The corresponding private key never leaves the recipient's browser.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct AgentX25519Key {
    /// Raw 32-byte X25519 public key (big-endian).
    pub x25519_pubkey: Vec<u8>,
    /// The Holochain agent this key belongs to.
    pub agent: AgentPubKey,
    /// Timestamp (microseconds) of publication.
    pub created_at: Timestamp,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    ContactClaim(ContactClaim),
    /// M3
    AgentX25519Key(AgentX25519Key),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// contact_hash (as base) → ActionHash of the ContactClaim entry
    ContactHashToAgent,
    /// AgentPubKey → ActionHash of their ContactClaim (for self-lookup)
    AgentToContactClaim,
    /// M3: AgentPubKey → ActionHash of their AgentX25519Key entry
    AgentToX25519Key,
}

// ─── Validation ───────────────────────────────────────────────────────────
//
// Authorization rules (all ops, so both the author's inline validation and DHT
// authorities enforce them):
//  * an entry may only be updated or deleted by the agent who created it;
//  * a link may only be deleted by the agent who created it;
//  * links must point from the author's own key / own contact anchor to an
//    entry the author created (prevents planting another agent's X25519 key or
//    contact claim — key substitution).

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::StoreEntry(OpEntry::CreateEntry { app_entry, action })
        | FlatOp::StoreRecord(OpRecord::CreateEntry { app_entry, action }) => {
            validate_entry(&app_entry, &action.author)
        }
        FlatOp::StoreEntry(OpEntry::UpdateEntry {
            original_action_hash,
            app_entry,
            action,
            ..
        })
        | FlatOp::StoreRecord(OpRecord::UpdateEntry {
            original_action_hash,
            app_entry,
            action,
            ..
        }) => and_then(
            same_author(&original_action_hash, &action.author, "update")?,
            || validate_entry(&app_entry, &action.author),
        ),
        FlatOp::RegisterUpdate(OpUpdate::Entry { app_entry, action }) => and_then(
            same_author(&action.original_action_address, &action.author, "update")?,
            || validate_entry(&app_entry, &action.author),
        ),
        FlatOp::StoreRecord(OpRecord::DeleteEntry {
            original_action_hash,
            action,
            ..
        }) => same_author(&original_action_hash, &action.author, "delete"),
        FlatOp::RegisterDelete(OpDelete { action }) => {
            same_author(&action.deletes_address, &action.author, "delete")
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
        } => Ok(link_delete_rule(&original_action.author, &action.author)),
        FlatOp::StoreRecord(OpRecord::DeleteLink {
            original_action_hash,
            action,
            ..
        }) => {
            let original = must_get_action(original_action_hash)?;
            Ok(link_delete_rule(original.action().author(), &action.author))
        }
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_entry(
    entry: &EntryTypes,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    match entry {
        EntryTypes::ContactClaim(claim) => validate_contact_claim(claim, author),
        EntryTypes::AgentX25519Key(key_entry) => validate_x25519_key(key_entry, author),
    }
}

fn and_then(
    first: ValidateCallbackResult,
    next: impl FnOnce() -> ExternResult<ValidateCallbackResult>,
) -> ExternResult<ValidateCallbackResult> {
    match first {
        ValidateCallbackResult::Valid => next(),
        other => Ok(other),
    }
}

/// Only the original author may update / delete an action's entry.
fn same_author(
    original: &ActionHash,
    author: &AgentPubKey,
    what: &str,
) -> ExternResult<ValidateCallbackResult> {
    let original = must_get_action(original.clone())?;
    Ok(author_rule(original.action().author(), author, what))
}

/// Pure rule (unit-tested): `who` may act on something created by `owner`.
pub fn author_rule(owner: &AgentPubKey, who: &AgentPubKey, what: &str) -> ValidateCallbackResult {
    if owner == who {
        ValidateCallbackResult::Valid
    } else {
        ValidateCallbackResult::Invalid(format!("only the original author may {what} this entry"))
    }
}

/// Pure rule (unit-tested): only the link's creator may delete it.
pub fn link_delete_rule(link_author: &AgentPubKey, who: &AgentPubKey) -> ValidateCallbackResult {
    if link_author == who {
        ValidateCallbackResult::Valid
    } else {
        ValidateCallbackResult::Invalid("only the link's author may delete it".into())
    }
}

/// Deterministic DHT anchor for a contact hash (same as the coordinator's).
pub fn contact_anchor(contact_hash: &str) -> ExternResult<AnyLinkableHash> {
    Ok(Path::from(format!("contacts.{contact_hash}"))
        .path_entry_hash()?
        .into())
}

fn invalid(msg: &str) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(msg.into()))
}

/// The link target must be a record created by the link author; returns it.
fn own_target(target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<Option<Record>> {
    let Some(ah) = target.clone().into_action_hash() else {
        return Ok(None);
    };
    let record = must_get_valid_record(ah)?;
    Ok((record.action().author() == author).then_some(record))
}

fn validate_create_link(
    link_type: LinkTypes,
    base: &AnyLinkableHash,
    target: &AnyLinkableHash,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = own_target(target, author)? else {
        return invalid("link target must be an entry created by the link author");
    };
    match link_type {
        LinkTypes::ContactHashToAgent => {
            let Some(claim) = record
                .entry()
                .to_app_option::<ContactClaim>()
                .ok()
                .flatten()
            else {
                return invalid("ContactHashToAgent must target a ContactClaim");
            };
            if &contact_anchor(&claim.contact_hash)? != base {
                return invalid("ContactHashToAgent base must be the claim's contact anchor");
            }
        }
        LinkTypes::AgentToContactClaim | LinkTypes::AgentToX25519Key => {
            if base.clone().into_agent_pub_key().as_ref() != Some(author) {
                return invalid("an agent may only link from its own public key");
            }
            let ok = match link_type {
                LinkTypes::AgentToContactClaim => record
                    .entry()
                    .to_app_option::<ContactClaim>()
                    .ok()
                    .flatten()
                    .is_some(),
                _ => record
                    .entry()
                    .to_app_option::<AgentX25519Key>()
                    .ok()
                    .flatten()
                    .is_some(),
            };
            if !ok {
                return invalid("link target has the wrong entry type");
            }
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_contact_claim(
    claim: &ContactClaim,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    // contact_hash must be a 64-char hex string (SHA-256)
    if claim.contact_hash.len() != 64 {
        return Ok(ValidateCallbackResult::Invalid(
            "contact_hash must be a 64-char SHA-256 hex string".into(),
        ));
    }
    if !claim.contact_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(ValidateCallbackResult::Invalid(
            "contact_hash must contain only hex characters".into(),
        ));
    }
    // The claim's agent field must match the author
    if &claim.agent != author {
        return Ok(ValidateCallbackResult::Invalid(
            "ContactClaim.agent must equal the action author".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_x25519_key(
    key_entry: &AgentX25519Key,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    // X25519 public keys are always 32 bytes
    if key_entry.x25519_pubkey.len() != 32 {
        return Ok(ValidateCallbackResult::Invalid(
            "x25519_pubkey must be exactly 32 bytes".into(),
        ));
    }
    // The entry's agent field must match the author
    if &key_entry.agent != author {
        return Ok(ValidateCallbackResult::Invalid(
            "AgentX25519Key.agent must equal the action author".into(),
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

    #[test]
    fn only_the_original_author_may_update_or_delete() {
        assert_eq!(
            author_rule(&agent(1), &agent(1), "delete"),
            ValidateCallbackResult::Valid
        );
        assert!(matches!(
            author_rule(&agent(1), &agent(2), "delete"),
            ValidateCallbackResult::Invalid(_)
        ));
        assert!(matches!(
            author_rule(&agent(1), &agent(2), "update"),
            ValidateCallbackResult::Invalid(_)
        ));
    }

    #[test]
    fn only_the_link_author_may_delete_a_link() {
        assert_eq!(
            link_delete_rule(&agent(3), &agent(3)),
            ValidateCallbackResult::Valid
        );
        assert!(matches!(
            link_delete_rule(&agent(3), &agent(4)),
            ValidateCallbackResult::Invalid(_)
        ));
    }

    #[test]
    fn claim_and_key_must_belong_to_the_author() {
        let now = Timestamp::from_micros(1);
        let claim = ContactClaim {
            contact_hash: "a".repeat(64),
            agent: agent(1),
            created_at: now,
        };
        assert_eq!(
            validate_contact_claim(&claim, &agent(1)).unwrap(),
            ValidateCallbackResult::Valid
        );
        assert!(matches!(
            validate_contact_claim(&claim, &agent(2)).unwrap(),
            ValidateCallbackResult::Invalid(_)
        ));
        let key = AgentX25519Key {
            x25519_pubkey: vec![0; 32],
            agent: agent(1),
            created_at: now,
        };
        assert!(matches!(
            validate_x25519_key(&key, &agent(2)).unwrap(),
            ValidateCallbackResult::Invalid(_)
        ));
    }
}
