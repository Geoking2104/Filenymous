use std::path::PathBuf;
use tauri::api::process::{Command, CommandEvent};

use crate::{
    config::HOLOCHAIN_VERSION,
    errors::{AppResult, LaunchHolochainError},
};

/// Lance le processus holochain en arrière-plan avec la config donnée.
/// Attend que le conductor soit prêt (message "Conductor ready" dans stdout).
pub async fn launch_holochain_process(
    conductor_config_path: PathBuf,
    _password: String,
) -> AppResult<()> {
    let (mut rx, _child) =
        Command::new_sidecar(format!("holochain-v{}", HOLOCHAIN_VERSION))
            .map_err(|e| {
                LaunchHolochainError::SidecarBinaryCommandError(format!("{}", e))
            })?
            .args([
                "--config-path",
                conductor_config_path.to_str().unwrap(),
                "--piped",
            ])
            .spawn()
            .map_err(|e| {
                LaunchHolochainError::SidecarBinaryCommandError(format!("{}", e))
            })?;

    // Attendre que le conductor soit opérationnel
    let mut ready = false;
    let timeout = std::time::Instant::now();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                log::debug!("[holochain] {}", line);
                if line.contains("Conductor ready") || line.contains("conductor is ready") {
                    ready = true;
                    break;
                }
            }
            CommandEvent::Stderr(line) => {
                log::warn!("[holochain stderr] {}", line);
            }
            CommandEvent::Terminated(status) => {
                return Err(LaunchHolochainError::CouldNotConnectToConductor(
                    format!("holochain process terminated early: {:?}", status),
                )
                .into());
            }
            _ => {}
        }
        // Timeout de 60 secondes
        if timeout.elapsed().as_secs() > 60 {
            break;
        }
    }

    if !ready {
        log::warn!("holochain process may not be fully ready — continuing anyway");
    }

    Ok(())
}
