// Empêche la console Windows en release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use app::{
    setup_app,
    system_tray::{app_system_tray, handle_system_tray_event},
};
use commands::sign_zome_call::sign_zome_call;
use single_instance::{Acquire, InstanceState};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, SystemTray};

mod app;
mod app_state;
mod commands;
mod config;
mod errors;
mod launch;
mod process;
mod setup;
mod single_instance;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let context = tauri::generate_context!();

    // ── Instance unique — AVANT le builder Tauri, donc avant tout spawn de
    // conductor/lair. Une 2e instance met la 1re au premier plan et quitte.
    let mut guard = match tauri::api::path::app_data_dir(context.config())
        .ok_or_else(|| std::io::Error::other("app data dir introuvable"))
        .and_then(|dir| single_instance::acquire(&dir))
    {
        Ok(Acquire::Primary(guard)) => Some(guard),
        Ok(Acquire::Secondary { notified }) => {
            log::info!(
                "Filenymous est déjà lancé ({}) : cette instance quitte",
                if notified {
                    "fenêtre existante mise au premier plan"
                } else {
                    "instance existante injoignable"
                }
            );
            return;
        }
        Err(e) => {
            // Verrou impossible (FS sans verrous…) : on démarre quand même.
            log::warn!("Instance unique non garantie : {e}");
            None
        }
    };

    let builder_result = tauri::Builder::default()
        .system_tray(SystemTray::new().with_menu(app_system_tray()))
        .on_system_tray_event(handle_system_tray_event)
        .invoke_handler(tauri::generate_handler![sign_zome_call])
        .setup(move |app| {
            // Enregistré en premier : les demandes reçues pendant le
            // démarrage du conductor attendent la fenêtre principale.
            if let Some(guard) = guard.as_mut() {
                let handle = app.handle();
                guard.serve(move || app::window::focus_main_window(&handle));
            }
            app.manage(InstanceState(Mutex::new(guard)));
            setup_app(app)
        })
        .build(context);

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
