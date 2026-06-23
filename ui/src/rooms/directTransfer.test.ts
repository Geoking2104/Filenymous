import { describe, expect, it } from "vitest";
import {
  DIRECT_CHUNK_MAX_BYTES,
  assertAllowedSignalPayload,
  buildChunkEnvelope,
  computeSha256Hex,
  verifyChunkEnvelope,
} from "./directTransfer";

describe("direct transfer protocol", () => {
  it("allows only WebRTC negotiation payloads through the signal layer", () => {
    expect(() => assertAllowedSignalPayload({ kind: "offer", sdp: "x" })).not.toThrow();
    expect(() => assertAllowedSignalPayload({ kind: "answer", sdp: "x" })).not.toThrow();
    expect(() => assertAllowedSignalPayload({ kind: "ice", candidate: { candidate: "x" } })).not.toThrow();
    expect(() => assertAllowedSignalPayload({ kind: "chat", text: "secret" })).toThrow("unsupported signal payload");
    expect(() => assertAllowedSignalPayload({ kind: "chunk", bytes: [1, 2, 3] })).toThrow("unsupported signal payload");
  });

  it("rejects oversized negotiation payloads", () => {
    expect(() => assertAllowedSignalPayload({ kind: "offer", sdp: "x".repeat(129 * 1024) })).toThrow(
      "unsupported signal payload",
    );
  });

  it("rejects extra fields on allowed signal payloads", () => {
    expect(() => assertAllowedSignalPayload({ kind: "offer", sdp: "x", fileBytes: [1, 2, 3] })).toThrow(
      "unsupported signal payload",
    );
    expect(() => assertAllowedSignalPayload({ kind: "answer", sdp: "x", chat: "secret" })).toThrow(
      "unsupported signal payload",
    );
    expect(() =>
      assertAllowedSignalPayload({ kind: "ice", candidate: { candidate: "x" }, fileBytes: [1, 2, 3] }),
    ).toThrow("unsupported signal payload");
  });

  it("rejects arbitrary or oversized ICE payloads", () => {
    expect(() => assertAllowedSignalPayload({ kind: "ice", candidate: [] })).toThrow("unsupported signal payload");
    expect(() => assertAllowedSignalPayload({ kind: "ice", candidate: { candidate: "x", chat: "secret" } })).toThrow(
      "unsupported signal payload",
    );
    expect(() => assertAllowedSignalPayload({ kind: "ice", candidate: { candidate: "x".repeat(17 * 1024) } })).toThrow(
      "unsupported signal payload",
    );
  });

  it("detects altered chunk envelopes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const envelope = await buildChunkEnvelope("transfer-a", 0, bytes);

    await expect(verifyChunkEnvelope(envelope, bytes)).resolves.toBe(true);
    await expect(verifyChunkEnvelope(envelope, new Uint8Array([1, 2, 3, 5]))).resolves.toBe(false);
  });

  it("rejects invalid chunk envelopes and oversized chunks", async () => {
    await expect(buildChunkEnvelope("transfer-a", -1, new Uint8Array([1]))).rejects.toThrow("invalid chunk index");
    await expect(buildChunkEnvelope("transfer-a", 0, new Uint8Array(DIRECT_CHUNK_MAX_BYTES + 1))).rejects.toThrow(
      "invalid chunk size",
    );

    const envelope = await buildChunkEnvelope("transfer-a", 0, new Uint8Array([1]));
    await expect(verifyChunkEnvelope({ ...envelope, sha256Hex: "nope" }, new Uint8Array([1]))).resolves.toBe(false);
  });

  it("computes lowercase SHA-256 hex", async () => {
    await expect(computeSha256Hex(new Uint8Array([1, 2, 3]))).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
});
