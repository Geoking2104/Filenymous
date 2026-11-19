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
                // `restart` lance le nouveau processus avant de quitter :
                // rendre le verrou d'instance unique, sinon il se croirait
                // une 2e instance et quitterait aussitôt.
                if let Some(state) = app.try_state::<crate::single_instance::InstanceState>() {
                    state.release();
                }
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
