use hdk::prelude::*;
use room_integrity::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateRoomInput {
    pub room_id: String,
    pub expires_at: i64,
    pub access_policy: String,
    pub room_label_ciphertext: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PublishPresenceInput {
    pub room_id: String,
    pub status: PresenceStatus,
    pub avatar_seed_commitment: String,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SendRoomMessageInput {
    pub room_id: String,
    pub ciphertext: String,
    pub nonce: String,
    pub key_id: String,
    pub previous_message_hash: Option<EntryHash>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateTransferRequestInput {
    pub transfer_id: String,
    pub room_id: String,
    pub receiver: AgentPubKey,
    pub file_name_ciphertext: String,
    pub file_size: u64,
    pub file_type_ciphertext: String,
    pub manifest_hash: String,
    pub integrity_hash: String,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateTransferRequestStatusInput {
    pub transfer_id: String,
    pub room_id: String,
    pub status: TransferRequestStatus,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RoomSnapshot {
    pub rooms: Vec<Room>,
    pub presences: Vec<PresenceEvent>,
    pub messages: Vec<RoomMessage>,
    pub transfer_requests: Vec<TransferRequestWithStatus>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TransferRequestWithStatus {
    pub request: TransferRequest,
    pub status: TransferRequestStatus,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RoomOutput {
    pub room_id: String,
    pub action_hash: ActionHash,
}

#[hdk_extern]
pub fn create_room(input: CreateRoomInput) -> ExternResult<RoomOutput> {
    let agent = agent_info()?.agent_initial_pubkey;
    let room = Room {
        room_id: input.room_id.clone(),
        created_by: agent,
        created_at: sys_time()?,
        expires_at: Timestamp::from_micros(input.expires_at),
        access_policy: input.access_policy,
        room_label_ciphertext: input.room_label_ciphertext,
    };
    let action_hash = create_entry(EntryTypes::Room(room.clone()))?;
    create_link(
        room_anchor(&room.room_id)?,
        action_hash.clone(),
        LinkTypes::RoomIdToRoom,
        (),
    )?;
    Ok(RoomOutput {
        room_id: room.room_id,
        action_hash,
    })
}

#[hdk_extern]
pub fn publish_presence(input: PublishPresenceInput) -> ExternResult<ActionHash> {
    let agent = agent_info()?.agent_initial_pubkey;
    let event = PresenceEvent {
        room_id: input.room_id.clone(),
        agent,
        status: input.status,
        avatar_seed_commitment: input.avatar_seed_commitment,
        created_at: sys_time()?,
        expires_at: Timestamp::from_micros(input.expires_at),
    };
    let action_hash = create_entry(EntryTypes::PresenceEvent(event))?;
    create_link(
        room_anchor(&input.room_id)?,
        action_hash.clone(),
        LinkTypes::RoomToPresence,
        (),
    )?;
    Ok(action_hash)
}

#[hdk_extern]
pub fn send_room_message(input: SendRoomMessageInput) -> ExternResult<ActionHash> {
    let message = RoomMessage {
        room_id: input.room_id.clone(),
        author: agent_info()?.agent_initial_pubkey,
        ciphertext: input.ciphertext,
        nonce: input.nonce,
        key_id: input.key_id,
        created_at: sys_time()?,
        previous_message_hash: input.previous_message_hash,
    };
    let action_hash = create_entry(EntryTypes::RoomMessage(message))?;
    create_link(
        room_anchor(&input.room_id)?,
        action_hash.clone(),
        LinkTypes::RoomToMessage,
        (),
    )?;
    Ok(action_hash)
}

#[hdk_extern]
pub fn create_transfer_request(
    input: CreateTransferRequestInput,
) -> ExternResult<TransferRequestWithStatus> {
    let request = TransferRequest {
        transfer_id: input.transfer_id,
        room_id: input.room_id.clone(),
        sender: agent_info()?.agent_initial_pubkey,
        receiver: input.receiver,
        file_name_ciphertext: input.file_name_ciphertext,
        file_size: input.file_size,
        file_type_ciphertext: input.file_type_ciphertext,
        manifest_hash: input.manifest_hash,
        integrity_hash: input.integrity_hash,
        created_at: sys_time()?,
        expires_at: Timestamp::from_micros(input.expires_at),
    };
    let action_hash = create_entry(EntryTypes::TransferRequest(request.clone()))?;
    create_link(
        room_anchor(&input.room_id)?,
        action_hash.clone(),
        LinkTypes::RoomToTransferRequest,
        (),
    )?;
    create_status_event(
        &action_hash,
        &request.transfer_id,
        &request.room_id,
        TransferRequestStatus::Pending,
    )?;
    Ok(TransferRequestWithStatus {
        request,
        status: TransferRequestStatus::Pending,
    })
}

#[hdk_extern]
pub fn update_transfer_request_status(
    input: UpdateTransferRequestStatusInput,
) -> ExternResult<ActionHash> {
    let (request_action_hash, request) = find_transfer_request(&input.room_id, &input.transfer_id)?
        .ok_or_else(|| wasm_error!(WasmErrorInner::Guest("transfer request not found".into())))?;
    let current = latest_status(&input.transfer_id)?;
    let actor = agent_info()?.agent_initial_pubkey;
    if !can_transition(&request, &actor, &current, &input.status) {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "transfer status transition is not allowed".into(),
        )));
    }
    create_status_event(
        &request_action_hash,
        &input.transfer_id,
        &input.room_id,
        input.status,
    )
}

#[hdk_extern]
pub fn get_room_snapshot(room_id: String) -> ExternResult<RoomSnapshot> {
    Ok(RoomSnapshot {
        rooms: collect_entries::<Room>(room_anchor(&room_id)?, LinkTypes::RoomIdToRoom)?,
        presences: collect_entries::<PresenceEvent>(
            room_anchor(&room_id)?,
            LinkTypes::RoomToPresence,
        )?,
        messages: collect_entries::<RoomMessage>(room_anchor(&room_id)?, LinkTypes::RoomToMessage)?,
        transfer_requests: collect_transfer_requests(&room_id)?,
    })
}

fn create_status_event(
    request_action_hash: &ActionHash,
    transfer_id: &str,
    room_id: &str,
    status: TransferRequestStatus,
) -> ExternResult<ActionHash> {
    let event = TransferRequestStatusEvent {
        request_action_hash: request_action_hash.clone(),
        transfer_id: transfer_id.to_string(),
        room_id: room_id.to_string(),
        status,
        author: agent_info()?.agent_initial_pubkey,
        created_at: sys_time()?,
    };
    let action_hash = create_entry(EntryTypes::TransferRequestStatusEvent(event))?;
    create_link(
        status_anchor(transfer_id)?,
        action_hash.clone(),
        LinkTypes::TransferRequestToStatus,
        (),
    )?;
    Ok(action_hash)
}

fn collect_transfer_requests(room_id: &str) -> ExternResult<Vec<TransferRequestWithStatus>> {
    let requests = collect_entries::<TransferRequest>(
        room_anchor(room_id)?,
        LinkTypes::RoomToTransferRequest,
    )?;
    let mut out = Vec::new();
    for request in requests {
        out.push(TransferRequestWithStatus {
            status: latest_status(&request.transfer_id)?,
            request,
        });
    }
    Ok(out)
}

fn find_transfer_request(
    room_id: &str,
    transfer_id: &str,
) -> ExternResult<Option<(ActionHash, TransferRequest)>> {
    for link in get_links(
        LinkQuery::try_new(room_anchor(room_id)?, LinkTypes::RoomToTransferRequest)?,
        GetStrategy::default(),
    )? {
        if let Ok(action_hash) = ActionHash::try_from(link.target) {
            if let Some(record) = get(action_hash.clone(), GetOptions::default())? {
                if let Some(request) = record
                    .entry()
                    .to_app_option::<TransferRequest>()
                    .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("decode entry: {e}"))))?
                {
                    if request.transfer_id == transfer_id {
                        return Ok(Some((action_hash, request)));
                    }
                }
            }
        }
    }
    Ok(None)
}

fn latest_status(transfer_id: &str) -> ExternResult<TransferRequestStatus> {
    let events = collect_entries::<TransferRequestStatusEvent>(
        status_anchor(transfer_id)?,
        LinkTypes::TransferRequestToStatus,
    )?;
    Ok(events
        .iter()
        .max_by_key(|event| event.created_at.as_micros())
        .map(|event| event.status.clone())
        .unwrap_or(TransferRequestStatus::Pending))
}

fn can_transition(
    request: &TransferRequest,
    actor: &AgentPubKey,
    from: &TransferRequestStatus,
    to: &TransferRequestStatus,
) -> bool {
    let is_sender = actor == &request.sender;
    let is_receiver = actor == &request.receiver;

    match (from, to) {
        (TransferRequestStatus::Pending, TransferRequestStatus::Accepted) => is_receiver,
        (TransferRequestStatus::Pending, TransferRequestStatus::Refused) => is_receiver,
        (TransferRequestStatus::Pending, TransferRequestStatus::Revoked) => is_sender,
        (TransferRequestStatus::Pending, TransferRequestStatus::Expired) => {
            is_sender || is_receiver
        }
        (TransferRequestStatus::Accepted, TransferRequestStatus::Negotiating) => {
            is_sender || is_receiver
        }
        (TransferRequestStatus::Accepted, TransferRequestStatus::Revoked) => is_sender,
        (TransferRequestStatus::Negotiating, TransferRequestStatus::Transferring) => {
            is_sender || is_receiver
        }
        (TransferRequestStatus::Negotiating, TransferRequestStatus::Failed) => {
            is_sender || is_receiver
        }
        (TransferRequestStatus::Negotiating, TransferRequestStatus::Revoked) => is_sender,
        (TransferRequestStatus::Transferring, TransferRequestStatus::Done) => is_receiver,
        (TransferRequestStatus::Transferring, TransferRequestStatus::Failed) => {
            is_sender || is_receiver
        }
        (TransferRequestStatus::Transferring, TransferRequestStatus::Revoked) => is_sender,
        (TransferRequestStatus::Failed, TransferRequestStatus::Pending) => is_sender,
        _ => false,
    }
}

fn collect_entries<T>(base: AnyLinkableHash, link_type: LinkTypes) -> ExternResult<Vec<T>>
where
    T: TryFrom<SerializedBytes, Error = SerializedBytesError>,
{
    let links = get_links(LinkQuery::try_new(base, link_type)?, GetStrategy::default())?;
    let mut out = Vec::new();
    for link in links {
        if let Ok(action_hash) = ActionHash::try_from(link.target) {
            if let Some(record) = get(action_hash, GetOptions::default())? {
                if let Some(entry) = record
                    .entry()
                    .to_app_option::<T>()
                    .map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("decode entry: {e}"))))?
                {
                    out.push(entry);
                }
            }
        }
    }
    Ok(out)
}

fn room_anchor(room_id: &str) -> ExternResult<AnyLinkableHash> {
    Ok(Path::from(format!("rooms.{room_id}"))
        .path_entry_hash()?
        .into())
}

fn status_anchor(transfer_id: &str) -> ExternResult<AnyLinkableHash> {
    Ok(Path::from(format!("rooms.transfer_status.{transfer_id}"))
        .path_entry_hash()?
        .into())
}
