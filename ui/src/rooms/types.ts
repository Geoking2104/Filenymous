export type RoomRuntimeMode = "holo-web" | "websocket" | "web-standalone";

export type PresenceStatus = "online" | "idle" | "leaving";

export interface RoomPeer {
  peerId: string;
  displayName: string;
  avatarSeed: string;
  status: PresenceStatus;
  lastSeenMs: number;
  expiresAtMs: number;
}

export interface RoomMessage {
  messageId: string;
  roomId: string;
  authorId: string;
  ciphertextB64: string;
  nonceB64: string;
  keyId: string;
  createdAtMs: number;
}

export type TransferRequestStatus =
  | "pending"
  | "accepted"
  | "refused"
  | "negotiating"
  | "transferring"
  | "done"
  | "revoked"
  | "expired"
  | "failed";

export type TransferActor = "sender" | "receiver" | "system";

export interface RoomTransferRequest {
  transferId: string;
  roomId: string;
  senderId: string;
  receiverId: string;
  fileNameCiphertext: string;
  fileSize: number;
  manifestHash: string;
  integrityHash: string;
  status: TransferRequestStatus;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface RoomHistorySnapshot {
  rooms: Array<{ roomId: string; inviteCode: string; lastOpenedMs: number }>;
  peers: RoomPeer[];
  messages: RoomMessage[];
  transfers: RoomTransferRequest[];
}
