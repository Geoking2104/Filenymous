use hdi::prelude::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PresenceStatus {
    Online,
    Idle,
    Leaving,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TransferRequestStatus {
    Pending,
    Accepted,
    Refused,
    Negotiating,
    Transferring,
    Done,
    Revoked,
    Expired,
    Failed,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct Room {
    pub room_id: String,
    pub created_by: AgentPubKey,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
    pub access_policy: String,
    pub room_label_ciphertext: String,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct PresenceEvent {
    pub room_id: String,
    pub agent: AgentPubKey,
    pub status: PresenceStatus,
    pub avatar_seed_commitment: String,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct RoomMessage {
    pub room_id: String,
    pub author: AgentPubKey,
    pub ciphertext: String,
    pub nonce: String,
    pub key_id: String,
    pub created_at: Timestamp,
    pub previous_message_hash: Option<EntryHash>,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct TransferRequest {
    pub transfer_id: String,
    pub room_id: String,
    pub sender: AgentPubKey,
    pub receiver: AgentPubKey,
    pub file_name_ciphertext: String,
    pub file_size: u64,
    pub file_type_ciphertext: String,
    pub manifest_hash: String,
    pub integrity_hash: String,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct TransferRequestStatusEvent {
    pub request_action_hash: ActionHash,
    pub transfer_id: String,
    pub room_id: String,
    pub status: TransferRequestStatus,
    pub author: AgentPubKey,
    pub created_at: Timestamp,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    Room(Room),
    PresenceEvent(PresenceEvent),
    RoomMessage(RoomMessage),
    TransferRequest(TransferRequest),
    TransferRequestStatusEvent(TransferRequestStatusEvent),
}

#[hdk_link_types]
pub enum LinkTypes {
    RoomIdToRoom,
    RoomToPresence,
    RoomToMessage,
    RoomToTransferRequest,
    TransferRequestToStatus,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::StoreEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::Room(room) => validate_room(&room, &action.author),
            EntryTypes::PresenceEvent(event) => validate_presence(&event, &action.author),
            EntryTypes::RoomMessage(message) => validate_message(&message, &action.author),
            EntryTypes::TransferRequest(request) => {
                validate_transfer_request(&request, &action.author)
            }
            EntryTypes::TransferRequestStatusEvent(event) => {
                validate_status_event(&event, &action.author)
            }
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_room(room: &Room, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if !is_safe_id(&room.room_id, 8, 96) {
        return Ok(ValidateCallbackResult::Invalid(
            "room_id length or characters are invalid".into(),
        ));
    }
    if room.access_policy != "invitation_only" {
        return Ok(ValidateCallbackResult::Invalid(
            "unsupported room access_policy".into(),
        ));
    }
    if &room.created_by != author {
        return Ok(ValidateCallbackResult::Invalid(
            "Room.created_by must equal action author".into(),
        ));
    }
    if room.expires_at <= room.created_at {
        return Ok(ValidateCallbackResult::Invalid(
            "room expires_at must be after created_at".into(),
        ));
    }
    if room.room_label_ciphertext.len() > 2048 {
        return Ok(ValidateCallbackResult::Invalid(
            "room_label_ciphertext is too large".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_presence(
    event: &PresenceEvent,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    if !is_safe_id(&event.room_id, 8, 96) {
        return Ok(ValidateCallbackResult::Invalid(
            "presence room_id is invalid".into(),
        ));
    }
    if &event.agent != author {
        return Ok(ValidateCallbackResult::Invalid(
            "PresenceEvent.agent must equal action author".into(),
        ));
    }
    if event.expires_at <= event.created_at {
        return Ok(ValidateCallbackResult::Invalid(
            "presence expires_at must be after created_at".into(),
        ));
    }
    if event.avatar_seed_commitment.is_empty() || event.avatar_seed_commitment.len() > 256 {
        return Ok(ValidateCallbackResult::Invalid(
            "avatar_seed_commitment size is invalid".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_message(
    message: &RoomMessage,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    if !is_safe_id(&message.room_id, 8, 96) {
        return Ok(ValidateCallbackResult::Invalid(
            "message room_id is invalid".into(),
        ));
    }
    if &message.author != author {
        return Ok(ValidateCallbackResult::Invalid(
            "RoomMessage.author must equal action author".into(),
        ));
    }
    if message.ciphertext.is_empty() || message.ciphertext.len() > 4096 {
        return Ok(ValidateCallbackResult::Invalid(
            "message ciphertext size is invalid".into(),
        ));
    }
    if message.nonce.is_empty()
        || message.nonce.len() > 256
        || message.key_id.is_empty()
        || message.key_id.len() > 128
    {
        return Ok(ValidateCallbackResult::Invalid(
            "message nonce and key_id are required".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_transfer_request(
    request: &TransferRequest,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    if &request.sender != author {
        return Ok(ValidateCallbackResult::Invalid(
            "TransferRequest.sender must equal action author".into(),
        ));
    }
    if !is_safe_id(&request.transfer_id, 4, 128) || !is_safe_id(&request.room_id, 8, 96) {
        return Ok(ValidateCallbackResult::Invalid(
            "transfer_id and room_id are required".into(),
        ));
    }
    if request.file_size == 0 {
        return Ok(ValidateCallbackResult::Invalid(
            "file_size must be greater than zero".into(),
        ));
    }
    if request.file_name_ciphertext.is_empty() || request.file_name_ciphertext.len() > 2048 {
        return Ok(ValidateCallbackResult::Invalid(
            "file_name_ciphertext size is invalid".into(),
        ));
    }
    if request.file_type_ciphertext.len() > 512 {
        return Ok(ValidateCallbackResult::Invalid(
            "file_type_ciphertext is too large".into(),
        ));
    }
    if !is_hex_64(&request.manifest_hash) || !is_hex_64(&request.integrity_hash) {
        return Ok(ValidateCallbackResult::Invalid(
            "manifest_hash and integrity_hash must be SHA-256 hex".into(),
        ));
    }
    if request.expires_at <= request.created_at {
        return Ok(ValidateCallbackResult::Invalid(
            "transfer expires_at must be after created_at".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_status_event(
    event: &TransferRequestStatusEvent,
    author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    if &event.author != author {
        return Ok(ValidateCallbackResult::Invalid(
            "status event author must equal action author".into(),
        ));
    }
    if !is_safe_id(&event.transfer_id, 4, 128) || !is_safe_id(&event.room_id, 8, 96) {
        return Ok(ValidateCallbackResult::Invalid(
            "status event transfer_id and room_id are required".into(),
        ));
    }
    let record = must_get_valid_record(event.request_action_hash.clone())?;
    let request = record
        .entry()
        .to_app_option::<TransferRequest>()
        .map_err(|e| {
            wasm_error!(WasmErrorInner::Guest(format!(
                "decode transfer request: {e}"
            )))
        })?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("missing transfer request".into())))?;
    if request.transfer_id != event.transfer_id || request.room_id != event.room_id {
        return Ok(ValidateCallbackResult::Invalid(
            "status event must reference the matching transfer request".into(),
        ));
    }
    if !status_allowed_for_author(&request, author, &event.status) {
        return Ok(ValidateCallbackResult::Invalid(
            "status event author is not allowed for this status".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn status_allowed_for_author(
    request: &TransferRequest,
    author: &AgentPubKey,
    status: &TransferRequestStatus,
) -> bool {
    let is_sender = author == &request.sender;
    let is_receiver = author == &request.receiver;

    match status {
        TransferRequestStatus::Pending => is_sender,
        TransferRequestStatus::Accepted | TransferRequestStatus::Refused => is_receiver,
        TransferRequestStatus::Negotiating
        | TransferRequestStatus::Transferring
        | TransferRequestStatus::Expired
        | TransferRequestStatus::Failed => is_sender || is_receiver,
        TransferRequestStatus::Done => is_receiver,
        TransferRequestStatus::Revoked => is_sender,
    }
}

fn is_hex_64(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_safe_id(value: &str, min: usize, max: usize) -> bool {
    value.len() >= min
        && value.len() <= max
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':')
}
