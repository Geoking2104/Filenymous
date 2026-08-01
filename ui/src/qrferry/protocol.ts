/**
 * Optical (screen-to-camera) transfer protocol — "FNQR".
 *
 * Uses RaptorQ (RFC 6330) via WASM for fountain-code encoding/decoding,
 * with optional deflate compression. The FNQR framing carries metadata
 * in a descriptor frame and wraps individual RaptorQ packets in data frames.
 *
 * Frame layout (all integers little-endian):
 *   [0..4)   magic "FNQR"
 *   [4]      frame type: 0 = descriptor, 1 = data
 *   [5]      flags (bit0 = inline AES key, bit1 = ECIES-wrapped AES key,
 *                    bit2 = deflate compressed)
 *   [6..10)  sessionId (4 bytes, random per transfer)
 *
 *   descriptor body:
 *     fileSize            u32
 *     transmittedSize     u32  (size of the encrypted stream being split)
 *     symbolSize          u16
 *     totalPackets        u32
 *     fileCrc32           u32  (CRC32 of the original plaintext file)
 *     transmittedCrc32    u32  (CRC32 of the encrypted stream)
 *     nameLen u8 + name bytes (UTF-8)
 *     mimeLen u8 + mime bytes (UTF-8)
 *     keyLen  u8 + key bytes  (32 bytes inline, or 92-byte ECIES blob)
 *
 *   data body:
 *     sequence    u32
 *     raptorPayload  (symbolSize bytes — raw RaptorQ packet without its own header/CRC)
 *
 *   trailer (both frame kinds): CRC32 of everything before it, u32.
 */

const MAGIC = new Uint8Array([0x46, 0x4e, 0x51, 0x52]); // "FNQR"
const FRAME_DESCRIPTOR = 0;
const FRAME_DATA = 1;
const FLAG_KEY_INLINE = 1;
const FLAG_KEY_WRAPPED = 2;
const FLAG_COMPRESSED = 4;
const COMMON_HEADER_BYTES = 4 + 1 + 1 + 4; // magic + type + flags + sessionId
const DATA_HEADER_BYTES = 4; // sequence
const CRC_BYTES = 4;

export type KeyEncoding = "inline" | "wrapped";

export interface TransferMeta {
  sessionId: number;
  filename: string;
  mime: string;
  fileSize: number;
  transmittedSize: number;
  symbolSize: number;
  totalPackets: number;
  fileCrc32: number;
  transmittedCrc32: number;
  keyEncoding: KeyEncoding;
  compressed: boolean;
  /** Raw 32-byte AES key (inline) or 92-byte ECIES blob (wrapped) — see crypto/aes.ts and crypto/ecies.ts. */
  keyMaterial: Uint8Array;
}

export interface TransferSource {
  meta: TransferMeta;
  packets: Uint8Array[];
}

export interface Droplet {
  sequence: number;
  payload: Uint8Array;
}

export interface ReceiveResult {
  accepted: boolean;
  duplicate: boolean;
  complete: boolean;
  solved: number;
  total: number;
}

// ── CRC32 ─────────────────────────────────────────────────────────────────

let crcTable: Uint32Array | undefined;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[n] = value >>> 0;
  }
  return crcTable;
}

export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── RaptorQ WASM encoder ────────────────────────────────────────────────

let raptorQReady: Promise<void> | undefined;

async function ensureRaptorQ(): Promise<void> {
  if (!raptorQReady) {
    raptorQReady = import("@raptorqr/core/fec/raptorq_wasm").then(async (mod) => {
      await mod.ensureRaptorQWasm();
    });
  }
  await raptorQReady;
}

/**
 * Encode data using RaptorQ WASM and strip each packet's own header/CRC,
 * returning raw symbol payloads suitable for wrapping in FNQR data frames.
 *
 * @returns { packets: Uint8Array[], symbolSize: number, totalPackets: number, dataLength: number }
 */
export async function raptorQEncode(
  data: Uint8Array,
  maxSymbolSize: number,
  repairPercent: number,
): Promise<{ packets: Uint8Array[]; symbolSize: number; totalPackets: number; dataLength: number }> {
  await ensureRaptorQ();
  const { encodeRaptorQPackets } = await import("@raptorqr/core/fec/raptorq_wasm");
  const rawPackets = await encodeRaptorQPackets(data, maxSymbolSize, repairPercent);

  // Each rawPacket = [8-byte header] + [symbolSize bytes payload] + [4-byte CRC32C]
  // Strip header and CRC, keep only the payload for FNQR wrapping.
  const HEADER = 8;
  const CRC = 4;
  const packets = rawPackets.map((pkt) => pkt.slice(HEADER, pkt.length - CRC));

  return {
    packets,
    symbolSize: maxSymbolSize,
    totalPackets: packets.length,
    dataLength: data.length,
  };
}

// ── Transfer source creation ────────────────────────────────────────────

export function createTransferSource(
  encodedPackets: Uint8Array[],
  options: {
    filename: string;
    mime: string;
    fileSize: number;
    fileCrc32: number;
    symbolSize: number;
    transmittedSize: number;
    keyEncoding: KeyEncoding;
    keyMaterial: Uint8Array;
    compressed: boolean;
  },
): TransferSource {
  const meta: TransferMeta = {
    sessionId: (Math.random() * 0xffffffff) >>> 0,
    filename: options.filename,
    mime: options.mime,
    fileSize: options.fileSize,
    transmittedSize: options.transmittedSize,
    symbolSize: options.symbolSize,
    totalPackets: encodedPackets.length,
    fileCrc32: options.fileCrc32,
    transmittedCrc32: crc32(encodedPackets.reduce((acc, p) => {
      const merged = new Uint8Array(acc.length + p.length);
      merged.set(acc); merged.set(p, acc.length);
      return merged;
    }, new Uint8Array(0))),
    keyEncoding: options.keyEncoding,
    compressed: options.compressed,
    keyMaterial: options.keyMaterial,
  };
  return { meta, packets: encodedPackets };
}

export function getDroplet(source: TransferSource, sequence: number): Droplet {
  const idx = sequence % source.packets.length;
  return { sequence, payload: source.packets[idx] };
}

// ── Wire framing ─────────────────────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeCommonHeader(
  view: DataView,
  packet: Uint8Array,
  type: number,
  flags: number,
  sessionId: number,
): number {
  packet.set(MAGIC, 0);
  view.setUint8(4, type);
  view.setUint8(5, flags);
  view.setUint32(6, sessionId, true);
  return COMMON_HEADER_BYTES;
}

function finalize(packet: Uint8Array, end: number): Uint8Array {
  new DataView(packet.buffer).setUint32(end, crc32(packet.subarray(0, end)), true);
  return packet;
}

export function encodeDescriptor(meta: TransferMeta): Uint8Array {
  const nameBytes = textEncoder.encode(meta.filename).slice(0, 255);
  const mimeBytes = textEncoder.encode(meta.mime).slice(0, 255);
  const keyBytes = meta.keyMaterial;
  const size =
    COMMON_HEADER_BYTES +
    4 + 4 + 2 + 4 + 4 + 4 + // fileSize, transmittedSize, symbolSize, totalPackets, fileCrc32, transmittedCrc32
    1 + nameBytes.length +
    1 + mimeBytes.length +
    1 + keyBytes.length +
    CRC_BYTES;
  const packet = new Uint8Array(size);
  const view = new DataView(packet.buffer);
  let flags = meta.keyEncoding === "inline" ? FLAG_KEY_INLINE : FLAG_KEY_WRAPPED;
  if (meta.compressed) flags |= FLAG_COMPRESSED;
  let offset = writeCommonHeader(view, packet, FRAME_DESCRIPTOR, flags, meta.sessionId);
  view.setUint32(offset, meta.fileSize, true); offset += 4;
  view.setUint32(offset, meta.transmittedSize, true); offset += 4;
  view.setUint16(offset, meta.symbolSize, true); offset += 2;
  view.setUint32(offset, meta.totalPackets, true); offset += 4;
  view.setUint32(offset, meta.fileCrc32, true); offset += 4;
  view.setUint32(offset, meta.transmittedCrc32, true); offset += 4;
  view.setUint8(offset, nameBytes.length); offset += 1;
  packet.set(nameBytes, offset); offset += nameBytes.length;
  view.setUint8(offset, mimeBytes.length); offset += 1;
  packet.set(mimeBytes, offset); offset += mimeBytes.length;
  view.setUint8(offset, keyBytes.length); offset += 1;
  packet.set(keyBytes, offset); offset += keyBytes.length;
  return finalize(packet, offset);
}

export function encodeDataFrame(sessionId: number, droplet: Droplet): Uint8Array {
  const size = COMMON_HEADER_BYTES + DATA_HEADER_BYTES + droplet.payload.length + CRC_BYTES;
  const packet = new Uint8Array(size);
  const view = new DataView(packet.buffer);
  let offset = writeCommonHeader(view, packet, FRAME_DATA, 0, sessionId);
  view.setUint32(offset, droplet.sequence, true); offset += 4;
  packet.set(droplet.payload, offset); offset += droplet.payload.length;
  return finalize(packet, offset);
}

export type DecodedFrame =
  | { kind: "descriptor"; meta: TransferMeta }
  | { kind: "data"; sessionId: number; sequence: number; payload: Uint8Array };

export function decodeFrame(packet: Uint8Array): DecodedFrame {
  if (packet.length < COMMON_HEADER_BYTES + CRC_BYTES) {
    throw new Error("Truncated optical frame.");
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const crcOffset = packet.length - CRC_BYTES;
  const expected = view.getUint32(crcOffset, true);
  const actual = crc32(packet.subarray(0, crcOffset));
  if (expected !== actual) throw new Error("Frame checksum failed.");
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (packet[i] !== MAGIC[i]) throw new Error("Not a Filenymous optical frame.");
  }
  const type = view.getUint8(4);
  const flags = view.getUint8(5);
  const sessionId = view.getUint32(6, true);
  let offset = COMMON_HEADER_BYTES;

  if (type === FRAME_DESCRIPTOR) {
    const fileSize = view.getUint32(offset, true); offset += 4;
    const transmittedSize = view.getUint32(offset, true); offset += 4;
    const symbolSize = view.getUint16(offset, true); offset += 2;
    const totalPackets = view.getUint32(offset, true); offset += 4;
    const fileCrc32 = view.getUint32(offset, true); offset += 4;
    const transmittedCrc32 = view.getUint32(offset, true); offset += 4;
    const nameLen = view.getUint8(offset); offset += 1;
    const filename = textDecoder.decode(packet.subarray(offset, offset + nameLen)); offset += nameLen;
    const mimeLen = view.getUint8(offset); offset += 1;
    const mime = textDecoder.decode(packet.subarray(offset, offset + mimeLen)); offset += mimeLen;
    const keyLen = view.getUint8(offset); offset += 1;
    const keyMaterial = packet.slice(offset, offset + keyLen); offset += keyLen;
    if (symbolSize < 16 || totalPackets < 1) throw new Error("Invalid optical descriptor.");
    return {
      kind: "descriptor",
      meta: {
        sessionId,
        filename,
        mime,
        fileSize,
        transmittedSize,
        symbolSize,
        totalPackets,
        fileCrc32,
        transmittedCrc32,
        keyEncoding: (flags & FLAG_KEY_INLINE) !== 0 ? "inline" : "wrapped",
        compressed: (flags & FLAG_COMPRESSED) !== 0,
        keyMaterial,
      },
    };
  }

  if (type === FRAME_DATA) {
    const sequence = view.getUint32(offset, true); offset += 4;
    const payload = packet.slice(offset, crcOffset);
    return { kind: "data", sessionId, sequence, payload };
  }

  throw new Error("Unknown optical frame type.");
}

// ── Receiver-side RaptorQ decoder ───────────────────────────────────────

export class RaptorQDecoder {
  meta?: TransferMeta;
  private decoder: { push: (pkt: Uint8Array) => Uint8Array | null } | null = null;
  private readonly seenSequences = new Set<number>();
  private _solvedCount = 0;
  private _result: Uint8Array | null = null;

  get solvedCount() { return this._solvedCount; }
  get totalCount() { return this.meta?.totalPackets ?? 0; }
  get progress() { return this.totalCount === 0 ? 0 : this._solvedCount / this.totalCount; }
  get isComplete() { return this._result !== null; }

  async setMeta(meta: TransferMeta): Promise<void> {
    if (this.meta && this.meta.sessionId !== meta.sessionId) {
      throw new Error("Descriptor belongs to a different transfer.");
    }
    this.meta = meta;
    if (!this.decoder) {
      const { RaptorQWasmDecoder } = await import("@raptorqr/core/fec/raptorq_wasm");
      this.decoder = await RaptorQWasmDecoder.create(meta.transmittedSize, meta.symbolSize);
    }
  }

  receiveData(frame: { sessionId: number; sequence: number; payload: Uint8Array }): ReceiveResult {
    if (!this.meta) throw new Error("Waiting for the transfer descriptor.");
    if (this.meta.sessionId !== frame.sessionId) throw new Error("Frame belongs to a different transfer.");
    if (this._result !== null) {
      return { accepted: false, duplicate: true, complete: true, solved: this._solvedCount, total: this.totalCount };
    }
    if (this.seenSequences.has(frame.sequence)) {
      return { accepted: false, duplicate: true, complete: false, solved: this._solvedCount, total: this.totalCount };
    }
    this.seenSequences.add(frame.sequence);

    if (!this.decoder) throw new Error("Decoder not initialized.");

    // Reconstruct the full RaptorQ packet: 8-byte header + payload + 4-byte CRC
    const HEADER = 8;
    const CRC = 4;
    const fullPacket = new Uint8Array(HEADER + frame.payload.length + CRC);
    // Write minimal header: magic=0x51, packed_word, data_length
    fullPacket[0] = 0x51; // MAGIC_BYTE
    // packed_word: symbolIndex=31 (RAPTORQ_SYMBOL_INDEX), generationIndex=0, totalGenerations=totalPackets
    const totalGen = Math.min(this.meta.totalPackets, 0xfff);
    let word = 0;
    word |= (0 & 0xfff); // generationIndex
    word |= (totalGen & 0xfff) << 12;
    word |= (31 & 0x1f) << 24; // RAPTORQ_SYMBOL_INDEX
    word |= (1 << 30); // isLastGeneration
    fullPacket[1] = word & 0xff;
    fullPacket[2] = (word >>> 8) & 0xff;
    fullPacket[3] = (word >>> 16) & 0xff;
    fullPacket[4] = (word >>> 24) & 0xff;
    // data_length (24-bit LE)
    const dl = this.meta.transmittedSize;
    fullPacket[5] = dl & 0xff;
    fullPacket[6] = (dl >>> 8) & 0xff;
    fullPacket[7] = (dl >>> 16) & 0xff;
    // payload
    fullPacket.set(frame.payload, HEADER);
    // CRC32C placeholder (0) — the WASM decoder may or may not check it
    // We rely on the WASM decoder's internal validation instead.

    const result = this.decoder.push(fullPacket);
    if (result) {
      this._result = new Uint8Array(result);
      this._solvedCount = this.meta?.totalPackets ?? 0;
    } else {
      this._solvedCount = this.seenSequences.size;
    }

    return { accepted: true, duplicate: false, complete: this.isComplete, solved: this._solvedCount, total: this.totalCount };
  }

  /** Returns the reconstructed (still-encrypted) transmitted stream. Throws if incomplete or corrupt. */
  result(): Uint8Array {
    if (!this.meta || !this._result) throw new Error("Transfer is not complete yet.");
    const trimmed = this._result.slice(0, this.meta.transmittedSize);
    if (crc32(trimmed) !== this.meta.transmittedCrc32) {
      throw new Error("Transmitted stream checksum failed — likely optical corruption.");
    }
    return trimmed;
  }
}
