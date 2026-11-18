//! Démarrage Holochain indépendant de Tauri : config du conductor, connexion
//! admin, interface app, installation des hApps au premier lancement, accès
//! lair et signature des appels de zome.
//!
//! Tout ce qui est ici est testé contre un vrai conductor 0.6.1 (voir
//! `tests` en bas de fichier, `HOLOCHAIN_BIN=… cargo test`).

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use holochain_client::{
    AdminWebsocket, AllowedOrigins, AppInfo, InstallAppPayload, IssueAppAuthenticationTokenPayload,
};
use holochain_conductor_api::{
    conductor::{ConductorConfig, KeystoreConfig, NetworkConfig},
    AdminInterfaceConfig, InterfaceDriver,
};
use holochain_types::app::AppBundleSource;
use holochain_zome_types::prelude::*;
use lair_keystore_api::{ipc_keystore::ipc_keystore_connect, LairClient};
use serde::{Deserialize, Serialize};

use crate::errors::{AppResult, LairKeystoreError, LaunchHolochainError};

/// Fichier de config écrit par lair (in-process) dans son `lair_root`.
pub const LAIR_CONFIG_FILE: &str = "lair-keystore-config.yaml";

/// URLs réseau kitsune2 du conductor.
#[derive(Clone, Debug)]
pub struct NetworkUrls {
    pub bootstrap: String,
    pub signal: String,
    pub relay: String,
}

/// Config du conductor desktop : lair **in-process** (pas de sidecar lair),
/// une interface admin locale, réseau kitsune2.
pub fn conductor_config(
    data_root: &Path,
    lair_root: &Path,
    admin_port: u16,
    network: &NetworkUrls,
) -> ConductorConfig {
    let mut config = ConductorConfig::default();
    config.data_root_path = Some(data_root.to_path_buf().into());
    config.keystore = KeystoreConfig::LairServerInProc {
        lair_root: Some(lair_root.to_path_buf().into()),
    };
    config.admin_interfaces = Some(vec![AdminInterfaceConfig {
        driver: InterfaceDriver::Websocket {
            port: admin_port,
            danger_bind_addr: None,
            allowed_origins: AllowedOrigins::Any,
        },
    }]);
    let mut net = NetworkConfig::default();
    net.bootstrap_url = url2::url2!("{}", network.bootstrap);
    net.signal_url = url2::url2!("{}", network.signal);
    net.relay_url = url2::url2!("{}", network.relay);
    config.network = net;
    config
}

pub fn write_conductor_config(path: &Path, config: &ConductorConfig) -> AppResult<()> {
    let yaml = serde_yaml::to_string(config)
        .map_err(|e| LaunchHolochainError::FailedToWriteConductorConfig(e.to_string()))?;
    std::fs::write(path, yaml)?;
    Ok(())
}

/// Connexion admin avec retries (le conductor peut mettre quelques secondes).
pub async fn connect_admin(port: u16, attempts: u32) -> AppResult<AdminWebsocket> {
    let mut last = String::new();
    for i in 0..attempts.max(1) {
        match AdminWebsocket::connect(SocketAddr::from(([127, 0, 0, 1], port)), None).await {
            Ok(ws) => return Ok(ws),
            Err(e) => {
                last = format!("{e:?}");
                log::warn!("admin ws {port} pas prêt ({}/{attempts}) : {last}", i + 1);
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    Err(LaunchHolochainError::CouldNotConnectToConductor(last).into())
}

/// Port d'une interface app non restreinte à une app (elle sert le hApp
/// principal ET l'Agent Vault ; l'accès est contrôlé par les tokens émis par
/// app). En crée une si nécessaire.
pub async fn ensure_app_interface(admin: &AdminWebsocket) -> AppResult<u16> {
    let interfaces = admin.list_app_interfaces().await?;
    if let Some(open) = interfaces.iter().find(|i| i.installed_app_id.is_none()) {
        return Ok(open.port);
    }
    Ok(admin
        .attach_app_interface(0, None, AllowedOrigins::Any, None)
        .await?)
}

/// Résultat de [`install_app_if_missing`].
#[derive(Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    AlreadyInstalled,
    Installed,
    /// Pas de bundle disponible (build de dev sans `make pouch`).
    NoBundle,
}

/// Installe et active `app_id` si elle est absente. `network_seed` = None :
/// le seed du dna.yaml s'applique.
pub async fn install_app_if_missing(
    admin: &AdminWebsocket,
    app_id: &str,
    happ: Option<Vec<u8>>,
    network_seed: Option<String>,
) -> AppResult<InstallOutcome> {
    let apps = admin.list_apps(None).await?;
    if apps.iter().any(|a| a.installed_app_id == app_id) {
        return Ok(InstallOutcome::AlreadyInstalled);
    }
    let Some(bytes) = happ else {
        return Ok(InstallOutcome::NoBundle);
    };
    admin
        .install_app(InstallAppPayload {
            source: AppBundleSource::Bytes(bytes.into()),
            agent_key: None,
            installed_app_id: Some(app_id.to_string()),
            network_seed,
            roles_settings: None,
            ignore_genesis_failure: false,
        })
        .await?;
    admin.enable_app(app_id.to_string()).await?;
    Ok(InstallOutcome::Installed)
}

pub async fn issue_app_token(admin: &AdminWebsocket, app_id: &str) -> AppResult<Vec<u8>> {
    let issued = admin
        .issue_app_auth_token(IssueAppAuthenticationTokenPayload {
            installed_app_id: app_id.to_string(),
            expiry_seconds: 0,
            single_use: false,
        })
        .await?;
    Ok(issued.token)
}

#[cfg_attr(not(test), allow(dead_code))]
pub async fn find_app(admin: &AdminWebsocket, app_id: &str) -> AppResult<Option<AppInfo>> {
    Ok(admin
        .list_apps(None)
        .await?
        .into_iter()
        .find(|a| a.installed_app_id == app_id))
}

/// Passphrase lair sous la forme attendue par lair_keystore_api.
pub fn shared_passphrase(passphrase: &str) -> lair_keystore_api::types::SharedLockedArray {
    Arc::new(Mutex::new(sodoken::LockedArray::from(
        passphrase.as_bytes().to_vec(),
    )))
}

/// URL de connexion du lair in-process (écrite par holochain au démarrage).
pub fn lair_connection_url(lair_root: &Path) -> AppResult<url::Url> {
    let path: PathBuf = lair_root.join(LAIR_CONFIG_FILE);
    let content = std::fs::read_to_string(&path)
        .map_err(|e| LairKeystoreError::ConfigNotFound(format!("{}: {e}", path.display())))?;
    let line = content
        .lines()
        .find_map(|l| l.trim().strip_prefix("connectionUrl:"))
        .ok_or_else(|| LairKeystoreError::ConfigNotFound(path.display().to_string()))?;
    url::Url::parse(line.trim().trim_matches('"'))
        .map_err(|e| LairKeystoreError::ConnectError(e.to_string()).into())
}

pub async fn connect_lair(lair_root: &Path, passphrase: &str) -> AppResult<LairClient> {
    let url = lair_connection_url(lair_root)?;
    ipc_keystore_connect(url, shared_passphrase(passphrase))
        .await
        .map_err(|e| LairKeystoreError::ConnectError(e.to_string()).into())
}

/// Appel de zome non signé envoyé par la WebView (octets bruts, payload déjà
/// encodé en msgpack par @holochain/client).
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ZomeCallUnsignedTauri {
    pub provenance: Vec<u8>,
    pub cell_id_dna: Vec<u8>,
    pub cell_id_agent: Vec<u8>,
    pub zome_name: String,
    pub fn_name: String,
    pub cap_secret: Option<Vec<u8>>,
    pub payload: Vec<u8>,
}

/// Réponse : `CallZomeRequestSigned` de @holochain/client (bytes + signature).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ZomeCallSignedTauri {
    pub bytes: Vec<u8>,
    pub signature: Vec<u8>,
}

/// Construit les `ZomeCallParams` 0.6 (nonce + expiration 5 min) et les signe
/// avec la clé de l'agent dans lair : signature ed25519 du sha512 des octets
/// msgpack, comme `ZomeCallParams::serialize_and_hash`.
pub async fn sign_zome_call(
    lair: &LairClient,
    unsigned: ZomeCallUnsignedTauri,
) -> AppResult<ZomeCallSignedTauri> {
    let err = |e: String| crate::errors::AppError::SignZomeCallError(e);
    let provenance =
        AgentPubKey::try_from_raw_39(unsigned.provenance).map_err(|e| err(e.to_string()))?;
    let dna = DnaHash::try_from_raw_39(unsigned.cell_id_dna).map_err(|e| err(e.to_string()))?;
    let agent =
        AgentPubKey::try_from_raw_39(unsigned.cell_id_agent).map_err(|e| err(e.to_string()))?;
    let cap_secret = match unsigned.cap_secret {
        Some(s) => {
            Some(CapSecret::try_from(s).map_err(|_| err("cap_secret must be 64 bytes".into()))?)
        }
        None => None,
    };
    let mut nonce = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let expires_at =
        (Timestamp::now() + Duration::from_secs(5 * 60)).map_err(|e| err(e.to_string()))?;
    let params = ZomeCallParams {
        provenance: provenance.clone(),
        cell_id: CellId::new(dna, agent),
        zome_name: unsigned.zome_name.into(),
        fn_name: unsigned.fn_name.into(),
        cap_secret,
        payload: ExternIO(unsigned.payload),
        nonce: nonce.into(),
        expires_at,
    };
    let (bytes, hash) = params
        .serialize_and_hash()
        .map_err(|e| err(e.to_string()))?;
    let pub_key: [u8; 32] = provenance
        .get_raw_32()
        .try_into()
        .map_err(|_| err("bad agent key".into()))?;
    let signature = lair
        .sign_by_pub_key(pub_key.into(), None, hash.into())
        .await
        .map_err(|e| err(e.to_string()))?;
    Ok(ZomeCallSignedTauri {
        bytes,
        signature: signature.0.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    //! Démarrage desktop contre un VRAI conductor Holochain 0.6.1, sans Tauri.
    //!
    //! `HOLOCHAIN_BIN=/chemin/holochain FILENYMOUS_POUCH_DIR=…/pouch cargo test`
    //! (pouch = `make pouch` ou workdir/). Ignoré si les variables manquent.
    use super::*;
    use holochain_client::{AppWebsocket, CellInfo, LairAgentSigner};
    use holochain_conductor_api::ZomeCallParamsSigned;
    use holochain_zome_types::prelude::{ActionHash, ExternIO, Signature};
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    const PASS: &str = "test-passphrase";

    fn env_or_skip() -> Option<(PathBuf, PathBuf)> {
        let bin = std::env::var_os("HOLOCHAIN_BIN")?;
        let pouch = std::env::var_os("FILENYMOUS_POUCH_DIR")?;
        Some((bin.into(), pouch.into()))
    }

    async fn start_conductor(bin: &Path, dir: &Path, admin_port: u16) -> tokio::process::Child {
        let cfg = conductor_config(
            &dir.join("conductor"),
            &dir.join("keystore"),
            admin_port,
            &NetworkUrls {
                bootstrap: crate::config::BOOTSTRAP_SERVER.into(),
                signal: crate::config::SIGNALING_SERVER.into(),
                relay: crate::config::RELAY_SERVER.into(),
            },
        );
        std::fs::create_dir_all(dir.join("conductor")).unwrap();
        let path = dir.join("conductor-config.yaml");
        write_conductor_config(&path, &cfg).unwrap();
        let mut child = tokio::process::Command::new(bin)
            .args(["--config-path", path.to_str().unwrap(), "--piped"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn holochain");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(format!("{PASS}\n").as_bytes())
            .await
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        tokio::time::timeout(Duration::from_secs(60), async {
            while let Some(l) = lines.next_line().await.unwrap() {
                if l.contains("Conductor ready") {
                    return;
                }
            }
            panic!("holochain exited before ready");
        })
        .await
        .expect("conductor ready");
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        child
    }

    fn provisioned(info: &AppInfo, role: &str) -> (CellId, String) {
        match &info.cell_info[role][0] {
            CellInfo::Provisioned(c) => (c.cell_id.clone(), c.dna_modifiers.network_seed.clone()),
            other => panic!("unexpected cell {other:?}"),
        }
    }

    async fn signed_call<I: serde::Serialize + std::fmt::Debug>(
        app: &AppWebsocket,
        lair: &LairClient,
        cell: &CellId,
        zome: &str,
        f: &str,
        payload: I,
    ) -> Result<ExternIO, String> {
        let unsigned = ZomeCallUnsignedTauri {
            provenance: cell.agent_pubkey().get_raw_39().to_vec(),
            cell_id_dna: cell.dna_hash().get_raw_39().to_vec(),
            cell_id_agent: cell.agent_pubkey().get_raw_39().to_vec(),
            zome_name: zome.into(),
            fn_name: f.into(),
            cap_secret: None,
            payload: ExternIO::encode(payload).unwrap().0,
        };
        let signed = sign_zome_call(lair, unsigned)
            .await
            .map_err(|e| e.to_string())?;
        let sig: [u8; 64] = signed.signature.try_into().unwrap();
        app.signed_call_zome(ZomeCallParamsSigned {
            bytes: ExternIO(signed.bytes),
            signature: Signature(sig),
        })
        .await
        .map_err(|e| format!("{e:?}"))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn first_launch_installs_both_apps_and_signs_zome_calls() {
        let Some((bin, pouch)) = env_or_skip() else {
            eprintln!("HOLOCHAIN_BIN / FILENYMOUS_POUCH_DIR non définis : test ignoré");
            return;
        };
        let main_happ = std::fs::read(pouch.join("filenymous.happ")).expect("filenymous.happ");
        let vault_happ = std::fs::read(pouch.join("filenymous-agent-vault.happ"))
            .expect("filenymous-agent-vault.happ");
        let dir = std::env::temp_dir().join(format!("fny-desktop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let admin_port = portpicker::pick_unused_port().unwrap();
        let mut child = start_conductor(&bin, &dir, admin_port).await;

        let admin = connect_admin(admin_port, 20).await.unwrap();
        let app_port = ensure_app_interface(&admin).await.unwrap();
        assert_eq!(
            ensure_app_interface(&admin).await.unwrap(),
            app_port,
            "interface réutilisée"
        );

        // Premier lancement : les deux apps sont installées et activées.
        let seed = crate::config::DEFAULT_NETWORK_SEED.map(String::from);
        assert_eq!(
            install_app_if_missing(
                &admin,
                crate::config::APP_ID,
                Some(main_happ.clone()),
                seed.clone()
            )
            .await
            .unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(
            install_app_if_missing(
                &admin,
                crate::config::AGENT_VAULT_APP_ID,
                Some(vault_happ.clone()),
                None
            )
            .await
            .unwrap(),
            InstallOutcome::Installed
        );
        // Lancement suivant : rien à faire.
        assert_eq!(
            install_app_if_missing(&admin, crate::config::APP_ID, Some(main_happ), seed)
                .await
                .unwrap(),
            InstallOutcome::AlreadyInstalled
        );
        assert_eq!(
            install_app_if_missing(
                &admin,
                crate::config::AGENT_VAULT_APP_ID,
                Some(vault_happ),
                None
            )
            .await
            .unwrap(),
            InstallOutcome::AlreadyInstalled
        );

        let main = find_app(&admin, crate::config::APP_ID)
            .await
            .unwrap()
            .unwrap();
        let vault = find_app(&admin, crate::config::AGENT_VAULT_APP_ID)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(main.status, holochain_types::app::AppStatus::Enabled),
            "{:?}",
            main.status
        );
        assert!(
            matches!(vault.status, holochain_types::app::AppStatus::Enabled),
            "{:?}",
            vault.status
        );
        let (main_cell, main_seed) = provisioned(&main, "filenymous");
        let (vault_cell, vault_seed) = provisioned(&vault, "agent_vault");
        assert_eq!(main_seed, "filenymous-mainnet-v3");
        assert_eq!(vault_seed, "filenymous-agent-vault-v1");

        // Signature des appels de zome via le lair in-process (comme la commande Tauri).
        let lair = connect_lair(&dir.join("keystore"), PASS).await.unwrap();
        let token = issue_app_token(&admin, crate::config::APP_ID)
            .await
            .unwrap();
        let app = AppWebsocket::connect(
            ("127.0.0.1", app_port),
            token,
            Arc::new(LairAgentSigner::new(Arc::new(lair.clone()))),
            None,
        )
        .await
        .unwrap();

        #[derive(serde::Serialize, Debug)]
        struct Claim {
            contact_hash: String,
        }
        let h = "a".repeat(64);
        let out = signed_call(
            &app,
            &lair,
            &main_cell,
            "identity",
            "claim_contact",
            Claim {
                contact_hash: h.clone(),
            },
        )
        .await
        .expect("claim_contact");
        let _: ActionHash = out.decode().unwrap();
        let who: Option<AgentPubKey> = signed_call(
            &app,
            &lair,
            &main_cell,
            "identity",
            "get_agent_for_contact",
            h,
        )
        .await
        .unwrap()
        .decode()
        .unwrap();
        assert_eq!(who.as_ref(), Some(main_cell.agent_pubkey()));

        // Agent Vault : même conductor, même interface, son propre token.
        let vtoken = issue_app_token(&admin, crate::config::AGENT_VAULT_APP_ID)
            .await
            .unwrap();
        let vapp = AppWebsocket::connect(
            ("127.0.0.1", app_port),
            vtoken,
            Arc::new(LairAgentSigner::new(Arc::new(lair.clone()))),
            None,
        )
        .await
        .unwrap();
        let configs: Vec<serde::de::IgnoredAny> = signed_call(
            &vapp,
            &lair,
            &vault_cell,
            "agent_vault",
            "list_agent_configs",
            (),
        )
        .await
        .expect("list_agent_configs")
        .decode()
        .unwrap();
        assert!(configs.is_empty());

        // Une signature falsifiée est refusée par le conductor.
        let mut forged = sign_zome_call(
            &lair,
            ZomeCallUnsignedTauri {
                provenance: main_cell.agent_pubkey().get_raw_39().to_vec(),
                cell_id_dna: main_cell.dna_hash().get_raw_39().to_vec(),
                cell_id_agent: main_cell.agent_pubkey().get_raw_39().to_vec(),
                zome_name: "identity".into(),
                fn_name: "get_agent_for_contact".into(),
                cap_secret: None,
                payload: ExternIO::encode("b".repeat(64)).unwrap().0,
            },
        )
        .await
        .unwrap();
        forged.signature[0] ^= 0xff;
        let sig: [u8; 64] = forged.signature.try_into().unwrap();
        assert!(app
            .signed_call_zome(ZomeCallParamsSigned {
                bytes: ExternIO(forged.bytes),
                signature: Signature(sig)
            })
            .await
            .is_err());

        child.kill().await.ok();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
