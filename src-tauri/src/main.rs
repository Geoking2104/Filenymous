// Empêche la console Windows en release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use app::{
    setup_app,
    system_tray::{app_system_tray, handle_system_tray_event},
};
use commands::sign_zome_call::sign_zome_call;
use tauri::{RunEvent, SystemTray};

mod app;
mod app_state;
mod commands;
mod config;
mod errors;
mod launch;
mod process;

fn main() {
    let builder_result = tauri::Builder::default()
        .system_tray(SystemTray::new().with_menu(app_system_tray()))
        .on_system_tray_event(handle_system_tray_event)
        .invoke_handler(tauri::generate_handler![sign_zome_call])
        .setup(setup_app)
        .build(tauri::generate_context!());

    match builder_result {
        Ok(app) => {
            app.run(|_handle, event| match event {
                // macOS : cmd+Q tue les sidecar processes
                RunEvent::Exit => {
                    tauri::api::process::kill_children();
                }
                // Fermeture de la fenêtre : masquer au lieu de quitter (systray)
                RunEvent::ExitRequested { api, .. } => {
                    api.prevent_exit();
                }
                _ => {}
            });
        }
        Err(e) => {
            log::error!("Erreur au démarrage de Filenymous : {:?}", e);
        }
    }
}
