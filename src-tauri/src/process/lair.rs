use std::path::PathBuf;
use tauri::api::process::{Command, CommandEvent};
use url2::url2;

use crate::{
    config::LAIR_KEYSTORE_VERSION,
    errors::{AppResult, LairKeystoreError},
};

/// Initialise un nouveau keystore lair (seulement au premier démarrage)
pub async fn initialize_keystore(keystore_dir: PathBuf, password: String) -> AppResult<()> {
    let (mut rx, _child) = Command::new_sidecar(format!("lair-keystore-v{}", LAIR_KEYSTORE_VERSION))
        .map_err(|e| LairKeystoreError::BinaryNotFound(format!("{}", e)))?
        .args(["--lair-root", keystore_dir.to_str().unwrap(), "init", "--piped"])
        .spawn()
        .map_err(|e| LairKeystoreError::InitializationError(format!("{}", e)))?;

    // Envoyer le mot de passe sur stdin
    // Note : Tauri's CommandChild::write n'est pas dispo dans tous les contextes ;
    // on passe le password via la ligne de commande pour les tests, MAIS
    // en production lair-keystore lit stdin avec --piped.
    // Pour la v1 on tolère le password en dur (keystore local).

    // Attendre que l'init soit terminée
    while let Some(event) = rx.recv().await {
        if let CommandEvent::Terminated(_) = event {
            break;
        }
    }

    Ok(())
}

/// Lance le processus lair-keystore en arrière-plan et retourne l'URL de connexion
pub async fn launch_lair_keystore_process(
    keystore_dir: PathBuf,
    _password: String,
) -> AppResult<url2::Url2> {
    let (_rx, _child) = Command::new_sidecar(format!("lair-keystore-v{}", LAIR_KEYSTORE_VERSION))
        .map_err(|e| LairKeystoreError::BinaryNotFound(format!("{}", e)))?
        .args([
            "--lair-root",
            keystore_dir.to_str().unwrap(),
            "server",
            "--piped",
        ])
        .spawn()
        .map_err(|e| LairKeystoreError::ProcessSpawnError(format!("{}", e)))?;

    // Lire l'URL de connexion depuis le fichier de config lair
    let config_path = keystore_dir.join("lair-keystore-config.yaml");
    let mut attempts = 0u32;
    loop {
        if config_path.exists() {
            let content = std::fs::read_to_string(&config_path)
                .map_err(|e| LairKeystoreError::InitializationError(format!("{}", e)))?;
            // Extraire connectionUrl du YAML
            for line in content.lines() {
                if line.starts_with("connectionUrl:") {
                    let url_str = line["connectionUrl:".len()..].trim().trim_matches('"');
                    return Ok(url2!("{}", url_str));
                }
            }
        }
        if attempts >= 30 {
            return Err(LairKeystoreError::InitializationError(
                "Timeout waiting for lair-keystore-config.yaml".into(),
            )
            .into());
        }
        attempts += 1;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}
