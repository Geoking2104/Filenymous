//! Pure, deterministic content rules (no host calls) so they can be unit tested natively.

use crate::{AccessEvent, AccessKind, AgentConfig, AgentToken, SealedBundle, TokenRevocation};
use hdi::prelude::*;

/// Hard cap on a token lifetime: 30 days.
pub const MAX_TTL_US: i64 = 30 * 24 * 3600 * 1_000_000;
/// Minimum lifetime: 60 s.
pub const MIN_TTL_US: i64 = 60 * 1_000_000;
pub const MAX_BUNDLE_BYTES: usize = 64 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 16 * 1024;
/// Tolerated gap between an entry's own timestamp field and its action timestamp.
pub const CLOCK_SKEW_US: i64 = 5 * 60 * 1_000_000;
/// Sealed-box algorithm used by `ui/src/safe/agentSeal.ts`.
pub const ALG_X25519_HKDF_AESGCM: &str = "x25519-hkdf-sha256-aes256gcm/v1";
pub const ALLOWED_ALGS: &[&str] = &[ALG_X25519_HKDF_AESGCM];

pub const APPEND_ONLY: &str = "agent_vault entries are append-only (no update / delete)";
pub const NO_LINKS: &str = "agent_vault defines no link types (links are public)";

/// Prefix of every agent-token capability grant tag.
pub const AGENT_TAG_PREFIX: &str = "fny-agent:";

/// `fny-agent:<token_id>` — binds a capability grant to exactly one token.
pub fn grant_tag(token_id: &str) -> String {
    format!("{AGENT_TAG_PREFIX}{token_id}")
}

/// 16..=64 chars of base64url alphabet.
pub fn check_id(kind: &str, id: &str) -> Result<(), String> {
    let ok = (16..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("{kind} must be 16..64 base64url chars"))
    }
}

fn near(field: i64, action_now: i64, what: &str) -> Result<(), String> {
    if (field - action_now).abs() > CLOCK_SKEW_US {
        return Err(format!(
            "{what} must be within 5 min of the action timestamp"
        ));
    }
    Ok(())
}

pub fn check_agent_config(c: &AgentConfig, now: i64) -> Result<(), String> {
    check_id("config_id", &c.config_id)?;
    let n = c.name.chars().count();
    if n == 0 || n > 64 {
        return Err("name must be 1..64 chars".into());
    }
    if c.enc_manifest.is_empty() || c.enc_manifest.len() > MAX_MANIFEST_BYTES {
        return Err("enc_manifest must be 1..16 KiB".into());
    }
    near(c.created_at.as_micros(), now, "created_at")
}

pub fn check_agent_token(t: &AgentToken, author: &AgentPubKey, now: i64) -> Result<(), String> {
    check_id("token_id", &t.token_id)?;
    check_id("config_id", &t.config_id)?;
    if t.label.chars().count() > 64 {
        return Err("label must be <= 64 chars".into());
    }
    if &t.agent_key == author {
        return Err("an agent token can never be assigned to the chain author".into());
    }
    if t.agent_x25519.len() != 32 {
        return Err("agent_x25519 must be 32 bytes".into());
    }
    near(t.issued_at.as_micros(), now, "issued_at")?;
    let ttl = t.expires_at.as_micros() - t.issued_at.as_micros();
    if ttl < MIN_TTL_US {
        return Err("token lifetime must be >= 60 s".into());
    }
    if ttl > MAX_TTL_US {
        return Err("token lifetime must be <= 30 days".into());
    }
    Ok(())
}

pub fn check_sealed_bundle(b: &SealedBundle, now: i64) -> Result<(), String> {
    check_id("token_id", &b.token_id)?;
    if b.version == 0 {
        return Err("version starts at 1".into());
    }
    if !ALLOWED_ALGS.contains(&b.alg.as_str()) {
        return Err("unsupported sealing algorithm".into());
    }
    if b.eph_pub.len() != 32 {
        return Err("eph_pub must be 32 bytes".into());
    }
    if b.nonce.len() != 12 {
        return Err("nonce must be 12 bytes (AES-GCM IV)".into());
    }
    // AES-GCM tag alone is 16 bytes.
    if b.ciphertext.len() <= 16 || b.ciphertext.len() > MAX_BUNDLE_BYTES {
        return Err("ciphertext must be 17 B .. 64 KiB".into());
    }
    near(b.created_at.as_micros(), now, "created_at")
}

pub fn check_revocation(r: &TokenRevocation, now: i64) -> Result<(), String> {
    check_id("token_id", &r.token_id)?;
    if r.reason.chars().count() > 256 {
        return Err("reason must be <= 256 chars".into());
    }
    near(r.revoked_at.as_micros(), now, "revoked_at")
}

pub fn check_access_event(e: &AccessEvent, now: i64) -> Result<(), String> {
    check_id("token_id", &e.token_id)?;
    if let AccessKind::Denied(reason) = &e.kind {
        if reason.is_empty() || reason.len() > 128 {
            return Err("denial reason must be 1..128 bytes".into());
        }
    }
    near(e.at.as_micros(), now, "at")
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000_000;
    fn ts(us: i64) -> Timestamp {
        Timestamp::from_micros(us)
    }
    fn owner() -> AgentPubKey {
        AgentPubKey::from_raw_36(vec![1; 36])
    }
    fn agent() -> AgentPubKey {
        AgentPubKey::from_raw_36(vec![2; 36])
    }
    fn id() -> String {
        "AAAAAAAAAAAAAAAAAAAAAA".into()
    }
    fn token() -> AgentToken {
        AgentToken {
            token_id: id(),
            config_id: id(),
            label: "claude-ci".into(),
            agent_key: agent(),
            agent_x25519: vec![7; 32],
            grant_action_hash: ActionHash::from_raw_36(vec![3; 36]),
            issued_at: ts(NOW),
            expires_at: ts(NOW + 3_600_000_000),
            max_uses: 0,
        }
    }
    fn bundle() -> SealedBundle {
        SealedBundle {
            token_id: id(),
            version: 1,
            alg: ALG_X25519_HKDF_AESGCM.into(),
            eph_pub: vec![1; 32],
            nonce: vec![0; 12],
            ciphertext: vec![9; 64],
            created_at: ts(NOW),
        }
    }

    #[test]
    fn ids() {
        assert!(check_id("x", &id()).is_ok());
        assert!(check_id("x", "short").is_err());
        assert!(check_id("x", "AAAAAAAAAAAAAAAAAAAA/=").is_err());
        assert!(check_id("x", &"a".repeat(65)).is_err());
        assert_eq!(grant_tag("abc"), "fny-agent:abc");
    }

    #[test]
    fn token_rules() {
        assert!(check_agent_token(&token(), &owner(), NOW).is_ok());
        // assigned to the author
        assert!(check_agent_token(&token(), &agent(), NOW).is_err());
        let mut t = token();
        t.expires_at = ts(NOW + MAX_TTL_US + 1);
        assert!(check_agent_token(&t, &owner(), NOW).is_err());
        t.expires_at = ts(NOW + 1_000_000);
        assert!(check_agent_token(&t, &owner(), NOW).is_err(), "ttl < 60s");
        let mut t = token();
        t.agent_x25519 = vec![0; 31];
        assert!(check_agent_token(&t, &owner(), NOW).is_err());
        // backdated issued_at
        assert!(check_agent_token(&token(), &owner(), NOW + CLOCK_SKEW_US + 1).is_err());
    }

    #[test]
    fn bundle_rules() {
        assert!(check_sealed_bundle(&bundle(), NOW).is_ok());
        let mut b = bundle();
        b.version = 0;
        assert!(check_sealed_bundle(&b, NOW).is_err());
        let mut b = bundle();
        b.alg = "plaintext".into();
        assert!(check_sealed_bundle(&b, NOW).is_err());
        let mut b = bundle();
        b.ciphertext = vec![0; MAX_BUNDLE_BYTES + 1];
        assert!(check_sealed_bundle(&b, NOW).is_err());
        let mut b = bundle();
        b.nonce = vec![0; 24];
        assert!(check_sealed_bundle(&b, NOW).is_err());
    }

    #[test]
    fn config_revocation_event_rules() {
        let c = AgentConfig {
            config_id: id(),
            name: "github".into(),
            enc_manifest: vec![1, 2, 3],
            created_at: ts(NOW),
        };
        assert!(check_agent_config(&c, NOW).is_ok());
        let mut c2 = c.clone();
        c2.name = String::new();
        assert!(check_agent_config(&c2, NOW).is_err());
        let mut c3 = c;
        c3.enc_manifest = vec![];
        assert!(check_agent_config(&c3, NOW).is_err());

        let r = TokenRevocation {
            token_id: id(),
            reason: "leaked".into(),
            revoked_at: ts(NOW),
        };
        assert!(check_revocation(&r, NOW).is_ok());

        let mut e = AccessEvent {
            token_id: id(),
            kind: AccessKind::Denied("expired".into()),
            provenance: agent(),
            bundle_version: None,
            at: ts(NOW),
        };
        assert!(check_access_event(&e, NOW).is_ok());
        e.kind = AccessKind::Denied(String::new());
        assert!(check_access_event(&e, NOW).is_err());
    }
}
