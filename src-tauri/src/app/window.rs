use tauri::{AppHandle, Manager, Window, WindowBuilder};

use crate::{app_state::filesystem::AppFileSystem, config, setup};

/// Construit et affiche la fenêtre principale.
/// Injecte window.__HC_LAUNCHER_ENV__ avec les infos de connexion au conductor.
pub async fn build_main_window(
    fs: AppFileSystem,
    app_handle: &AppHandle,
    app_port: u16,
    admin_port: u16,
) -> Window {
    // Tokens d'auth de cette session UI (un par app installée).
    let admin_ws = setup::connect_admin(admin_port, 5)
        .await
        .expect("Failed to connect to admin WebSocket");

    let app_token = setup::issue_app_token(&admin_ws, config::APP_ID)
        .await
        .unwrap_or_else(|e| panic!("Failed to issue app auth token: {:?}", e));

    // Token de l'Agent Vault (app séparée), si elle est installée.
    let agent_vault_env = match setup::issue_app_token(&admin_ws, config::AGENT_VAULT_APP_ID).await
    {
        Ok(token) => format!(
            r#"window.__FNY_AGENT_VAULT_ENV__ = {{
          "APP_INTERFACE_PORT": {},
          "INSTALLED_APP_ID": "{}",
          "APP_INTERFACE_TOKEN": {:?}
        }};"#,
            app_port,
            config::AGENT_VAULT_APP_ID,
            token,
        ),
        Err(e) => {
            log::warn!("Agent Vault indisponible : {:?}", e);
            String::new()
        }
    };

    WindowBuilder::new(
        &app_handle.app_handle(),
        "main",
        tauri::WindowUrl::App("index.html".into()),
    )
    .disable_file_drop_handler()
    .inner_size(config::WINDOW_WIDTH, config::WINDOW_HEIGHT)
    .min_inner_size(700.0, 520.0)
    .resizable(true)
    .title(config::WINDOW_TITLE)
    .data_directory(fs.profile_data_dir)
    .center()
    // Injecter les infos de connexion pour que le WebView puisse se connecter
    // au conductor local via AppWebsocket (même interface que Holochain Launcher)
    .initialization_script(
        &(format!(
            r#"window.__HC_LAUNCHER_ENV__ = {{
          "APP_INTERFACE_PORT": {},
          "ADMIN_INTERFACE_PORT": {},
          "INSTALLED_APP_ID": "{}",
          "APP_INTERFACE_TOKEN": {:?}
        }};"#,
            app_port,
            admin_port,
            config::APP_ID,
            app_token,
        ) + &agent_vault_env),
    )
    .build()
    .expect("Failed to build main window")
}

/// Met la fenêtre principale au premier plan (2e lancement de l'app).
/// Si le conductor démarre encore, la fenêtre n'existe pas : elle s'ouvrira
/// d'elle-même à la fin du démarrage.
pub fn focus_main_window(app_handle: &AppHandle) {
    match app_handle.get_window("main") {
        Some(window) => {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        None => log::info!("2e lancement pendant le démarrage : fenêtre pas encore créée"),
    }
}
