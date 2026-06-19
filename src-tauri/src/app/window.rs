use std::net::SocketAddr;

use holochain_client::{AdminWebsocket, IssueAppAuthenticationTokenPayload};
use tauri::api::process;
use tauri::{AppHandle, Manager, Window, WindowBuilder, Wry};

use crate::{app_state::filesystem::AppFileSystem, config};

/// Construit et affiche la fenêtre principale.
/// Injecte window.__HC_LAUNCHER_ENV__ avec les infos de connexion au conductor.
pub async fn build_main_window(
    fs: AppFileSystem,
    app_handle: &AppHandle,
    app_port: u16,
    admin_port: u16,
) -> Window {
    // Émettre un token d'auth pour cette session UI
    let admin_ws = AdminWebsocket::connect(SocketAddr::from(([127, 0, 0, 1], admin_port)))
        .await
        .expect("Failed to connect to admin WebSocket");

    let token_result = admin_ws
        .issue_app_auth_token(IssueAppAuthenticationTokenPayload {
            installed_app_id: config::APP_ID.to_string(),
            expiry_seconds:   999_999,
            single_use:       false,
        })
        .await;

    let app_token = match token_result {
        Ok(r)  => r.token,
        Err(e) => panic!("Failed to issue app auth token: {:?}", e),
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
    .initialization_script(&format!(
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
    ))
    .build()
    .expect("Failed to build main window")
}
