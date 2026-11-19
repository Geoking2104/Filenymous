//! Instance unique de l'application desktop.
//!
//! Deux Filenymous lancés en même temps démarreraient deux conductors
//! Holochain (et deux lair in-process) sur le même répertoire de données.
//! On l'empêche **avant** de construire Tauri, donc avant tout spawn :
//!
//! 1. verrou exclusif de l'OS sur `<app_data>/instance.lock` (`flock` sur
//!    Unix, `LockFileEx` sur Windows). L'OS le libère tout seul quand le
//!    processus meurt, même sur un crash : pas de verrou périmé possible ;
//! 2. la 1re instance écoute sur `127.0.0.1:<port éphémère>` et écrit
//!    `instance.json` (port + jeton aléatoire, lisible par l'utilisateur
//!    seulement sur Unix) ;
//! 3. une 2e instance n'obtient pas le verrou : elle envoie le jeton sur ce
//!    port (« mets-toi au premier plan ») puis quitte immédiatement.
//!
//! Pourquoi pas `tauri-plugin-single-instance` ? Pour Tauri 1 (branche `v1`
//! de tauri-apps/plugins-workspace, non publiée sur crates.io), le plugin est
//! un no-op sur macOS, panique sur Linux sans bus D-Bus de session, et ne
//! quitte la 2e instance qu'une fois la boucle d'évènements lancée, c.-à-d.
//! après notre hook `setup`, qui démarre le conductor.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use fs4::fs_std::FileExt;
use rand::RngCore;
use serde::{Deserialize, Serialize};

pub const LOCK_FILE: &str = "instance.lock";
pub const INFO_FILE: &str = "instance.json";

/// Message envoyé par une 2e instance à la 1re.
const FOCUS_CMD: &str = "focus";

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct InstanceInfo {
    pid: u32,
    port: u16,
    token: String,
}

/// Résultat de [`acquire`].
pub enum Acquire {
    /// Cette instance est la seule : elle garde le verrou.
    Primary(InstanceGuard),
    /// Une autre instance tourne déjà (elle a été prévenue si possible).
    Secondary { notified: bool },
}

/// Détenu par l'instance principale. Le verrou est rendu quand il est
/// détruit (ou quand le processus se termine).
pub struct InstanceGuard {
    lock: File,
    listener: Option<TcpListener>,
    token: String,
    dir: PathBuf,
}

impl InstanceGuard {
    /// Traite les demandes « focus » des instances suivantes dans un thread.
    /// `on_focus` est appelé pour chaque demande authentifiée par le jeton.
    pub fn serve<F>(&mut self, on_focus: F)
    where
        F: Fn() + Send + 'static,
    {
        let Some(listener) = self.listener.take() else {
            return;
        };
        let token = self.token.clone();
        std::thread::Builder::new()
            .name("single-instance".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    match stream {
                        Ok(stream) => {
                            if read_request(stream, &token) {
                                on_focus();
                            }
                        }
                        Err(e) => log::warn!("single-instance : accept : {e}"),
                    }
                }
            })
            .map(|_| ())
            .unwrap_or_else(|e| log::warn!("single-instance : thread : {e}"));
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.dir.join(INFO_FILE));
        let _ = FileExt::unlock(&self.lock);
    }
}

/// État Tauri : permet de rendre le verrou avant un redémarrage
/// (`AppHandle::restart` lance le nouveau processus avant de quitter).
pub struct InstanceState(pub Mutex<Option<InstanceGuard>>);

impl InstanceState {
    pub fn release(&self) {
        if let Ok(mut guard) = self.0.lock() {
            guard.take();
        }
    }
}

/// Tente de devenir l'instance principale pour le répertoire `dir`.
/// Si une autre instance tient déjà le verrou, la prévient puis retourne
/// [`Acquire::Secondary`] : l'appelant doit alors quitter sans rien lancer.
pub fn acquire(dir: &Path) -> io::Result<Acquire> {
    fs::create_dir_all(dir)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(LOCK_FILE))?;

    if !FileExt::try_lock_exclusive(&lock)? {
        return Ok(Acquire::Secondary {
            notified: notify_primary(dir, Duration::from_secs(3)),
        });
    }

    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let info = InstanceInfo {
        pid: std::process::id(),
        port: listener.local_addr()?.port(),
        token: token.clone(),
    };
    write_private(&dir.join(INFO_FILE), &serde_json::to_vec(&info)?)?;

    Ok(Acquire::Primary(InstanceGuard {
        lock,
        listener: Some(listener),
        token,
        dir: dir.to_path_buf(),
    }))
}

/// Envoie « focus » à l'instance principale. Réessaie jusqu'à `timeout` :
/// la principale peut tenir le verrou sans avoir encore écrit son port.
fn notify_primary(dir: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(info) = fs::read(dir.join(INFO_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice::<InstanceInfo>(&b).ok())
        {
            if send_focus(&info).is_ok() {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn send_focus(info: &InstanceInfo) -> io::Result<()> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, info.port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500))?;
    stream.set_write_timeout(Some(Duration::from_millis(500)))?;
    stream.write_all(format!("{} {FOCUS_CMD}\n", info.token).as_bytes())?;
    stream.flush()
}

/// Lit une requête (une ligne, bornée) et vérifie le jeton.
fn read_request(stream: TcpStream, token: &str) -> bool {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let mut line = String::new();
    let mut reader = BufReader::new(io::Read::take(stream, 256));
    if reader.read_line(&mut line).is_err() {
        return false;
    }
    let mut parts = line.trim_end().splitn(2, ' ');
    let ok = matches!(
        (parts.next(), parts.next()),
        (Some(t), Some(FOCUS_CMD)) if constant_time_eq(t.as_bytes(), token.as_bytes())
    );
    if !ok {
        log::warn!("single-instance : requête locale refusée (jeton invalide)");
    }
    ok
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Écrit `bytes` dans `path` de façon atomique (fichier temporaire + rename),
/// en 0600 sur Unix.
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fny-single-instance-{name}-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wait_for(count: &AtomicUsize, n: usize) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if count.load(Ordering::SeqCst) >= n {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn second_instance_focuses_first_and_does_not_get_the_lock() {
        let dir = temp_dir("focus");
        let Acquire::Primary(mut primary) = acquire(&dir).unwrap() else {
            panic!("la 1re instance doit être principale");
        };
        let focused = Arc::new(AtomicUsize::new(0));
        let f = focused.clone();
        primary.serve(move || {
            f.fetch_add(1, Ordering::SeqCst);
        });

        match acquire(&dir).unwrap() {
            Acquire::Secondary { notified } => assert!(notified),
            Acquire::Primary(_) => panic!("2 instances principales"),
        }
        assert!(
            wait_for(&focused, 1),
            "la 1re instance n'a pas été prévenue"
        );

        // Une fois la 1re instance partie, la suivante redevient principale.
        drop(primary);
        assert!(!dir.join(INFO_FILE).exists());
        assert!(matches!(acquire(&dir).unwrap(), Acquire::Primary(_)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn released_state_frees_the_lock() {
        let dir = temp_dir("release");
        let Acquire::Primary(primary) = acquire(&dir).unwrap() else {
            panic!("principale attendue");
        };
        let state = InstanceState(Mutex::new(Some(primary)));
        state.release();
        assert!(matches!(acquire(&dir).unwrap(), Acquire::Primary(_)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_token_is_rejected() {
        let dir = temp_dir("token");
        let Acquire::Primary(mut primary) = acquire(&dir).unwrap() else {
            panic!("principale attendue");
        };
        let port = primary
            .listener
            .as_ref()
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let focused = Arc::new(AtomicUsize::new(0));
        let f = focused.clone();
        primary.serve(move || {
            f.fetch_add(1, Ordering::SeqCst);
        });

        let forged = InstanceInfo {
            pid: 0,
            port,
            token: "00".repeat(32),
        };
        send_focus(&forged).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(focused.load(Ordering::SeqCst), 0);
        drop(primary);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_primary_port_is_not_fatal() {
        // Verrou tenu mais instance.json absent : la 2e instance abandonne
        // la notification sans planter et reste secondaire.
        let dir = temp_dir("noinfo");
        let Acquire::Primary(primary) = acquire(&dir).unwrap() else {
            panic!("principale attendue");
        };
        fs::remove_file(dir.join(INFO_FILE)).unwrap();
        assert!(!notify_primary(&dir, Duration::from_millis(200)));
        drop(primary);
        let _ = fs::remove_dir_all(&dir);
    }
}
