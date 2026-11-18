use tauri::State;

use crate::{
    app_state::AppState,
    setup::{self, ZomeCallSignedTauri, ZomeCallUnsignedTauri},
};

/// Commande Tauri appelée par `window.__HC_ZOME_CALL_SIGNER__` (injecté par
/// ui/src/holochain/tauriSigner.ts) : signe l'appel avec la clé de l'agent
/// dans le lair local. La WebView n'a jamais accès aux clés privées.
#[tauri::command]
pub async fn sign_zome_call(
    state: State<'_, AppState>,
    zome_call_unsigned: ZomeCallUnsignedTauri,
) -> Result<ZomeCallSignedTauri, String> {
    setup::sign_zome_call(&state.lair_client, zome_call_unsigned)
        .await
        .map_err(|e| e.to_string())
}
