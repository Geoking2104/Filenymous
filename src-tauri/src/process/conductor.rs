use std::path::Path;
use tauri::api::process::{Command, CommandEvent};

use crate::{
    config::HOLOCHAIN_VERSION,
    errors::{AppResult, LaunchHolochainError},
};

/// Lance le sidecar `holochain-v<version>` avec `--piped` : la passphrase du
/// lair in-process est écrite sur stdin. Attend « Conductor ready. ».
pub async fn launch_holochain_process(
    conductor_config_path: &Path,
    password: &str,
) -> AppResult<()> {
    let sidecar = format!("holochain-v{}", HOLOCHAIN_VERSION);
    let (mut rx, mut child) = Command::new_sidecar(&sidecar)
        .map_err(|e| LaunchHolochainError::SidecarBinaryCommandError(format!("{sidecar}: {e}")))?
        .args([
            "--config-path",
            conductor_config_path.to_str().ok_or_else(|| {
                LaunchHolochainError::SidecarBinaryCommandError("non-UTF-8 config path".into())
            })?,
            "--piped",
        ])
        .spawn()
        .map_err(|e| LaunchHolochainError::SidecarBinaryCommandError(format!("{sidecar}: {e}")))?;

    child
        .write(format!("{password}\n").as_bytes())
        .map_err(|e| LaunchHolochainError::SidecarBinaryCommandError(format!("stdin: {e}")))?;

    let wait = async {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::debug!("[holochain] {line}");
                    if line.contains("Conductor ready") {
                        return Ok(());
                    }
                }
                CommandEvent::Stderr(line) => log::warn!("[holochain] {line}"),
                CommandEvent::Terminated(status) => {
                    return Err(LaunchHolochainError::CouldNotConnectToConductor(format!(
                        "holochain terminated early: {status:?}"
                    )));
                }
                _ => {}
            }
        }
        Err(LaunchHolochainError::CouldNotConnectToConductor(
            "holochain output closed".into(),
        ))
    };
    match tokio::time::timeout(std::time::Duration::from_secs(60), wait).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => log::warn!("holochain n'a pas signalé « Conductor ready » en 60 s — on continue"),
    }

    // Continuer à drainer les logs du conductor en arrière-plan.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => log::debug!("[holochain] {line}"),
                CommandEvent::Stderr(line) => log::debug!("[holochain] {line}"),
                CommandEvent::Terminated(status) => {
                    log::error!("holochain s'est arrêté : {status:?}");
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}
