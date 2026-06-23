export const DIRECT_CHUNK_MAX_BYTES = 256 * 1024;
const MAX_SDP_BYTES = 128 * 1024;
const MAX_ICE_CANDIDATE_BYTES = 16 * 1024;
const MAX_TRANSFER_ID_LENGTH = 128;

export type SignalPayload =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: unknown };

export interface ChunkEnvelope {
  transferId: string;
  index: number;
  sha256Hex: string;
  byteLength: number;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSdp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= MAX_SDP_BYTES;
}

function isValidTransferId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TRANSFER_ID_LENGTH && /^[a-zA-Z0-9:_-]+$/.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isValidIceCandidate(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  if (!hasOnlyKeys(value, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])) return false;
  if (typeof value.candidate !== "string" || value.candidate.length === 0) return false;
  if (byteLength(value.candidate) > MAX_ICE_CANDIDATE_BYTES) return false;
  if ("sdpMid" in value && value.sdpMid !== null && typeof value.sdpMid !== "string") return false;
  if ("sdpMLineIndex" in value && value.sdpMLineIndex !== null && !Number.isSafeInteger(value.sdpMLineIndex)) return false;
  if ("usernameFragment" in value && value.usernameFragment !== null && typeof value.usernameFragment !== "string") {
    return false;
  }
  return true;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function assertAllowedSignalPayload(payload: unknown): asserts payload is SignalPayload {
  if (!isObject(payload) || !("kind" in payload)) {
    throw new Error("unsupported signal payload");
  }

  const kind = payload.kind;
  if ((kind === "offer" || kind === "answer") && hasOnlyKeys(payload, ["kind", "sdp"]) && isValidSdp(payload.sdp)) {
    return;
  }
  if (kind === "ice" && hasOnlyKeys(payload, ["kind", "candidate"]) && isValidIceCandidate(payload.candidate)) return;

  throw new Error("unsupported signal payload");
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", toBuffer(bytes)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildChunkEnvelope(
  transferId: string,
  index: number,
  bytes: Uint8Array,
): Promise<ChunkEnvelope> {
  if (!isValidTransferId(transferId)) throw new Error("invalid transfer id");
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("invalid chunk index");
  if (bytes.byteLength === 0 || bytes.byteLength > DIRECT_CHUNK_MAX_BYTES) throw new Error("invalid chunk size");

  return {
    transferId,
    index,
    sha256Hex: await computeSha256Hex(bytes),
    byteLength: bytes.byteLength,
  };
}

export async function verifyChunkEnvelope(envelope: ChunkEnvelope, bytes: Uint8Array): Promise<boolean> {
  if (!isValidTransferId(envelope.transferId)) return false;
  if (!Number.isSafeInteger(envelope.index) || envelope.index < 0) return false;
  if (envelope.byteLength !== bytes.byteLength) return false;
  if (bytes.byteLength === 0 || bytes.byteLength > DIRECT_CHUNK_MAX_BYTES) return false;
  if (!/^[a-f0-9]{64}$/.test(envelope.sha256Hex)) return false;

  return envelope.sha256Hex === await computeSha256Hex(bytes);
}
