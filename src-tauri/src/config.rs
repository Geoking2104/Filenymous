/// Nom de l'application (affiché dans les profils, logs)
pub const APP_NAME: &str = "Filenymous";

/// App ID utilisé pour installer le hApp dans le conductor.
/// Modifier = breaking change (les données existantes ne sont plus accessibles).
pub const APP_ID: &str = "filenymous";

/// Titre de la fenêtre principale
pub const WINDOW_TITLE: &str = "Filenymous";

/// Dimensions par défaut de la fenêtre
pub const WINDOW_WIDTH: f64  = 900.0;
pub const WINDOW_HEIGHT: f64 = 680.0;

/// Mot de passe du keystore lair.
/// En production : lire depuis un secrets store ou demander à l'utilisateur.
/// Pour v1, on utilise une valeur fixe — acceptable car le keystore est local.
pub const PASSWORD: &str = "filenymous-lair-v1";

/// Network seed partagé par tous les utilisateurs Filenymous.
/// Modifier = fork du réseau (les données ne sont plus accessibles à l'ancienne seed).
/// None = pas de seed (DHT global).
pub const DEFAULT_NETWORK_SEED: Option<&str> = Some("filenymous-mainnet-v1");

/// Serveur de signalisation WebRTC (kitsune2)
pub const SIGNALING_SERVER: &str = "wss://signal.holo.host";

/// Serveur bootstrap DHT (kitsune2)
pub const BOOTSTRAP_SERVER: &str = "https://bootstrap.holo.host";

/// Version de holochain — dérivée du build script depuis Cargo.toml.
/// Utilisée pour construire le nom du sidecar : holochain-v{HOLOCHAIN_VERSION}
pub const HOLOCHAIN_VERSION: &str = env!("HOLOCHAIN_VERSION");

/// Version de lair-keystore — doit correspondre au binaire dans bins/
pub const LAIR_KEYSTORE_VERSION: &str = "0.4.5";
