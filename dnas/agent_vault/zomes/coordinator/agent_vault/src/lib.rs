//! Agent Vault — coordinator zome.
//!
//! Owner-only functions (chain author): configs, issuing / rotating / revoking
//! agent tokens, listing tokens and the audit log.
//!
//! Agent-callable functions (the only ones listed in an agent's capability
//! grant): `fetch_bundle`, `token_status`.
//!
//! See `docs/agent-vault/ARCHITECTURE.md`.

use agent_vault_integrity::*;
use hdk::prelude::*;
use std::collections::HashSet;

/// Functions an agent token may call. Nothing that writes owner data.
pub const AGENT_FUNCTIONS: [&str; 2] = ["fetch_bundle", "token_status"];

// ─── Inputs / outputs ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CreateConfigInput {
    pub config_id: String,
    pub name: String,
    #[serde(with = "serde_bytes")]
    pub enc_manifest: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SealedBundleInput {
    pub alg: String,
    #[serde(with = "serde_bytes")]
    pub eph_pub: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub nonce: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IssueTokenInput {
    /// Chosen by the owner's browser (16 random bytes, base64url) so that the
    /// sealed bundle's AAD can bind it before the call.
    pub token_id: String,
    pub config_id: String,
    pub label: String,
    pub agent_key: AgentPubKey,
    #[serde(with = "serde_bytes")]
    pub agent_x25519: Vec<u8>,
    pub sealed: SealedBundleInput,
    pub ttl_seconds: u64,
    pub max_uses: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IssuedToken {
    pub token_id: String,
    pub cap_secret: CapSecret,
    pub grant_action_hash: ActionHash,
    pub expires_at: Timestamp,
    pub cell_id: CellId,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RotateInput {
    pub token_id: String,
    pub sealed: SealedBundleInput,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RevokeInput {
    pub token_id: String,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FetchInput {
    pub token_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FetchResult {
    Granted {
        bundle: SealedBundle,
        expires_at: Timestamp,
    },
    /// Denials are returned as `Ok` so that the audit event is committed
    /// (an `Err` would roll back the whole zome call, audit entry included).
    Denied { reason: String },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TokenStatus {
    pub token_id: String,
    pub config_id: String,
    pub label: String,
    pub agent_key: AgentPubKey,
    /// Needed by the owner UI to re-seal on rotation (public key, not secret).
    #[serde(with = "serde_bytes")]
    pub agent_x25519: Vec<u8>,
    pub issued_at: Timestamp,
    pub expires_at: Timestamp,
    pub max_uses: u32,
    pub uses: u32,
    pub revoked: bool,
    pub expired: bool,
    pub latest_version: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct AuditFilter {
    pub token_id: Option<String>,
    pub since: Option<Timestamp>,
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AuditEntry {
    pub action_hash: ActionHash,
    pub action_seq: u32,
    pub event: AccessEvent,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn guest(msg: impl Into<String>) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(msg.into()))
}

/// Owner-only functions accept:
/// * the chain author (desktop app: calls signed by the owner's own key), or
/// * a signing key the owner delegated through the conductor's admin API
///   (`grant_zome_call_capability` / `authorizeSigningCredentials`, as a
///   browser client on the owner's machine does): an **Assigned** grant that is
///   not an agent token. Grants live on the owner's own chain, only the owner /
///   admin can create them, and the conductor already checked that the grant
///   covers this function — agent-token grants (`fny-agent:` tag) never do.
///
/// Returns the key recorded as provenance in the audit log.
fn require_author() -> ExternResult<AgentPubKey> {
    let info = call_info()?;
    match info.cap_grant {
        CapGrant::ChainAuthor(agent) => Ok(agent),
        CapGrant::RemoteAgent(grant)
            if matches!(grant.access, CapAccess::Assigned { .. })
                && !grant.tag.starts_with(AGENT_TAG_PREFIX) =>
        {
            Ok(info.provenance)
        }
        _ => Err(guest("owner only")),
    }
}

fn entries<T>(unit: UnitEntryTypes) -> ExternResult<Vec<(Record, T)>>
where
    T: TryFrom<SerializedBytes, Error = SerializedBytesError>,
{
    let filter = ChainQueryFilter::new()
        .entry_type(unit.try_into()?)
        .include_entries(true);
    let mut out = Vec::new();
    for record in query(filter)? {
        let value: Option<T> = record
            .entry()
            .to_app_option()
            .map_err(|e| guest(format!("decode: {e}")))?;
        if let Some(v) = value {
            out.push((record, v));
        }
    }
    Ok(out)
}

fn find_token(token_id: &str) -> ExternResult<Option<AgentToken>> {
    Ok(entries::<AgentToken>(UnitEntryTypes::AgentToken)?
        .into_iter()
        .map(|(_, t)| t)
        .find(|t| t.token_id == token_id))
}

fn is_revoked(token_id: &str) -> ExternResult<bool> {
    Ok(entries::<TokenRevocation>(UnitEntryTypes::TokenRevocation)?
        .iter()
        .any(|(_, r)| r.token_id == token_id))
}

fn count_fetches(token_id: &str) -> ExternResult<u32> {
    Ok(entries::<AccessEvent>(UnitEntryTypes::AccessEvent)?
        .iter()
        .filter(|(_, e)| e.token_id == token_id && e.kind == AccessKind::Fetch)
        .count() as u32)
}

fn latest_bundle(token_id: &str) -> ExternResult<Option<SealedBundle>> {
    Ok(entries::<SealedBundle>(UnitEntryTypes::SealedBundle)?
        .into_iter()
        .map(|(_, b)| b)
        .filter(|b| b.token_id == token_id)
        .max_by_key(|b| b.version))
}

fn log_event(
    token_id: &str,
    kind: AccessKind,
    provenance: AgentPubKey,
    bundle_version: Option<u32>,
) -> ExternResult<ActionHash> {
    create_entry(EntryTypes::AccessEvent(AccessEvent {
        token_id: token_id.to_string(),
        kind,
        provenance,
        bundle_version,
        at: sys_time()?,
    }))
}

fn sealed_entry(token_id: &str, version: u32, s: SealedBundleInput) -> ExternResult<SealedBundle> {
    Ok(SealedBundle {
        token_id: token_id.to_string(),
        version,
        alg: s.alg,
        eph_pub: s.eph_pub,
        nonce: s.nonce,
        ciphertext: s.ciphertext,
        created_at: sys_time()?,
    })
}

fn status_of(t: &AgentToken, now: Timestamp) -> ExternResult<TokenStatus> {
    Ok(TokenStatus {
        token_id: t.token_id.clone(),
        config_id: t.config_id.clone(),
        label: t.label.clone(),
        agent_key: t.agent_key.clone(),
        agent_x25519: t.agent_x25519.clone(),
        issued_at: t.issued_at,
        expires_at: t.expires_at,
        max_uses: t.max_uses,
        uses: count_fetches(&t.token_id)?,
        revoked: is_revoked(&t.token_id)?,
        expired: now >= t.expires_at,
        latest_version: latest_bundle(&t.token_id)?.map(|b| b.version).unwrap_or(0),
    })
}

// ─── Owner-only ───────────────────────────────────────────────────────────────

#[hdk_extern]
pub fn create_agent_config(input: CreateConfigInput) -> ExternResult<ActionHash> {
    require_author()?;
    if entries::<AgentConfig>(UnitEntryTypes::AgentConfig)?
        .iter()
        .any(|(_, c)| c.config_id == input.config_id)
    {
        return Err(guest("config_id already exists"));
    }
    create_entry(EntryTypes::AgentConfig(AgentConfig {
        config_id: input.config_id,
        name: input.name,
        enc_manifest: input.enc_manifest,
        created_at: sys_time()?,
    }))
}

#[hdk_extern]
pub fn list_agent_configs(_: ()) -> ExternResult<Vec<AgentConfig>> {
    require_author()?;
    // Append-only: the most recent entry for a config_id wins (new versions = new entries).
    let mut all: Vec<AgentConfig> = entries::<AgentConfig>(UnitEntryTypes::AgentConfig)?
        .into_iter()
        .map(|(_, c)| c)
        .collect();
    all.sort_by_key(|c| c.created_at);
    Ok(all)
}

#[hdk_extern]
pub fn issue_agent_token(input: IssueTokenInput) -> ExternResult<IssuedToken> {
    let owner = require_author()?;
    check_id("token_id", &input.token_id).map_err(guest)?;
    if find_token(&input.token_id)?.is_some() {
        return Err(guest("token_id already exists"));
    }
    if !entries::<AgentConfig>(UnitEntryTypes::AgentConfig)?
        .iter()
        .any(|(_, c)| c.config_id == input.config_id)
    {
        return Err(guest("unknown config_id"));
    }
    let ttl_us = i64::try_from(input.ttl_seconds)
        .ok()
        .and_then(|s| s.checked_mul(1_000_000))
        .filter(|us| (MIN_TTL_US..=MAX_TTL_US).contains(us))
        .ok_or_else(|| guest("ttl_seconds must be between 60 s and 30 days"))?;

    let now = sys_time()?;
    let expires_at = Timestamp::from_micros(now.as_micros() + ttl_us);
    let zome = zome_info()?.name;
    let functions: HashSet<GrantedFunction> = AGENT_FUNCTIONS
        .iter()
        .map(|f| (zome.clone(), FunctionName::from(*f)))
        .collect();
    let secret = generate_cap_secret()?;
    let mut assignees = BTreeSet::new();
    assignees.insert(input.agent_key.clone());
    let grant_action_hash = create_cap_grant(CapGrantEntry {
        tag: grant_tag(&input.token_id),
        access: CapAccess::Assigned { secret, assignees },
        functions: GrantedFunctions::Listed(functions),
    })?;

    create_entry(EntryTypes::AgentToken(AgentToken {
        token_id: input.token_id.clone(),
        config_id: input.config_id,
        label: input.label,
        agent_key: input.agent_key,
        agent_x25519: input.agent_x25519,
        grant_action_hash: grant_action_hash.clone(),
        issued_at: now,
        expires_at,
        max_uses: input.max_uses,
    }))?;
    create_entry(EntryTypes::SealedBundle(sealed_entry(
        &input.token_id,
        1,
        input.sealed,
    )?))?;
    log_event(&input.token_id, AccessKind::Issued, owner.clone(), Some(1))?;

    Ok(IssuedToken {
        token_id: input.token_id,
        cap_secret: secret,
        grant_action_hash,
        expires_at,
        // The cell is (DNA, chain author) — not the caller, which may be a
        // delegated signing key.
        cell_id: CellId::new(dna_info()?.hash, agent_info()?.agent_initial_pubkey),
    })
}

/// Re-seal a token's env map (after the owner edited the config or rotated an
/// upstream credential). The next fetch returns the new version.
#[hdk_extern]
pub fn rotate_bundle(input: RotateInput) -> ExternResult<u32> {
    let owner = require_author()?;
    let token = find_token(&input.token_id)?.ok_or_else(|| guest("unknown token"))?;
    if is_revoked(&token.token_id)? {
        return Err(guest("token is revoked"));
    }
    let next = latest_bundle(&token.token_id)?
        .map(|b| b.version + 1)
        .unwrap_or(1);
    create_entry(EntryTypes::SealedBundle(sealed_entry(
        &token.token_id,
        next,
        input.sealed,
    )?))?;
    log_event(&token.token_id, AccessKind::Rotated, owner, Some(next))?;
    Ok(next)
}

/// Delete the capability grant (effective on the next call) and record why.
/// Values already injected into a running agent cannot be recalled: rotate the
/// upstream credential too.
#[hdk_extern]
pub fn revoke_agent_token(input: RevokeInput) -> ExternResult<()> {
    let owner = require_author()?;
    let token = find_token(&input.token_id)?.ok_or_else(|| guest("unknown token"))?;
    if is_revoked(&token.token_id)? {
        return Ok(());
    }
    delete_cap_grant(token.grant_action_hash.clone())?;
    create_entry(EntryTypes::TokenRevocation(TokenRevocation {
        token_id: token.token_id.clone(),
        reason: input.reason,
        revoked_at: sys_time()?,
    }))?;
    log_event(&token.token_id, AccessKind::Revoked, owner, None)?;
    Ok(())
}

#[hdk_extern]
pub fn list_agent_tokens(_: ()) -> ExternResult<Vec<TokenStatus>> {
    require_author()?;
    let now = sys_time()?;
    entries::<AgentToken>(UnitEntryTypes::AgentToken)?
        .iter()
        .map(|(_, t)| status_of(t, now))
        .collect()
}

/// Audit log, newest first. Each entry carries its action hash and chain
/// sequence so an export can be checked against the signed source chain.
#[hdk_extern]
pub fn list_access_events(filter: AuditFilter) -> ExternResult<Vec<AuditEntry>> {
    require_author()?;
    let mut out: Vec<AuditEntry> = entries::<AccessEvent>(UnitEntryTypes::AccessEvent)?
        .into_iter()
        .filter(|(_, e)| filter.token_id.as_ref().is_none_or(|t| &e.token_id == t))
        .filter(|(_, e)| filter.since.is_none_or(|s| e.at >= s))
        .map(|(r, event)| AuditEntry {
            action_hash: r.action_address().clone(),
            action_seq: r.action().action_seq(),
            event,
        })
        .collect();
    out.sort_by(|a, b| b.action_seq.cmp(&a.action_seq));
    if let Some(limit) = filter.limit {
        out.truncate(limit as usize);
    }
    Ok(out)
}

// ─── Agent-callable (listed in the capability grant) ─────────────────────────

#[hdk_extern]
pub fn fetch_bundle(input: FetchInput) -> ExternResult<FetchResult> {
    let info = call_info()?;
    let tag = match &info.cap_grant {
        CapGrant::RemoteAgent(g) => Some(g.tag.clone()),
        CapGrant::ChainAuthor(_) => None,
    };
    let token = find_token(&input.token_id)?;
    let decision = evaluate_fetch(&FetchContext {
        token_id: &input.token_id,
        grant_tag: tag.as_deref(),
        provenance: &info.provenance,
        token: token.as_ref(),
        now: sys_time()?,
        revoked: is_revoked(&input.token_id)?,
        uses: count_fetches(&input.token_id)?,
    });
    // Only audit against a syntactically valid token id (validation requires it).
    let loggable = check_id("token_id", &input.token_id).is_ok();
    let deny = |reason: DenyReason| -> ExternResult<FetchResult> {
        if loggable {
            log_event(
                &input.token_id,
                AccessKind::Denied(reason.as_str().into()),
                info.provenance.clone(),
                None,
            )?;
        }
        Ok(FetchResult::Denied {
            reason: reason.as_str().into(),
        })
    };
    if let Err(reason) = decision {
        return deny(reason);
    }
    let token = token.expect("checked by evaluate_fetch");
    let Some(bundle) = latest_bundle(&token.token_id)? else {
        return deny(DenyReason::NoBundle);
    };
    log_event(
        &token.token_id,
        AccessKind::Fetch,
        info.provenance.clone(),
        Some(bundle.version),
    )?;
    Ok(FetchResult::Granted {
        bundle,
        expires_at: token.expires_at,
    })
}

/// Agent (with its own token) or owner: token metadata, never secret values.
#[hdk_extern]
pub fn token_status(input: FetchInput) -> ExternResult<TokenStatus> {
    let info = call_info()?;
    let token = find_token(&input.token_id)?.ok_or_else(|| guest("unknown token"))?;
    match &info.cap_grant {
        CapGrant::ChainAuthor(_) => {}
        CapGrant::RemoteAgent(g) => {
            if g.tag != grant_tag(&token.token_id) || info.provenance != token.agent_key {
                return Err(guest("not your token"));
            }
        }
    }
    status_of(&token, sys_time()?)
}
