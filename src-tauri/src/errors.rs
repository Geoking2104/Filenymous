use holochain::{conductor::error::ConductorError, prelude::AppBundleError};
use holochain_client::ConductorApiError;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Filesystem error: `{0}`")]
    FileSystemError(String),

    #[error("Holochain is not running")]
    NotRunning,

    #[error("ConductorApiError: `{0:?}`")]
    ConductorApiError(ConductorApiError),

    #[error("Database error: `{0}`")]
    DatabaseError(String),

    #[error("SemVer error: `{0:?}`")]
    SemVerError(semver::Error),

    #[error(transparent)]
    AppBundleError(#[from] AppBundleError),

    #[error(transparent)]
    IoError(#[from] std::io::Error),

    #[error(transparent)]
    MrBundleError(#[from] mr_bundle::error::MrBundleError),

    #[error(transparent)]
    ConductorError(#[from] ConductorError),

    #[error(transparent)]
    TauriError(#[from] tauri::Error),

    #[error("Admin WebSocket error: `{0}`")]
    AdminWebsocketError(String),

    #[error("App WebSocket error: `{0}`")]
    AppWebsocketError(String),

    #[error("Error signing zome call: `{0}`")]
    SignZomeCallError(String),

    #[error(transparent)]
    LairKeystoreError(#[from] LairKeystoreError),

    #[error(transparent)]
    LaunchHolochainError(#[from] LaunchHolochainError),
}

// ── Lair errors ──────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum LairKeystoreError {
    #[error("Lair binary not found: `{0}`")]
    BinaryNotFound(String),

    #[error("Failed to initialize keystore: `{0}`")]
    InitializationError(String),

    #[error("Failed to spawn lair process: `{0}`")]
    ProcessSpawnError(String),

    #[error("Failed to spawn MetaLairClient: `{0}`")]
    SpawnMetaLairClientError(String),

    #[error("Failed to create symlink: `{0}`")]
    ErrorCreatingSymLink(String),
}

impl From<LairKeystoreError> for AppError {
    fn from(e: LairKeystoreError) -> Self {
        AppError::LairKeystoreError(e)
    }
}

// ── Holochain launch errors ───────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum LaunchHolochainError {
    #[error("Sidecar binary command error: `{0}`")]
    SidecarBinaryCommandError(String),

    #[error("Could not connect to conductor: `{0}`")]
    CouldNotConnectToConductor(String),

    #[error("Failed to write conductor config: `{0}`")]
    FailedToWriteConductorConfig(String),
}

impl From<LaunchHolochainError> for AppError {
    fn from(e: LaunchHolochainError) -> Self {
        AppError::LaunchHolochainError(e)
    }
}
