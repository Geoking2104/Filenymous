//! Sweettest (Holochain 0.6.1): unauthorized writes against the filenymous
//! integrity zomes are rejected, legitimate flows still work.
//!
//! Prerequisite: `make test-validation` (packs workdir/filenymous_validation_tests.dna:
//! the real zomes + two TEST-ONLY attacker coordinators).

use holochain::prelude::*;
use holochain::sweettest::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Payload mirrors (same field names / types as the zome crates) ─────────
#[derive(Serialize, Deserialize, Debug)]
struct ClaimContactInput {
    contact_hash: String,
}
#[derive(Serialize, Deserialize, Debug)]
struct PublishX25519KeyInput {
    x25519_pubkey_b64: String,
}
#[derive(Serialize, Deserialize, Debug)]
struct PlantInput {
    base: AgentPubKey,
    target: ActionHash,
}
#[derive(Serialize, Deserialize, Debug)]
struct UpdateClaimInput {
    original: ActionHash,
    contact_hash: String,
}
#[derive(Serialize, Deserialize, Debug)]
struct DownloadInput {
    parcel_eh: EntryHash,
    downloader: Option<AgentPubKey>,
}
#[derive(Serialize, Deserialize, Debug)]
struct LinkDownloadInput {
    parcel_eh: EntryHash,
    target: ActionHash,
}
#[derive(Serialize, Deserialize, Debug)]
struct CreateParcelInput {
    file_hash: EntryHash,
    file_name: String,
    file_size: u64,
    chunk_count: u32,
    recipient_contact_hash: String,
    encrypted_key_blob: String,
    expiry_us: i64,
    max_downloads: u32,
}
#[derive(Serialize, Deserialize, Debug)]
struct ParcelManifest {
    file_hash: EntryHash,
    file_name: String,
    file_size: u64,
    chunk_count: u32,
    sender: AgentPubKey,
    recipient_contact_hash: String,
    encrypted_key_blob: String,
    expiry_us: i64,
    max_downloads: u32,
    created_at: Timestamp,
}
#[derive(Serialize, Deserialize, Debug)]
struct ParcelOutput {
    parcel_eh: EntryHash,
    action_hash: ActionHash,
    manifest: ParcelManifest,
    download_count: u32,
    is_revoked: bool,
}

fn dna_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../workdir/filenymous_validation_tests.dna")
}

struct Ctx {
    conductor: SweetConductor,
    alice: SweetCell,
    bob: SweetCell,
}

async fn setup() -> Ctx {
    let dna = SweetDnaFile::from_bundle(&dna_path())
        .await
        .expect("run `make test-validation` first");
    let mut conductor = SweetConductor::from_standard_config().await;
    let apps = conductor.setup_apps("filenymous", 2, &[dna]).await.unwrap();
    let cells = apps.cells_flattened();
    let (alice, bob) = (cells[0].clone(), cells[1].clone());
    Ctx {
        conductor,
        alice,
        bob,
    }
}

impl Ctx {
    async fn ok<I, O>(&self, cell: &SweetCell, zome: &str, f: &str, payload: I) -> O
    where
        I: serde::Serialize + std::fmt::Debug,
        O: serde::de::DeserializeOwned + std::fmt::Debug,
    {
        self.conductor.call(&cell.zome(zome), f, payload).await
    }

    async fn try_<I, O>(
        &self,
        cell: &SweetCell,
        zome: &str,
        f: &str,
        payload: I,
    ) -> Result<O, String>
    where
        I: serde::Serialize + std::fmt::Debug,
        O: serde::de::DeserializeOwned + std::fmt::Debug,
    {
        self.conductor
            .call_fallible(&cell.zome(zome), f, payload)
            .await
            .map_err(|e| format!("{e:?}"))
    }

    async fn sync(&self) {
        await_consistency_s(30, [&self.alice, &self.bob])
            .await
            .unwrap();
    }
}

fn rejected<T: std::fmt::Debug>(r: Result<T, String>, what: &str) {
    match r {
        Ok(v) => panic!("{what}: expected a validation failure, got Ok({v:?})"),
        Err(e) => assert!(
            e.contains("Invalid") || e.contains("invalid"),
            "{what}: unexpected error {e}"
        ),
    }
}

const ALICE_CONTACT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB_CONTACT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[tokio::test(flavor = "multi_thread")]
async fn contact_claims_are_updated_and_deleted_only_by_their_author() {
    let ctx = setup().await;
    let claim: ActionHash = ctx
        .ok(
            &ctx.alice,
            "identity",
            "claim_contact",
            ClaimContactInput {
                contact_hash: ALICE_CONTACT.into(),
            },
        )
        .await;
    ctx.sync().await;

    rejected(
        ctx.try_::<_, ActionHash>(
            &ctx.bob,
            "attacker_identity",
            "delete_entry_of",
            claim.clone(),
        )
        .await,
        "delete another agent's claim",
    );
    rejected(
        ctx.try_::<_, ActionHash>(
            &ctx.bob,
            "attacker_identity",
            "update_claim",
            UpdateClaimInput {
                original: claim.clone(),
                contact_hash: BOB_CONTACT.into(),
            },
        )
        .await,
        "update another agent's claim",
    );

    // The author can still erase her own claim (RGPD).
    let _: ActionHash = ctx
        .ok(
            &ctx.alice,
            "identity",
            "revoke_contact_claim",
            ALICE_CONTACT.to_string(),
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn x25519_keys_cannot_be_planted_or_unlinked_by_others() {
    let ctx = setup().await;
    let alice_key = vec![1u8; 32];
    let b64 = |k: &[u8]| {
        // tiny base64 (std) for 32 bytes, avoids an extra dependency
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for c in k.chunks(3) {
            let n = (c[0] as u32) << 16
                | (*c.get(1).unwrap_or(&0) as u32) << 8
                | *c.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                if i <= c.len() {
                    out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    };
    let _: ActionHash = ctx
        .ok(
            &ctx.alice,
            "identity",
            "publish_x25519_key",
            PublishX25519KeyInput {
                x25519_pubkey_b64: b64(&alice_key),
            },
        )
        .await;
    let bob_key_ah: ActionHash = ctx
        .ok(
            &ctx.bob,
            "identity",
            "publish_x25519_key",
            PublishX25519KeyInput {
                x25519_pubkey_b64: b64(&[2u8; 32]),
            },
        )
        .await;
    ctx.sync().await;

    // Bob tries to make Alice's key lookup resolve to HIS key (key substitution).
    rejected(
        ctx.try_::<_, ActionHash>(
            &ctx.bob,
            "attacker_identity",
            "plant_x25519_link",
            PlantInput {
                base: ctx.alice.agent_pubkey().clone(),
                target: bob_key_ah,
            },
        )
        .await,
        "plant a key link on another agent",
    );
    // …or to unlink Alice's real key.
    let links: Vec<ActionHash> = ctx
        .ok(
            &ctx.bob,
            "attacker_identity",
            "x25519_links",
            ctx.alice.agent_pubkey().clone(),
        )
        .await;
    assert_eq!(links.len(), 1);
    rejected(
        ctx.try_::<_, ActionHash>(
            &ctx.bob,
            "attacker_identity",
            "delete_link_of",
            links[0].clone(),
        )
        .await,
        "delete another agent's key link",
    );

    let seen: Option<String> = ctx
        .ok(
            &ctx.bob,
            "identity",
            "get_x25519_key",
            ctx.alice.agent_pubkey().clone(),
        )
        .await;
    assert_eq!(seen, Some(b64(&alice_key)));
}

#[tokio::test(flavor = "multi_thread")]
async fn downloads_revocations_and_parcel_links_are_bound_to_their_author() {
    let ctx = setup().await;
    let parcel: ParcelOutput = ctx
        .ok(
            &ctx.alice,
            "parcel",
            "create_parcel",
            CreateParcelInput {
                file_hash: EntryHash::from_raw_32(vec![7; 32]),
                file_name: "report.pdf".into(),
                file_size: 1234,
                chunk_count: 1,
                recipient_contact_hash: BOB_CONTACT.into(),
                encrypted_key_blob: String::new(),
                expiry_us: 0,
                max_downloads: 2,
            },
        )
        .await;
    ctx.sync().await;
    let eh = parcel.parcel_eh.clone();

    // DownloadRecord: downloader must be the author (no impersonation, no anonymous records).
    rejected(
        ctx.try_::<_, ActionHash>(
            &ctx.bob,
            "attacker_parcel",
            "create_download_record",
            DownloadInput {
                parcel_eh: eh.clone(),
                downloader: Some(ctx.alice.agent_pubkey().clone()),
            },
        )
        .await,
        "download record in someone else's name",
    );
    rejected(
        ctx.try_::<_, ActionHash>(
            &ctx.bob,
            "attacker_parcel",
            "create_download_record",
            DownloadInput {
                parcel_eh: eh.clone(),
                downloader: None,
            },
        )
        .await,
        "anonymous download record",
    );
    // Quota exhaustion: linking the parcel to something that is not my download of it.
    rejected(
        ctx.try_::<_, ActionHash>(
            &ctx.bob,
            "attacker_parcel",
            "link_download",
            LinkDownloadInput {
                parcel_eh: eh.clone(),
                target: parcel.action_hash.clone(),
            },
        )
        .await,
        "fake download link",
    );
    // A real download still works.
    let _: ActionHash = ctx
        .ok(&ctx.bob, "parcel", "confirm_download", eh.clone())
        .await;

    // Only the sender can revoke; nobody else can delete the parcel or its links.
    rejected(
        ctx.try_::<_, ActionHash>(&ctx.bob, "attacker_parcel", "mark_revoked", eh.clone())
            .await,
        "revoke someone else's parcel",
    );
    rejected(
        ctx.try_::<_, ActionHash>(
            &ctx.bob,
            "attacker_parcel",
            "delete_entry_of",
            parcel.action_hash.clone(),
        )
        .await,
        "delete someone else's parcel",
    );
    let links: Vec<ActionHash> = ctx
        .ok(
            &ctx.bob,
            "attacker_parcel",
            "contact_links",
            BOB_CONTACT.to_string(),
        )
        .await;
    assert_eq!(links.len(), 1);
    rejected(
        ctx.try_::<_, ActionHash>(
            &ctx.bob,
            "attacker_parcel",
            "delete_link_of",
            links[0].clone(),
        )
        .await,
        "delete the sender's contact link",
    );

    ctx.sync().await;
    let p: Option<ParcelOutput> = ctx.ok(&ctx.bob, "parcel", "get_parcel", eh.clone()).await;
    let p = p.unwrap();
    assert!(!p.is_revoked);
    assert_eq!(p.download_count, 1);

    let _: ActionHash = ctx
        .ok(&ctx.alice, "parcel", "revoke_parcel", eh.clone())
        .await;
    ctx.sync().await;
    let p: Option<ParcelOutput> = ctx.ok(&ctx.alice, "parcel", "get_parcel", eh).await;
    assert!(p.unwrap().is_revoked);
}
