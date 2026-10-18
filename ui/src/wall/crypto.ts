/**
 * Sharewall key schedule, handshake and sealed DataChannel.
 *
 * base = key ‖ PBKDF2(password)?   (password bits only when the link says `p`)
 * per peer session sid (random, chosen by the peer):
 *   proof key = HKDF(base, "wall-proof:<wallId>:<sid>:<exp>:<flags>")
 *   up key    = HKDF(base, "wall-up:…")    peer → host
 *   down key  = HKDF(base, "wall-down:…")  host → peer
 *
 * After a mutual proof (`hello:<sid>` / `ready:<sid>`, as in Dropzones), every
 * DataChannel message is a sealed frame (AES-256-GCM, `sealChunk` format):
 * stream 0 carries JSON control messages, streams ≥ 1 carry item bytes. One key
 * per direction and a counter per stream: an IV is never reused, and frames
 * can't be reordered, replayed or moved between streams. File names, sizes and
 * texts are therefore encrypted end to end too, not only by WebRTC's DTLS.
 */
import { b64urlDecode, openChunk, sealChunk } from "../p2p/protocol";
import { checkProof, sealProof } from "../p2p/dropzone/crypto";
import { flagsOf, type WallParams } from "./link";

export { checkProof, sealProof };
export const WALL_PROTOCOL_VERSION = 1;
const PBKDF2_ITERATIONS = 200_000;
const enc = new TextEncoder();
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;

export type WallKeyParams = Pick<WallParams, "wallId" | "key" | "expiresAt" | "password" | "burn" | "hostLeave">;

export async function wallBaseMaterial(p: WallKeyParams, password?: string): Promise<Uint8Array> {
  const key = b64urlDecode(p.key);
  if (!p.password) return key;
  const material = await crypto.subtle.importKey("raw", buf(enc.encode((password ?? "").normalize("NFC"))), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", salt: buf(enc.encode(`filenymous-wall-pw:${p.wallId}`)), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, material, 256),
  );
  const out = new Uint8Array(key.length + bits.length);
  out.set(key);
  out.set(bits, key.length);
  return out;
}

export interface WallSessionKeys {
  proof: CryptoKey;
  up: CryptoKey;
  down: CryptoKey;
}

export async function deriveWallKeys(p: WallKeyParams, base: Uint8Array, sid: string): Promise<WallSessionKeys> {
  const ikm = await crypto.subtle.importKey("raw", buf(base), "HKDF", false, ["deriveKey"]);
  const ctx = `${p.wallId}:${sid}:${Math.floor(p.expiresAt / 1000)}:${flagsOf(p)}`;
  const derive = (label: string) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: buf(enc.encode("filenymous-wall-v1")), info: buf(enc.encode(`${label}:${ctx}`)) },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  const [proof, up, down] = await Promise.all([derive("wall-proof"), derive("wall-up"), derive("wall-down")]);
  return { proof, up, down };
}

/** Plain (pre-key-confirmation) handshake messages: they carry no content. */
export type WallHandshake =
  | { type: "wall-hello"; v: number; sid: string; proof: string }
  | { type: "wall-ready"; proof: string }
  | { type: "wall-reject"; reason: "bad-password" | "full" | "closed" | "protocol" };

export function parseHandshake(text: string): WallHandshake | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const str = (v: unknown, max = 512) => typeof v === "string" && v.length > 0 && v.length <= max;
  if (m.type === "wall-hello") return m.v === WALL_PROTOCOL_VERSION && str(m.sid, 64) && str(m.proof) ? (m as WallHandshake) : null;
  if (m.type === "wall-ready") return str(m.proof) ? (m as WallHandshake) : null;
  if (m.type === "wall-reject") return ["bad-password", "full", "closed", "protocol"].includes(m.reason as string) ? (m as WallHandshake) : null;
  return null;
}

export const CONTROL_STREAM = 0;

/**
 * Encrypts/decrypts one direction pair of a DataChannel. Frames must arrive in
 * order per stream (ordered channel): any gap, replay or forged frame throws.
 */
export class SealedPipe {
  private sendSeq = new Map<number, number>();
  private recvSeq = new Map<number, number>();

  constructor(
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
  ) {}

  private next(map: Map<number, number>, stream: number): number {
    const n = map.get(stream) ?? 0;
    map.set(stream, n + 1);
    return n;
  }

  sealControl(msg: unknown): Promise<ArrayBuffer> {
    return sealChunk(this.sendKey, CONTROL_STREAM, this.next(this.sendSeq, CONTROL_STREAM), enc.encode(JSON.stringify(msg)));
  }

  sealData(stream: number, bytes: Uint8Array): Promise<ArrayBuffer> {
    if (!(stream >= 1 && stream < 2 ** 31)) throw new Error("bad-stream");
    return sealChunk(this.sendKey, stream, this.next(this.sendSeq, stream), bytes);
  }

  /** Index of the data chunk that would be sent next on `stream`. */
  sentChunks(stream: number): number {
    return this.sendSeq.get(stream) ?? 0;
  }

  async open(frame: ArrayBuffer): Promise<{ stream: number; index: number; control?: unknown; bytes?: Uint8Array }> {
    const { fileIndex, chunkIndex, plain } = await openChunk(this.recvKey, frame);
    const expected = this.recvSeq.get(fileIndex) ?? 0;
    if (chunkIndex !== expected) throw new Error("out-of-order");
    this.recvSeq.set(fileIndex, expected + 1);
    if (fileIndex === CONTROL_STREAM) return { stream: 0, index: chunkIndex, control: JSON.parse(new TextDecoder().decode(plain)) };
    return { stream: fileIndex, index: chunkIndex, bytes: plain };
  }
}
