//! TEST-ONLY: unauthorized writes against identity_integrity (see tests/sweettest).
use hdk::prelude::*;
use identity_integrity::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct PlantInput {
    pub base: AgentPubKey,
    pub target: ActionHash,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateClaimInput {
    pub original: ActionHash,
    pub contact_hash: String,
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
pub fn update_claim(input: UpdateClaimInput) -> ExternResult<ActionHash> {
    update_entry(
        input.original,
        EntryTypes::ContactClaim(ContactClaim {
            contact_hash: input.contact_hash,
            agent: agent_info()?.agent_initial_pubkey,
            created_at: sys_time()?,
        }),
    )
}

/// Key substitution attempt: link someone else's key → an X25519 key entry.
#[hdk_extern]
pub fn plant_x25519_link(input: PlantInput) -> ExternResult<ActionHash> {
    create_link(input.base, input.target, LinkTypes::AgentToX25519Key, ())
}

#[hdk_extern]
pub fn x25519_links(agent: AgentPubKey) -> ExternResult<Vec<ActionHash>> {
    Ok(get_links(
        LinkQuery::try_new(agent, LinkTypes::AgentToX25519Key)?,
        GetStrategy::default(),
    )?
    .into_iter()
    .map(|l| l.create_link_hash)
    .collect())
}
