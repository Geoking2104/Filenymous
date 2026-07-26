export type RoomRuntimeMode = "holo-web" | "websocket" | "web-standalone";

export type PresenceStatus = "online" | "idle" | "leaving";

/** Private = invite-gated to selected contacts; Public = open catalog for a chosen duration */
export type RoomKind = "private" | "public";

export type RoomDurationKey = "1h" | "6h" | "24h" | "7d" | "30d" | "session";

export interface RoomPeer {
  peerId: string;
  displayName: string;
  avatarSeed: string;
  status: PresenceStatus;
  lastSeenMs: number;
  expiresAtMs: number;
  /** Optional contact claim (email / phone) for private-room ACL */
  contact?: string;
}

export interface RoomAllowedContact {
  contact: string; // email or E.164 phone
  hash?: string;
}

export interface RoomConfig {
  roomId: string;
  inviteCode: string;
  kind: RoomKind;
  /** Private: only these contacts + invite code may join */
  allowedContacts: RoomAllowedContact[];
  /** Public: how long the open library stays visible */
  durationKey: RoomDurationKey;
  /** Absolute expiry for public rooms (0 = session-only / until tab closes) */
  expiresAtMs: number;
  createdAtMs: number;
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

/**
 * Live open-library entry (eMule-inspired shared files).
 * Session-scoped: visible to peers in the room while the browser tab stays open.
 * No plugin — pure browser discovery + on-demand P2P transfer.
 */
export interface RoomSharedFile {
  shareId: string;
  roomId: string;
  ownerId: string;
  ownerName: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** Local File handle stays only on the owner's device */
  localOnly: boolean;
  addedAtMs: number;
}

export interface RoomHistorySnapshot {
  rooms: Array<{ roomId: string; inviteCode: string; lastOpenedMs: number; kind?: RoomKind }>;
  peers: RoomPeer[];
  messages: RoomMessage[];
  transfers: RoomTransferRequest[];
  sharedFiles?: RoomSharedFile[];
}

export const ROOM_DURATION_MS: Record<RoomDurationKey, number> = {
  "1h": 1 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  session: 0,
};

export function computeRoomExpiry(durationKey: RoomDurationKey, now = Date.now()): number {
  const ms = ROOM_DURATION_MS[durationKey];
  return ms > 0 ? now + ms : 0;
}
