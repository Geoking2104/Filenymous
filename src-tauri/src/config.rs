/// Nom de l'application (affiché dans les profils, logs)
pub const APP_NAME: &str = "Filenymous";

/// App ID utilisé pour installer le hApp dans le conductor.
/// Modifier = breaking change (les données existantes ne sont plus accessibles).
pub const APP_ID: &str = "filenymous";

/// App ID de l'Agent Vault, installée À PART (dnas/agent_vault/happ.yaml) :
/// son DNA a son propre network seed (dna.yaml), le hApp principal est inchangé.
pub const AGENT_VAULT_APP_ID: &str = "filenymous-agent-vault";

/// Titre de la fenêtre principale
pub const WINDOW_TITLE: &str = "Filenymous";

/// Dimensions par défaut de la fenêtre
pub const WINDOW_WIDTH: f64 = 900.0;
pub const WINDOW_HEIGHT: f64 = 680.0;

/// Mot de passe du keystore lair.
/// En production : lire depuis un secrets store ou demander à l'utilisateur.
/// Pour v1, on utilise une valeur fixe — acceptable car le keystore est local.
pub const PASSWORD: &str = "filenymous-lair-v1";

/// Network seed partagé par tous les utilisateurs Filenymous.
/// Modifier = fork du réseau (les données ne sont plus accessibles à l'ancienne seed).
/// None = pas de seed (DHT global).
/// Doit rester égale à `network_seed` de dnas/filenymous/dna.yaml.
pub const DEFAULT_NETWORK_SEED: Option<&str> = Some("filenymous-mainnet-v3");

/// Réseau kitsune2 (Holochain 0.6) : bootstrap (découverte des pairs),
/// signal (WebRTC) et relay iroh. Valeurs par défaut de Holochain 0.6.1
/// (infrastructure de test publique de Holochain) tant que
/// `bootstrap.filenymous.eu` (network/README.md) n'est pas en service.
/// Surchargeables au lancement via FILENYMOUS_BOOTSTRAP_URL,
/// FILENYMOUS_SIGNAL_URL et FILENYMOUS_RELAY_URL.
pub const BOOTSTRAP_SERVER: &str = "https://dev-test-bootstrap2.holochain.org";
pub const SIGNALING_SERVER: &str = "wss://dev-test-bootstrap2.holochain.org";
pub const RELAY_SERVER: &str = "https://use1-1.relay.n0.iroh-canary.iroh.link./";

/// Version de holochain — dérivée du build script depuis Cargo.toml.
/// Utilisée pour construire le nom du sidecar : holochain-v{HOLOCHAIN_VERSION}
pub const HOLOCHAIN_VERSION: &str = env!("HOLOCHAIN_VERSION");
