use crate::app_state::AppState;
use tauri::{
    api::process, AppHandle, CustomMenuItem, Manager, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem, Wry,
};

pub fn app_system_tray() -> SystemTrayMenu {
    SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("open", "Ouvrir Filenymous"))
        .add_item(CustomMenuItem::new("restart", "Redémarrer"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("quit", "Quitter"))
}

pub fn handle_system_tray_event(app: &AppHandle<Wry>, event: SystemTrayEvent) {
    if let SystemTrayEvent::MenuItemClick { id, .. } = event {
        match id.as_str() {
            "open" => {
                if let Some(window) = app.get_window("main") {
                    window.show().unwrap();
                    window.unminimize().unwrap();
                    window.set_focus().unwrap();
                }
            }
            "restart" => {
                process::kill_children();
                app.app_handle().restart();
            }
            "quit" => {
                process::kill_children();
                app.exit(0);
            }
            _ => {}
        }
    }
}
