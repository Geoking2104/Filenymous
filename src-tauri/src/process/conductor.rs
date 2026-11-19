use std::path::Path;
use tauri::api::process::{Command, CommandEvent};

use super::stale::{self, StaleOutcome};
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
    let conductor_dir = conductor_config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();

    // Conductor orphelin d'un crash précédent (cf. process::stale) : il
    // tiendrait la base et le lair du profil, le nouveau échouerait.
    match stale::reap(&conductor_dir, conductor_config_path) {
        StaleOutcome::StillRunning => {
            return Err(LaunchHolochainError::CouldNotConnectToConductor(
                "un conductor Holochain d'une session précédente tourne encore \
                 et n'a pas pu être arrêté"
                    .into(),
            )
            .into())
        }
        outcome => log::info!("Conductor précédent : {outcome:?}"),
    }

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

    if let Err(e) = stale::record(&conductor_dir, child.pid(), conductor_config_path) {
        log::warn!("PID du conductor non enregistré : {e}");
    }

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
                    let _ = std::fs::remove_file(stale::pid_file(&conductor_dir));
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}
