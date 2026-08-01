import { describe, expect, it } from "vitest";
import {
  crc32,
  decodeFrame,
  encodeDataFrame,
  encodeDescriptor,
  getDroplet,
  createTransferSource,
} from "./protocol";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)));
  }
  return bytes;
}

describe("optical transfer protocol", () => {
  it("crc32 produces deterministic checksums", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const a = crc32(data);
    const b = crc32(data);
    expect(a).toBe(b);
    expect(typeof a).toBe("number");
  });

  it("encodes and decodes a descriptor frame round-trip", () => {
    const keyMaterial = randomBytes(32);
    const meta = {
      sessionId: 0xdeadbeef,
      filename: "photo.jpg",
      mime: "image/jpeg",
      fileSize: 1024,
      transmittedSize: 1060,
      symbolSize: 220,
      totalPackets: 5,
      fileCrc32: crc32(new Uint8Array(1024)),
      transmittedCrc32: crc32(new Uint8Array(1060)),
      keyEncoding: "inline" as const,
      compressed: false,
      keyMaterial,
    };
    const packet = encodeDescriptor(meta);
    const frame = decodeFrame(packet);
    if (frame.kind !== "descriptor") throw new Error("expected descriptor");
    expect(frame.meta.sessionId).toBe(0xdeadbeef);
    expect(frame.meta.filename).toBe("photo.jpg");
    expect(frame.meta.mime).toBe("image/jpeg");
    expect(frame.meta.fileSize).toBe(1024);
    expect(frame.meta.symbolSize).toBe(220);
    expect(frame.meta.totalPackets).toBe(5);
    expect(frame.meta.keyEncoding).toBe("inline");
    expect(frame.meta.compressed).toBe(false);
    expect(frame.meta.keyMaterial).toEqual(keyMaterial);
  });

  it("encodes and decodes a data frame round-trip", () => {
    const sessionId = 0x12345678;
    const payload = randomBytes(200);
    const droplet = { sequence: 42, payload };
    const packet = encodeDataFrame(sessionId, droplet);
    const frame = decodeFrame(packet);
    if (frame.kind !== "data") throw new Error("expected data frame");
    expect(frame.sessionId).toBe(sessionId);
    expect(frame.sequence).toBe(42);
    expect(frame.payload).toEqual(payload);
  });

  it("rejects a frame whose CRC32 trailer was corrupted", () => {
    const packet = encodeDataFrame(1, { sequence: 0, payload: randomBytes(64) });
    packet[packet.length - 1] ^= 0xff;
    expect(() => decodeFrame(packet)).toThrow(/checksum/i);
  });

  it("rejects a payload that isn't a Filenymous optical frame", () => {
    const bogus = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(() => decodeFrame(bogus)).toThrow();
  });

  it("carries an ECIES-wrapped key blob (92 bytes) end to end through the descriptor frame", () => {
    const wrappedKey = randomBytes(92);
    const meta = {
      sessionId: 999,
      filename: "secret.txt",
      mime: "text/plain",
      fileSize: 100,
      transmittedSize: 112,
      symbolSize: 220,
      totalPackets: 1,
      fileCrc32: crc32(new Uint8Array(100)),
      transmittedCrc32: crc32(new Uint8Array(112)),
      keyEncoding: "wrapped" as const,
      compressed: false,
      keyMaterial: wrappedKey,
    };
    const packet = encodeDescriptor(meta);
    const frame = decodeFrame(packet);
    if (frame.kind !== "descriptor") throw new Error("expected descriptor");
    expect(frame.meta.keyEncoding).toBe("wrapped");
    expect(frame.meta.keyMaterial).toEqual(wrappedKey);
  });

  it("carries compression flag through the descriptor frame", () => {
    const meta = {
      sessionId: 777,
      filename: "data.bin",
      mime: "application/octet-stream",
      fileSize: 500,
      transmittedSize: 420,
      symbolSize: 220,
      totalPackets: 2,
      fileCrc32: crc32(new Uint8Array(500)),
      transmittedCrc32: crc32(new Uint8Array(420)),
      keyEncoding: "inline" as const,
      compressed: true,
      keyMaterial: randomBytes(32),
    };
    const packet = encodeDescriptor(meta);
    const frame = decodeFrame(packet);
    if (frame.kind !== "descriptor") throw new Error("expected descriptor");
    expect(frame.meta.compressed).toBe(true);
  });

  it("createTransferSource builds correct metadata from pre-encoded packets", () => {
    const packets = [randomBytes(200), randomBytes(200), randomBytes(200)];
    const source = createTransferSource(packets, {
      filename: "test.bin",
      mime: "application/octet-stream",
      fileSize: 500,
      fileCrc32: crc32(new Uint8Array(500)),
      symbolSize: 220,
      transmittedSize: 500,
      keyEncoding: "inline",
      keyMaterial: randomBytes(32),
      compressed: false,
    });
    expect(source.meta.totalPackets).toBe(3);
    expect(source.meta.symbolSize).toBe(220);
    expect(source.packets).toHaveLength(3);
  });

  it("getDroplet cycles through source packets", () => {
    const packets = [randomBytes(200), randomBytes(200)];
    const source = createTransferSource(packets, {
      filename: "t.bin",
      mime: "application/octet-stream",
      fileSize: 300,
      fileCrc32: 0,
      symbolSize: 220,
      transmittedSize: 300,
      keyEncoding: "inline",
      keyMaterial: randomBytes(32),
      compressed: false,
    });
    const d0 = getDroplet(source, 0);
    const d1 = getDroplet(source, 1);
    const d2 = getDroplet(source, 2); // wraps around
    expect(d0.payload).toEqual(packets[0]);
    expect(d1.payload).toEqual(packets[1]);
    expect(d2.payload).toEqual(packets[0]); // wraps
  });
});
