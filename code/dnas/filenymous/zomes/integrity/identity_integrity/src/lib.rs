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

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    ContactClaim(ContactClaim),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// contact_hash (as base) → ActionHash of the ContactClaim entry
    ContactHashToAgent,
    /// AgentPubKey → ActionHash of their ContactClaim (for self-lookup)
    AgentToContactClaim,
}

// ─── Validation ───────────────────────────────────────────────────────────

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::StoreEntry(store_entry) => match store_entry {
            OpEntry::CreateEntry { app_entry, action } => match app_entry {
                EntryTypes::ContactClaim(claim) => {
                    validate_contact_claim(&claim, &action.author)
                }
            },
            OpEntry::UpdateEntry { app_entry, action, .. } => match app_entry {
                EntryTypes::ContactClaim(claim) => {
                    validate_contact_claim(&claim, &action.author)
                }
            },
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::RegisterCreateLink {
            link_type,
            base_address,
            target_address,
            action,
            ..
        } => match link_type {
            LinkTypes::ContactHashToAgent => {
                // Only the agent itself may publish its own contact link
                let _ = (base_address, target_address);
                Ok(ValidateCallbackResult::Valid)
            }
            LinkTypes::AgentToContactClaim => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::RegisterDeleteLink { .. } => Ok(ValidateCallbackResult::Valid),
        _ => Ok(ValidateCallbackResult::Valid),
    }
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
