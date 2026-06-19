use holochain_keystore::MetaLairClient;
use holochain_zome_types::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{app_state::AppState, errors::AppError};

/// Payload envoyé par le WebView pour signer un appel de zome
#[derive(Serialize, Deserialize, Debug)]
pub struct ZomeCallUnsignedTauri {
    pub provenance:    AgentPubKey,
    pub cell_id_dna:   DnaHash,
    pub cell_id_agent: AgentPubKey,
    pub zome_name:     ZomeName,
    pub fn_name:       FunctionName,
    pub cap_secret:    Option<CapSecret>,
    pub payload:       ExternIO,
    pub nonce:         Nonce256Bits,
    pub expires_at:    Timestamp,
}

/// Réponse : appel signé prêt à être envoyé via AppWebsocket
#[derive(Serialize, Deserialize, Debug)]
pub struct ZomeCallTauri {
    pub provenance:    AgentPubKey,
    pub cell_id_dna:   DnaHash,
    pub cell_id_agent: AgentPubKey,
    pub zome_name:     ZomeName,
    pub fn_name:       FunctionName,
    pub cap_secret:    Option<CapSecret>,
    pub payload:       ExternIO,
    pub nonce:         Nonce256Bits,
    pub expires_at:    Timestamp,
    pub signature:     Signature,
}

/// Commande Tauri : signe un appel de zome côté Rust (accès au lair keystore local)
#[tauri::command]
pub async fn sign_zome_call(
    state: State<'_, AppState>,
    zome_call_unsigned: ZomeCallUnsignedTauri,
) -> Result<ZomeCallTauri, String> {
    let lair = state.meta_lair_client.lock().await;

    let cell_id = CellId::new(
        zome_call_unsigned.cell_id_dna.clone(),
        zome_call_unsigned.cell_id_agent.clone(),
    );

    let unsigned = ZomeCallUnsigned {
        provenance:  zome_call_unsigned.provenance.clone(),
        cell_id,
        zome_name:   zome_call_unsigned.zome_name.clone(),
        fn_name:     zome_call_unsigned.fn_name.clone(),
        cap_secret:  zome_call_unsigned.cap_secret.clone(),
        payload:     zome_call_unsigned.payload.clone(),
        nonce:       zome_call_unsigned.nonce,
        expires_at:  zome_call_unsigned.expires_at,
    };

    let signature = lair
        .sign(unsigned.provenance.clone(), unsigned.data_to_sign().map_err(|e| format!("{:?}", e))?)
        .await
        .map_err(|e| format!("Error signing zome call: {:?}", e))?;

    Ok(ZomeCallTauri {
        provenance:    zome_call_unsigned.provenance,
        cell_id_dna:   zome_call_unsigned.cell_id_dna,
        cell_id_agent: zome_call_unsigned.cell_id_agent,
        zome_name:     zome_call_unsigned.zome_name,
        fn_name:       zome_call_unsigned.fn_name,
        cap_secret:    zome_call_unsigned.cap_secret,
        payload:       zome_call_unsigned.payload,
        nonce:         zome_call_unsigned.nonce,
        expires_at:    zome_call_unsigned.expires_at,
        signature,
    })
}
