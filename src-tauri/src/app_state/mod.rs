use filesystem::AppFileSystem;
use lair_keystore_api::LairClient;

pub mod filesystem;

/// État global partagé entre les commandes Tauri
#[derive(Clone)]
pub struct AppState {
    pub fs: AppFileSystem,
    pub app_port: u16,
    pub admin_port: u16,
    pub lair_client: LairClient,
}
