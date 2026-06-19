use filesystem::AppFileSystem;
use futures::lock::Mutex;
use holochain_keystore::MetaLairClient;

pub mod filesystem;

/// État global partagé entre les commandes Tauri
#[derive(Clone)]
pub struct AppState {
    pub fs:               AppFileSystem,
    pub app_port:         u16,
    pub admin_port:       u16,
    pub meta_lair_client: std::sync::Arc<Mutex<MetaLairClient>>,
}
