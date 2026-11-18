use lair_keystore_api::LairClient;

use crate::{
    app_state::filesystem::AppFileSystem,
    config::{
        AGENT_VAULT_APP_ID, APP_ID, BOOTSTRAP_SERVER, DEFAULT_NETWORK_SEED, RELAY_SERVER,
        SIGNALING_SERVER,
    },
    errors::AppResult,
    process::conductor::launch_holochain_process,
    setup::{self, InstallOutcome, NetworkUrls},
};

/// hApps embarqués dans le binaire de release (`make pouch` avant
/// `cargo tauri build`). En dev, lus depuis `pouch/` s'ils existent.
#[cfg(not(debug_assertions))]
fn bundled_happ(name: &str) -> Option<Vec<u8>> {
    match name {
        "filenymous.happ" => Some(
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../pouch/filenymous.happ"
            ))
            .to_vec(),
        ),
        "filenymous-agent-vault.happ" => Some(
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../pouch/filenymous-agent-vault.happ"
            ))
            .to_vec(),
        ),
        _ => None,
    }
}

#[cfg(debug_assertions)]
fn bundled_happ(name: &str) -> Option<Vec<u8>> {
    let path = std::env::var_os("FILENYMOUS_POUCH_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pouch"))
        .join(name);
    match std::fs::read(&path) {
        Ok(bytes) => {
            log::info!("Dev : hApp chargé depuis {}", path.display());
            Some(bytes)
        }
        Err(e) => {
            log::warn!(
                "Dev : {} absent ({e}) — installation ignorée",
                path.display()
            );
            None
        }
    }
}

fn network_urls() -> NetworkUrls {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    NetworkUrls {
        bootstrap: env("FILENYMOUS_BOOTSTRAP_URL", BOOTSTRAP_SERVER),
        signal: env("FILENYMOUS_SIGNAL_URL", SIGNALING_SERVER),
        relay: env("FILENYMOUS_RELAY_URL", RELAY_SERVER),
    }
}

/// Lance la stack Holochain d'un profil et installe les hApps manquants.
/// Retourne : (client lair pour signer les appels de zome, app_port, admin_port)
pub async fn launch(fs: &AppFileSystem, password: String) -> AppResult<(LairClient, u16, u16)> {
    std::fs::create_dir_all(fs.keystore_dir())?;
    std::fs::create_dir_all(fs.conductor_dir())?;

    // ── 1. Config du conductor (lair in-process, initialisé au 1er lancement)
    let admin_port = portpicker::pick_unused_port().ok_or_else(|| {
        crate::errors::LaunchHolochainError::CouldNotConnectToConductor("no free port".into())
    })?;
    let config = setup::conductor_config(
        &fs.conductor_dir(),
        &fs.keystore_dir(),
        admin_port,
        &network_urls(),
    );
    let config_path = fs.conductor_dir().join("conductor-config.yaml");
    setup::write_conductor_config(&config_path, &config)?;

    // ── 2. Sidecar holochain 0.6.1
    launch_holochain_process(&config_path, &password).await?;

    // ── 3. Admin + interface app non restreinte (hApp principal + Agent Vault)
    let admin = setup::connect_admin(admin_port, 20).await?;
    let app_port = setup::ensure_app_interface(&admin).await?;

    // ── 4. hApp principal (seed v3, cf. dnas/filenymous/dna.yaml)
    let network_seed = fs
        .read_profile_network_seed()
        .or_else(|| DEFAULT_NETWORK_SEED.map(String::from));
    let main = setup::install_app_if_missing(
        &admin,
        APP_ID,
        bundled_happ("filenymous.happ"),
        network_seed,
    )
    .await?;
    log::info!("{APP_ID} : {main:?}");

    // ── 5. Agent Vault, app installée à part, son propre seed (dna.yaml).
    // Non bloquant : sans elle, seul l'onglet « Agents » est indisponible.
    match setup::install_app_if_missing(
        &admin,
        AGENT_VAULT_APP_ID,
        bundled_happ("filenymous-agent-vault.happ"),
        None,
    )
    .await
    {
        Ok(o) => log::info!("{AGENT_VAULT_APP_ID} : {o:?}"),
        Err(e) => log::warn!("Agent Vault non installée : {e:?}"),
    }
    if main == InstallOutcome::NoBundle {
        log::warn!("hApp principal absent : lancez `make pouch` avant le build desktop");
    }

    // ── 6. Client lair (signature des appels de zome de la WebView)
    let lair = setup::connect_lair(&fs.keystore_dir(), &password).await?;

    Ok((lair, app_port, admin_port))
}
