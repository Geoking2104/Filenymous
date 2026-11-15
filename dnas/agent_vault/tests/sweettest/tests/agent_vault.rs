//! Sweettest (Holochain 0.6.1) integration tests for the agent_vault DNA.
//!
//! Prerequisite: `make build-agent-vault-dna` (writes workdir/agent_vault.dna).
//! Run: `cd dnas/agent_vault/tests/sweettest && cargo test --release`.

use agent_vault::{
    AuditEntry, AuditFilter, CreateConfigInput, FetchInput, FetchResult, IssueTokenInput, IssuedToken,
    RevokeInput, RotateInput, SealedBundleInput, TokenStatus,
};
use agent_vault_integrity::{AccessKind, ALG_X25519_HKDF_AESGCM};
use holochain::prelude::*;
use holochain::sweettest::*;
use std::path::PathBuf;

const ZOME: &str = "agent_vault";

fn dna_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../workdir/agent_vault.dna")
}

fn id(c: char) -> String {
    std::iter::repeat_n(c, 22).collect()
}

fn sealed(tag: u8) -> SealedBundleInput {
    SealedBundleInput {
        alg: ALG_X25519_HKDF_AESGCM.into(),
        eph_pub: vec![tag; 32],
        nonce: vec![0; 12],
        ciphertext: vec![tag; 48],
    }
}

struct Ctx {
    conductor: SweetConductor,
    cell: SweetCell,
    agent: AgentPubKey,
}

async fn setup() -> Ctx {
    let dna = SweetDnaFile::from_bundle(&dna_path())
        .await
        .expect("run `make build-agent-vault-dna` first");
    let mut conductor = SweetConductor::from_standard_config().await;
    let app = conductor.setup_app("agent_vault", &[dna]).await.unwrap();
    let (cell,) = app.into_tuple();
    // The AI agent's zome-call signing key (lives in the same test keystore so
    // the conductor can sign calls with it as provenance).
    let agent = conductor.keystore().new_sign_keypair_random().await.unwrap();
    Ctx { conductor, cell, agent }
}

impl Ctx {
    async fn owner<I: serde::Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(
        &self,
        f: &str,
        payload: I,
    ) -> O {
        self.conductor.call(&self.cell.zome(ZOME), f, payload).await
    }

    async fn as_agent<I: serde::Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(
        &self,
        secret: CapSecret,
        f: &str,
        payload: I,
    ) -> Result<O, String> {
        self.conductor
            .call_from_fallible(&self.agent, Some(secret), &self.cell.zome(ZOME), f, payload)
            .await
            .map_err(|e| format!("{e:?}"))
    }

    async fn issue(&self, token_id: &str, ttl_seconds: u64, max_uses: u32) -> IssuedToken {
        self.owner(
            "issue_agent_token",
            IssueTokenInput {
                token_id: token_id.into(),
                config_id: id('C'),
                label: "claude-ci".into(),
                agent_key: self.agent.clone(),
                agent_x25519: vec![5; 32],
                sealed: sealed(1),
                ttl_seconds,
                max_uses,
            },
        )
        .await
    }

    async fn config(&self) {
        let _: ActionHash = self
            .owner(
                "create_agent_config",
                CreateConfigInput {
                    config_id: id('C'),
                    name: "github-ci".into(),
                    enc_manifest: vec![1, 2, 3],
                },
            )
            .await;
    }

    async fn audit(&self, token_id: &str) -> Vec<AuditEntry> {
        self.owner(
            "list_access_events",
            AuditFilter {
                token_id: Some(token_id.into()),
                ..Default::default()
            },
        )
        .await
    }
}

fn fetch(token_id: &str) -> FetchInput {
    FetchInput {
        token_id: token_id.into(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn issue_fetch_quota_and_audit() {
    let ctx = setup().await;
    ctx.config().await;
    let t = id('T');
    let issued = ctx.issue(&t, 3600, 2).await;
    assert_eq!(issued.cell_id, ctx.cell.cell_id().clone());

    // 1st and 2nd fetch granted, 3rd denied by quota.
    for _ in 0..2 {
        let r: FetchResult = ctx.as_agent(issued.cap_secret, "fetch_bundle", fetch(&t)).await.unwrap();
        match r {
            FetchResult::Granted { bundle, .. } => {
                assert_eq!(bundle.version, 1);
                assert_eq!(bundle.ciphertext, vec![1; 48]);
            }
            other => panic!("expected granted, got {other:?}"),
        }
    }
    let r: FetchResult = ctx.as_agent(issued.cap_secret, "fetch_bundle", fetch(&t)).await.unwrap();
    assert!(matches!(r, FetchResult::Denied { ref reason } if reason == "quota_exhausted"), "{r:?}");

    let status: TokenStatus = ctx.as_agent(issued.cap_secret, "token_status", fetch(&t)).await.unwrap();
    assert_eq!(status.uses, 2);
    assert!(!status.revoked);

    // Audit: Issued, Fetch, Fetch, Denied (newest first) — denials ARE recorded.
    let kinds: Vec<AccessKind> = ctx.audit(&t).await.into_iter().map(|e| e.event.kind).collect();
    assert_eq!(
        kinds,
        vec![
            AccessKind::Denied("quota_exhausted".into()),
            AccessKind::Fetch,
            AccessKind::Fetch,
            AccessKind::Issued
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_is_read_only_and_bound_to_its_token() {
    let ctx = setup().await;
    ctx.config().await;
    let a = ctx.issue(&id('A'), 3600, 0).await;
    let _b = ctx.issue(&id('B'), 3600, 0).await;

    // Owner-only functions are not in the grant: conductor refuses.
    let r: Result<(), String> = ctx
        .as_agent(
            a.cap_secret,
            "revoke_agent_token",
            RevokeInput {
                token_id: id('A'),
                reason: "self".into(),
            },
        )
        .await;
    assert!(r.is_err(), "agent must not call owner functions");
    let r: Result<Vec<TokenStatus>, String> = ctx.as_agent(a.cap_secret, "list_agent_tokens", ()).await;
    assert!(r.is_err());

    // Token A's secret cannot read token B's bundle (grant tag mismatch, audited).
    let r: FetchResult = ctx.as_agent(a.cap_secret, "fetch_bundle", fetch(&id('B'))).await.unwrap();
    assert!(matches!(r, FetchResult::Denied { ref reason } if reason == "grant_mismatch"), "{r:?}");

    // Wrong secret: conductor-level rejection.
    let bad = CapSecret::from([7u8; 64]);
    let r: Result<FetchResult, String> = ctx.as_agent(bad, "fetch_bundle", fetch(&id('A'))).await;
    assert!(r.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn revoke_and_rotate() {
    let ctx = setup().await;
    ctx.config().await;
    let t = id('R');
    let issued = ctx.issue(&t, 3600, 0).await;

    let v: u32 = ctx
        .owner(
            "rotate_bundle",
            RotateInput {
                token_id: t.clone(),
                sealed: sealed(2),
            },
        )
        .await;
    assert_eq!(v, 2);
    let r: FetchResult = ctx.as_agent(issued.cap_secret, "fetch_bundle", fetch(&t)).await.unwrap();
    assert!(matches!(r, FetchResult::Granted { ref bundle, .. } if bundle.version == 2 && bundle.ciphertext == vec![2; 48]));

    let _: () = ctx
        .owner(
            "revoke_agent_token",
            RevokeInput {
                token_id: t.clone(),
                reason: "rotation".into(),
            },
        )
        .await;
    // Grant deleted → the conductor rejects the call before the zome runs.
    let r: Result<FetchResult, String> = ctx.as_agent(issued.cap_secret, "fetch_bundle", fetch(&t)).await;
    assert!(r.is_err(), "revoked token must not fetch: {r:?}");

    let tokens: Vec<TokenStatus> = ctx.owner("list_agent_tokens", ()).await;
    assert!(tokens.iter().any(|s| s.token_id == t && s.revoked));
    let kinds: Vec<AccessKind> = ctx.audit(&t).await.into_iter().map(|e| e.event.kind).collect();
    assert_eq!(kinds[0], AccessKind::Revoked);
    assert!(kinds.contains(&AccessKind::Rotated));
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_bad_ttl_unknown_config_and_author_as_agent() {
    let ctx = setup().await;
    ctx.config().await;
    let issue = |token: String, ttl: u64, agent_key: AgentPubKey, config_id: String| IssueTokenInput {
        token_id: token,
        config_id,
        label: String::new(),
        agent_key,
        agent_x25519: vec![5; 32],
        sealed: sealed(1),
        ttl_seconds: ttl,
        max_uses: 0,
    };
    let z = ctx.cell.zome(ZOME);
    let too_long: Result<IssuedToken, _> = ctx
        .conductor
        .call_fallible(&z, "issue_agent_token", issue(id('X'), 31 * 24 * 3600, ctx.agent.clone(), id('C')))
        .await;
    assert!(too_long.is_err());
    let unknown_cfg: Result<IssuedToken, _> = ctx
        .conductor
        .call_fallible(&z, "issue_agent_token", issue(id('Y'), 3600, ctx.agent.clone(), id('Q')))
        .await;
    assert!(unknown_cfg.is_err());
    // Validation: a token can never be assigned to the chain author.
    let author_key: Result<IssuedToken, _> = ctx
        .conductor
        .call_fallible(&z, "issue_agent_token", issue(id('Z'), 3600, ctx.cell.agent_pubkey().clone(), id('C')))
        .await;
    assert!(author_key.is_err());
}
