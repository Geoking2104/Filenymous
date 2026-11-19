use holochain_client::ConductorApiError;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Filesystem error: `{0}`")]
    FileSystemError(String),

    #[error("ConductorApiError: `{0:?}`")]
    ConductorApiError(ConductorApiError),

    #[error(transparent)]
    IoError(#[from] std::io::Error),

    #[error(transparent)]
    TauriError(#[from] tauri::Error),

    #[error("Error signing zome call: `{0}`")]
    SignZomeCallError(String),

    #[error(transparent)]
    LairKeystoreError(#[from] LairKeystoreError),

    #[error(transparent)]
    LaunchHolochainError(#[from] LaunchHolochainError),
}

impl From<ConductorApiError> for AppError {
    fn from(e: ConductorApiError) -> Self {
        AppError::ConductorApiError(e)
    }
}

// ── Lair errors ──────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum LairKeystoreError {
    #[error("Lair keystore config not found: `{0}`")]
    ConfigNotFound(String),

    #[error("Failed to connect to lair: `{0}`")]
    ConnectError(String),
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
