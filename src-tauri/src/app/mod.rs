use futures::lock::Mutex;
use std::sync::Arc;
use tauri::{App, Manager};

use crate::{
    app_state::{filesystem::AppFileSystem, AppState},
    config,
    launch::launch,
};

pub mod system_tray;
pub mod window;

/// Callback de setup Tauri — lancé une fois que la fenêtre est créée.
/// Lance le conductor Holochain et ouvre la fenêtre principale.
pub fn setup_app(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();

    // Lire le profil depuis les arguments CLI, ou utiliser "default"
    let profile = read_profile_from_cli(app).unwrap_or_else(|_| "default".to_string());

    let fs = AppFileSystem::new(&handle, &profile)?;

    tauri::async_runtime::block_on(async move {
        match launch(&fs, config::PASSWORD.to_string()).await {
            Ok((meta_lair_client, app_port, admin_port)) => {
                let state = AppState {
                    fs: fs.clone(),
                    app_port,
                    admin_port,
                    meta_lair_client: Arc::new(Mutex::new(meta_lair_client)),
                };
                handle.manage(state);

                window::build_main_window(fs, &handle, app_port, admin_port).await;
            }
            Err(e) => {
                log::error!("Failed to launch Holochain: {:?}", e);
                tauri::api::dialog::message(
                    None::<&tauri::Window>,
                    "Erreur de démarrage",
                    format!("Filenymous n'a pas pu démarrer Holochain :\n\n{}", e),
                );
                std::process::exit(1);
            }
        }
    });

    Ok(())
}

fn read_profile_from_cli(app: &App) -> Result<String, ()> {
    let matches = app.get_cli_matches().map_err(|_| ())?;
    if let Some(profile_match) = matches.args.get("profile") {
        if let tauri::api::cli::ArgData {
            value: serde_json::Value::String(profile),
            ..
        } = profile_match
        {
            if !profile.is_empty() {
                return Ok(profile.clone());
            }
        }
    }
    Err(())
}
