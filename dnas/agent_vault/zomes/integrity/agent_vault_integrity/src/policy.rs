//! Fetch authorisation policy (pure). The conductor has already checked that
//! the caller holds a live capability grant assigned to its key for
//! `fetch_bundle`; Holochain grants have **no expiry**, so TTL, use count and
//! revocation are enforced here.

use crate::{grant_tag, AgentToken};
use hdi::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DenyReason {
    /// Called as chain author or with a grant that is not this token's grant.
    GrantMismatch,
    /// Caller key is not the token's assignee.
    WrongAgent,
    UnknownToken,
    Expired,
    Revoked,
    QuotaExhausted,
    NoBundle,
}

impl DenyReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            DenyReason::GrantMismatch => "grant_mismatch",
            DenyReason::WrongAgent => "wrong_agent",
            DenyReason::UnknownToken => "unknown_token",
            DenyReason::Expired => "expired",
            DenyReason::Revoked => "revoked",
            DenyReason::QuotaExhausted => "quota_exhausted",
            DenyReason::NoBundle => "no_bundle",
        }
    }
}

pub struct FetchContext<'a> {
    pub token_id: &'a str,
    /// Tag of the grant used for this call; `None` when called as chain author.
    pub grant_tag: Option<&'a str>,
    pub provenance: &'a AgentPubKey,
    pub token: Option<&'a AgentToken>,
    pub now: Timestamp,
    pub revoked: bool,
    /// Successful fetches already recorded for this token.
    pub uses: u32,
}

pub fn evaluate_fetch(ctx: &FetchContext) -> Result<(), DenyReason> {
    let expected = grant_tag(ctx.token_id);
    if ctx.grant_tag != Some(expected.as_str()) {
        return Err(DenyReason::GrantMismatch);
    }
    let token = ctx.token.ok_or(DenyReason::UnknownToken)?;
    if &token.agent_key != ctx.provenance {
        return Err(DenyReason::WrongAgent);
    }
    if ctx.revoked {
        return Err(DenyReason::Revoked);
    }
    if ctx.now >= token.expires_at {
        return Err(DenyReason::Expired);
    }
    if token.max_uses > 0 && ctx.uses >= token.max_uses {
        return Err(DenyReason::QuotaExhausted);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000_000;
    fn agent() -> AgentPubKey {
        AgentPubKey::from_raw_36(vec![2; 36])
    }
    fn token(max_uses: u32) -> AgentToken {
        AgentToken {
            token_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
            config_id: "BBBBBBBBBBBBBBBBBBBBBB".into(),
            label: String::new(),
            agent_key: agent(),
            agent_x25519: vec![7; 32],
            grant_action_hash: ActionHash::from_raw_36(vec![3; 36]),
            issued_at: Timestamp::from_micros(NOW),
            expires_at: Timestamp::from_micros(NOW + 3_600_000_000),
            max_uses,
        }
    }

    fn eval(
        t: Option<&AgentToken>,
        tag: Option<&str>,
        who: &AgentPubKey,
        now: i64,
        revoked: bool,
        uses: u32,
    ) -> Result<(), DenyReason> {
        evaluate_fetch(&FetchContext {
            token_id: "AAAAAAAAAAAAAAAAAAAAAA",
            grant_tag: tag,
            provenance: who,
            token: t,
            now: Timestamp::from_micros(now),
            revoked,
            uses,
        })
    }

    #[test]
    fn allows_valid_fetch() {
        let t = token(0);
        let tag = grant_tag(&t.token_id);
        assert_eq!(
            eval(Some(&t), Some(&tag), &agent(), NOW + 1, false, 99),
            Ok(())
        );
    }

    #[test]
    fn denials() {
        let t = token(2);
        let tag = grant_tag(&t.token_id);
        let other = AgentPubKey::from_raw_36(vec![9; 36]);
        assert_eq!(
            eval(Some(&t), None, &agent(), NOW, false, 0),
            Err(DenyReason::GrantMismatch)
        );
        assert_eq!(
            eval(
                Some(&t),
                Some("fny-agent:other-token-xxxxx"),
                &agent(),
                NOW,
                false,
                0
            ),
            Err(DenyReason::GrantMismatch)
        );
        assert_eq!(
            eval(None, Some(&tag), &agent(), NOW, false, 0),
            Err(DenyReason::UnknownToken)
        );
        assert_eq!(
            eval(Some(&t), Some(&tag), &other, NOW, false, 0),
            Err(DenyReason::WrongAgent)
        );
        assert_eq!(
            eval(Some(&t), Some(&tag), &agent(), NOW, true, 0),
            Err(DenyReason::Revoked)
        );
        assert_eq!(
            eval(
                Some(&t),
                Some(&tag),
                &agent(),
                NOW + 3_600_000_000,
                false,
                0
            ),
            Err(DenyReason::Expired)
        );
        assert_eq!(
            eval(Some(&t), Some(&tag), &agent(), NOW, false, 2),
            Err(DenyReason::QuotaExhausted)
        );
        assert_eq!(eval(Some(&t), Some(&tag), &agent(), NOW, false, 1), Ok(()));
    }
}
