use std::path::PathBuf;
use tauri::{api::path::app_data_dir, AppHandle, Config};

use crate::errors::{AppError, AppResult};

/// Nom du profil par défaut
pub const DEFAULT_PROFILE: &str = "default";

/// Représente le système de fichiers de l'application pour un profil donné.
#[derive(Clone, Debug)]
pub struct AppFileSystem {
    /// Répertoire racine des données du profil (dans app data dir OS)
    pub profile_data_dir: PathBuf,
    /// Répertoire du conductor Holochain
    conductor_dir_path:   PathBuf,
    /// Répertoire du keystore lair
    keystore_dir_path:    PathBuf,
}

pub type Profile = String;

impl AppFileSystem {
    /// Crée un AppFileSystem pour le profil donné.
    /// Crée les répertoires s'ils n'existent pas.
    pub fn new(app_handle: &AppHandle, profile: &str) -> AppResult<Self> {
        let config: std::sync::Arc<Config> = app_handle.config();
        let app_data = app_data_dir(&config)
            .ok_or_else(|| AppError::FileSystemError("Cannot resolve app data dir".into()))?;

        let profile_data_dir   = app_data.join("profiles").join(profile);
        let conductor_dir_path = profile_data_dir.join("conductor");
        let keystore_dir_path  = profile_data_dir.join("keystore");

        Ok(Self {
            profile_data_dir,
            conductor_dir_path,
            keystore_dir_path,
        })
    }

    pub fn conductor_dir(&self) -> PathBuf {
        self.conductor_dir_path.clone()
    }

    pub fn keystore_dir(&self) -> PathBuf {
        self.keystore_dir_path.clone()
    }

    pub fn keystore_initialized(&self) -> bool {
        self.keystore_dir_path.join("lair-keystore-config.yaml").exists()
    }

    /// Lit la network seed du profil courant (si elle a été personnalisée)
    pub fn read_profile_network_seed(&self) -> Option<String> {
        let seed_path = self.profile_data_dir.join("network-seed.txt");
        std::fs::read_to_string(seed_path).ok()
    }

    /// Retourne le profil actif (lu depuis un fichier de config simple)
    pub fn get_active_profile(&self) -> String {
        let profile_path = self.profile_data_dir
            .parent()
            .unwrap_or(&self.profile_data_dir)
            .parent()
            .unwrap_or(&self.profile_data_dir)
            .join("active-profile.txt");
        std::fs::read_to_string(profile_path)
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| DEFAULT_PROFILE.to_string())
    }
}
