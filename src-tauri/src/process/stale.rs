//! Conductor orphelin d'une session précédente.
//!
//! Si Filenymous est tué brutalement (crash, `kill -9`, extinction forcée),
//! le sidecar `holochain` peut lui survivre : il garde alors la base du
//! conductor et le lair in-process (`keystore/pid_file`, socket IPC), et le
//! conductor suivant échoue au démarrage.
//!
//! Au lancement, on écrit le PID du sidecar dans `conductor/holochain.pid`.
//! Au lancement suivant (on tient déjà le verrou d'instance unique, donc
//! aucune autre instance de l'app ne peut l'utiliser), si ce PID est vivant
//! **et** que c'est bien notre sidecar (nom `holochain…` et `--config-path`
//! pointant sur notre config), on l'arrête. Tout autre processus — PID
//! réutilisé par le système, conductor d'un autre outil — n'est pas touché.
//!
//! On n'essaie pas de réutiliser l'orphelin : son stdout (signal « Conductor
//! ready » et logs) est perdu et son port admin n'est plus celui de la config
//! réécrite à chaque lancement. Le redémarrer est plus sûr.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System, UpdateKind};

pub const PID_FILE: &str = "holochain.pid";

/// Ce qu'on a trouvé au démarrage.
#[derive(Debug, PartialEq, Eq)]
pub enum StaleOutcome {
    /// Pas de fichier PID : arrêt propre la dernière fois.
    Clean,
    /// Le PID enregistré n'existe plus.
    Gone,
    /// Le PID existe mais ce n'est pas notre conductor : laissé tel quel.
    NotOurs,
    /// Notre conductor orphelin a été arrêté.
    Killed,
    /// Notre conductor orphelin n'a pas pu être arrêté.
    StillRunning,
}

pub fn pid_file(conductor_dir: &Path) -> PathBuf {
    conductor_dir.join(PID_FILE)
}

/// Enregistre le PID du sidecar (et la config qu'il utilise).
pub fn record(conductor_dir: &Path, pid: u32, config_path: &Path) -> std::io::Result<()> {
    fs::write(
        pid_file(conductor_dir),
        format!("{pid}\n{}\n", config_path.display()),
    )
}

/// Le processus `name`/`cmd` est-il le sidecar holochain lancé avec `config_path` ?
pub fn is_our_conductor(name: &std::ffi::OsStr, cmd: &[OsString], config_path: &Path) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    if !name.starts_with("holochain") {
        return false;
    }
    let wanted = config_path.as_os_str();
    cmd.windows(2)
        .any(|w| w[0] == "--config-path" && Path::new(&w[1]) == Path::new(wanted))
}

/// Arrête le conductor orphelin d'une session précédente s'il est à nous.
pub fn reap(conductor_dir: &Path, config_path: &Path) -> StaleOutcome {
    let path = pid_file(conductor_dir);
    let Ok(content) = fs::read_to_string(&path) else {
        return StaleOutcome::Clean;
    };
    let outcome = match content
        .lines()
        .next()
        .and_then(|l| l.trim().parse::<u32>().ok())
    {
        Some(pid) if pid != std::process::id() => reap_pid(Pid::from_u32(pid), config_path),
        _ => StaleOutcome::Gone,
    };
    if outcome != StaleOutcome::StillRunning {
        let _ = fs::remove_file(&path);
    }
    outcome
}

fn refresh(sys: &mut System, pid: Pid) {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
}

fn reap_pid(pid: Pid, config_path: &Path) -> StaleOutcome {
    let mut sys = System::new();
    refresh(&mut sys, pid);
    let Some(process) = sys.process(pid) else {
        return StaleOutcome::Gone;
    };
    if !is_our_conductor(process.name(), process.cmd(), config_path) {
        log::info!(
            "PID {pid} enregistré n'est pas notre conductor ({:?}) : ignoré",
            process.name()
        );
        return StaleOutcome::NotOurs;
    }
    log::warn!("Conductor orphelin (PID {pid}) d'une session précédente : arrêt");
    process.kill();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        refresh(&mut sys, pid);
        // Zombie = terminé, en attente de `wait` par son parent.
        if sys
            .process(pid)
            .is_none_or(|p| p.status() == ProcessStatus::Zombie)
        {
            return StaleOutcome::Killed;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    log::error!("Le conductor orphelin (PID {pid}) ne s'arrête pas");
    StaleOutcome::StillRunning
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn os(v: &[&str]) -> Vec<OsString> {
        v.iter().map(OsString::from).collect()
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fny-stale-{name}-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recognises_only_our_sidecar() {
        let cfg = Path::new("/data/profiles/default/conductor/conductor-config.yaml");
        let cmd = os(&[
            "holochain-v0.6.1",
            "--config-path",
            "/data/profiles/default/conductor/conductor-config.yaml",
            "--piped",
        ]);
        assert!(is_our_conductor(OsStr::new("holochain-v0.6.1"), &cmd, cfg));
        assert!(is_our_conductor(
            OsStr::new("holochain-v0.6.1.exe"),
            &cmd,
            cfg
        ));
        // autre binaire
        assert!(!is_our_conductor(OsStr::new("bash"), &cmd, cfg));
        // autre profil / autre outil
        let other = os(&["holochain", "--config-path", "/elsewhere/config.yaml"]);
        assert!(!is_our_conductor(OsStr::new("holochain"), &other, cfg));
        assert!(!is_our_conductor(
            OsStr::new("holochain"),
            &os(&["holochain"]),
            cfg
        ));
    }

    #[test]
    fn no_pid_file_is_clean() {
        let dir = temp_dir("clean");
        assert_eq!(reap(&dir, &dir.join("c.yaml")), StaleOutcome::Clean);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dead_pid_is_cleaned_up() {
        let dir = temp_dir("gone");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--help")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        record(&dir, pid, &dir.join("c.yaml")).unwrap();
        assert_eq!(reap(&dir, &dir.join("c.yaml")), StaleOutcome::Gone);
        assert!(!pid_file(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_foreign_process_is_never_killed() {
        // Le PID enregistré est vivant mais ce n'est pas un holochain : PID
        // réutilisé par l'OS. Il ne doit pas être arrêté.
        let dir = temp_dir("foreign");
        let cfg = dir.join("c.yaml");
        record(&dir, std::process::id(), &cfg).unwrap(); // nous-mêmes : ignoré
        assert_eq!(reap(&dir, &cfg), StaleOutcome::Gone);

        #[cfg(unix)]
        {
            let mut child = std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .unwrap();
            record(&dir, child.id(), &cfg).unwrap();
            assert_eq!(reap(&dir, &cfg), StaleOutcome::NotOurs);
            assert!(
                child.try_wait().unwrap().is_none(),
                "processus étranger tué"
            );
            child.kill().unwrap();
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn orphaned_conductor_is_stopped() {
        // Faux sidecar : une copie de /bin/bash (/bin/sh n'est qu'un
        // trampoline sur macOS) nommée `holochain-v0.6.1`,
        // lancée avec `--config-path <notre config>` comme le vrai.
        let dir = temp_dir("orphan");
        let cfg = dir.join("conductor-config.yaml");
        let fake = dir.join("holochain-v0.6.1");
        fs::copy("/bin/bash", &fake).unwrap();
        // `bash -c <script> <$0> <$1>` : les arguments suivants ne sont pas
        // interprétés comme des options, la ligne de commande ressemble donc
        // à celle du vrai sidecar.
        let mut child = std::process::Command::new(&fake)
            .arg("-c")
            .arg("while :; do sleep 0.2; done")
            .arg("--config-path")
            .arg(&cfg)
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        record(&dir, child.id(), &cfg).unwrap();
        let outcome = reap(&dir, &cfg);
        let _ = child.wait();
        assert_eq!(outcome, StaleOutcome::Killed);
        assert!(!pid_file(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
