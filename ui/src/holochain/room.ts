import type { ActionHash } from "@holochain/client";
import { callZome } from "./client";
import type {
  CreateRoomInput,
  CreateTransferRequestInput,
  HoloRoomSnapshot,
  HoloTransferRequestWithStatus,
  PublishPresenceInput,
  SendRoomMessageInput,
  UpdateTransferRequestStatusInput,
} from "./types";

export const roomZome = {
  createRoom(input: CreateRoomInput): Promise<{ room_id: string; action_hash: ActionHash }> {
    return callZome("room", "create_room", input);
  },

  publishPresence(input: PublishPresenceInput): Promise<ActionHash> {
    return callZome("room", "publish_presence", input);
  },

  sendRoomMessage(input: SendRoomMessageInput): Promise<ActionHash> {
    return callZome("room", "send_room_message", input);
  },

  createTransferRequest(input: CreateTransferRequestInput): Promise<HoloTransferRequestWithStatus> {
    return callZome("room", "create_transfer_request", input);
  },

  updateTransferRequestStatus(input: UpdateTransferRequestStatusInput): Promise<ActionHash> {
    return callZome("room", "update_transfer_request_status", input);
  },

  getRoomSnapshot(roomId: string): Promise<HoloRoomSnapshot> {
    return callZome("room", "get_room_snapshot", roomId);
  },
};
