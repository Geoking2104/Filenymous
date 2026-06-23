import type { TransferActor, TransferRequestStatus } from "./types";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createInviteCode(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(12))): string {
  let out = "";
  for (let i = 0; i < 12; i += 1) out += INVITE_ALPHABET[bytes[i % bytes.length] % INVITE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

export function normalizeInviteCode(value: string): string {
  return value
    .toUpperCase()
    .split("")
    .filter((char) => INVITE_ALPHABET.includes(char))
    .join("")
    .replace(/(.{4})(?=.)/g, "$1-")
    .slice(0, 14);
}

export function isPresenceActive(input: { expiresAtMs: number }, nowMs = Date.now()): boolean {
  return input.expiresAtMs > nowMs;
}

export function sanitizeRoomText(value: string, maxLength = 500): string {
  return value
    .slice(0, maxLength)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function canTransitionTransferStatus(
  from: TransferRequestStatus,
  to: TransferRequestStatus,
  actor: TransferActor,
): boolean {
  const allowed: Record<TransferRequestStatus, Partial<Record<TransferActor, TransferRequestStatus[]>>> = {
    pending: { receiver: ["accepted", "refused"], sender: ["revoked"], system: ["expired"] },
    accepted: { system: ["negotiating"], sender: ["revoked"] },
    refused: {},
    negotiating: { system: ["transferring", "failed"], sender: ["revoked"] },
    transferring: { system: ["done", "failed"], sender: ["revoked"] },
    done: {},
    revoked: {},
    expired: {},
    failed: { sender: ["pending"] },
  };
  return allowed[from][actor]?.includes(to) ?? false;
}

export function roomAvatarInitials(displayName: string, peerId: string): string {
  const base = (displayName.trim() || peerId).replace(/[^a-zA-Z ]/g, " ").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  const initials = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : base.slice(0, 2);
  return initials.toUpperCase().padEnd(2, "X");
}
