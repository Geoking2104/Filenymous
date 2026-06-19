use std::{collections::HashMap, net::SocketAddr, time::Duration};

use holochain::{
    conductor::{
        api::{AdminInterfaceConfig, InterfaceDriver},
        config::{ConductorConfig, KeystoreConfig},
    },
    prelude::{
        dependencies::kitsune_p2p_types::config::{KitsuneP2pConfig, TransportConfig},
        AppBundle,
    },
};
use holochain_client::{AdminWebsocket, InstallAppPayload};
use holochain_keystore::MetaLairClient;
use holochain_types::websocket::AllowedOrigins;

use crate::{
    app_state::filesystem::AppFileSystem,
    config::{APP_ID, BOOTSTRAP_SERVER, DEFAULT_NETWORK_SEED, SIGNALING_SERVER},
    errors::{AppError, AppResult, LairKeystoreError, LaunchHolochainError},
    process::{
        conductor::launch_holochain_process,
        lair::{initialize_keystore, launch_lair_keystore_process},
    },
};

/// Lance l'ensemble de la stack Holochain pour un profil donné.
/// Retourne : (MetaLairClient, app_port, admin_port)
pub async fn launch(fs: &AppFileSystem, password: String) -> AppResult<(MetaLairClient, u16, u16)> {
    // Créer les répertoires si nécessaire
    std::fs::create_dir_all(fs.keystore_dir())?;
    std::fs::create_dir_all(fs.conductor_dir())?;

    // ── 1. Initialiser le keystore lair (première fois seulement) ────────────
    if !fs.keystore_initialized() {
        initialize_keystore(fs.keystore_dir(), password.clone()).await?;
    }

    // ── 2. Lancer lair-keystore et obtenir l'URL de connexion ─────────────────
    let lair_url = launch_lair_keystore_process(fs.keystore_dir(), password.clone()).await?;

    // ── 3. Connecter le MetaLairClient ────────────────────────────────────────
    let meta_lair_client =
        holochain_keystore::lair_keystore::spawn_lair_keystore(
            lair_url.clone(),
            password.as_bytes().into(),
        )
        .await
        .map_err(|e| LairKeystoreError::SpawnMetaLairClientError(format!("{}", e)))?;

    // ── 4. Écrire la config du conductor ─────────────────────────────────────
    let mut config = ConductorConfig::default();
    config.data_root_path = Some(fs.conductor_dir().into());
    config.keystore = KeystoreConfig::LairServer {
        connection_url: lair_url,
    };

    let admin_port = portpicker::pick_unused_port().expect("No unused port found");

    config.admin_interfaces = Some(vec![AdminInterfaceConfig {
        driver: InterfaceDriver::Websocket {
            port: admin_port,
            allowed_origins: AllowedOrigins::Any,
        },
    }]);

    let mut network_config = KitsuneP2pConfig::default();
    network_config.bootstrap_service = Some(url2::url2!("{}", BOOTSTRAP_SERVER));
    network_config.transport_pool.push(TransportConfig::WebRTC {
        signal_url: SIGNALING_SERVER.into(),
    });
    config.network = network_config;

    let config_string = serde_yaml::to_string(&config)
        .map_err(|e| LaunchHolochainError::FailedToWriteConductorConfig(format!("{}", e)))?;

    let conductor_config_path = fs.conductor_dir().join("conductor-config.yaml");
    std::fs::write(&conductor_config_path, config_string)?;

    // ── 5. Lancer le processus holochain ─────────────────────────────────────
    launch_holochain_process(conductor_config_path, password).await?;

    // Courte pause pour que l'admin interface soit prête
    tokio::time::sleep(Duration::from_millis(200)).await;

    // ── 6. Connecter l'AdminWebsocket avec retry ──────────────────────────────
    let mut admin_ws = connect_admin_ws_with_retry(admin_port, 5).await?;

    // ── 7. Ouvrir (ou récupérer) l'interface app ──────────────────────────────
    let app_port = {
        let interfaces = admin_ws.list_app_interfaces().await.map_err(|e| {
            LaunchHolochainError::CouldNotConnectToConductor(format!(
                "Cannot list app interfaces: {:?}",
                e
            ))
        })?;

        if !interfaces.is_empty() {
            interfaces[0].port
        } else {
            let free_port = portpicker::pick_unused_port().expect("No unused port found");
            admin_ws
                .attach_app_interface(free_port, AllowedOrigins::Any, Some(APP_ID.to_string()))
                .await
                .map_err(|_| {
                    LaunchHolochainError::CouldNotConnectToConductor(
                        "Cannot attach app interface".into(),
                    )
                })?;
            free_port
        }
    };

    // ── 8. Installer le hApp si ce n'est pas déjà fait ───────────────────────
    let network_seed = fs
        .read_profile_network_seed()
        .or_else(|| DEFAULT_NETWORK_SEED.map(String::from));

    install_app_if_necessary(network_seed, &mut admin_ws).await?;

    Ok((meta_lair_client, app_port, admin_port))
}

async fn install_app_if_necessary(
    network_seed: Option<String>,
    admin_ws: &mut AdminWebsocket,
) -> AppResult<()> {
    let apps = admin_ws
        .list_apps(None)
        .await
        .map_err(|e| AppError::ConductorApiError(e))?;

    let already_installed = apps
        .iter()
        .any(|info| info.installed_app_id == APP_ID);

    if !already_installed {
        let agent_key = admin_ws
            .generate_agent_pub_key()
            .await
            .map_err(|e| AppError::ConductorApiError(e))?;

        // En dev : charger le .happ depuis le chemin sur disque (pas encore compilé = skip).
        // En release : embarqué dans le binaire via include_bytes!.
        #[cfg(debug_assertions)]
        let happ_bytes: Option<Vec<u8>> = {
            let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../pouch/filenymous.happ");
            if path.exists() {
                match std::fs::read(&path) {
                    Ok(b) => {
                        log::info!("Dev: chargement du hApp depuis {:?}", path);
                        Some(b)
                    }
                    Err(e) => {
                        log::warn!("Dev: impossible de lire le hApp ({}) — install ignorée", e);
                        None
                    }
                }
            } else {
                log::warn!("Dev: pouch/filenymous.happ absent — install du hApp ignorée");
                None
            }
        };

        #[cfg(not(debug_assertions))]
        let happ_bytes: Option<Vec<u8>> =
            Some(include_bytes!("../pouch/filenymous.happ").to_vec());

        if let Some(bytes) = happ_bytes {
            let app_bundle = AppBundle::decode(&bytes)
                .map_err(|e| AppError::AppBundleError(e))?;

            admin_ws
                .install_app(InstallAppPayload {
                    source: holochain_types::prelude::AppBundleSource::Bundle(app_bundle),
                    agent_key,
                    network_seed,
                    installed_app_id: Some(APP_ID.to_string()),
                    membrane_proofs: HashMap::new(),
                })
                .await
                .map_err(|e| AppError::ConductorApiError(e))?;

            admin_ws
                .enable_app(APP_ID.to_string())
                .await
                .map_err(|e| AppError::ConductorApiError(e))?;
        }
    }

    Ok(())
}

async fn connect_admin_ws_with_retry(
    port: u16,
    max_retries: u32,
) -> AppResult<AdminWebsocket> {
    let mut attempts = 0;
    loop {
        match AdminWebsocket::connect(SocketAddr::from(([127, 0, 0, 1], port))).await {
            Ok(ws) => return Ok(ws),
            Err(_) if attempts < max_retries => {
                attempts += 1;
                log::warn!(
                    "Cannot connect to admin WebSocket (attempt {}/{}), retrying in 5s…",
                    attempts,
                    max_retries
                );
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            Err(e) => {
                return Err(LaunchHolochainError::CouldNotConnectToConductor(
                    format!("{}", e),
                )
                .into());
            }
        }
    }
}
