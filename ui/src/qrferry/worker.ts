/**
 * Web Worker for RaptorQ encoding/decoding.
 *
 * Offloads the CPU-intensive RaptorQ WASM operations off the main thread.
 * Communicates via postMessage with a simple request/response protocol.
 */

import { crc32, createTransferSource, raptorQEncode } from "./protocol";

interface EncodeRequest {
  type: "encode";
  id: number;
  data: Uint8Array;
  maxSymbolSize: number;
  repairPercent: number;
  meta: {
    filename: string;
    mime: string;
    fileSize: number;
    keyEncoding: "inline" | "wrapped";
    keyMaterial: Uint8Array;
    compressed: boolean;
  };
}

interface DecodeInitRequest {
  type: "decode-init";
  id: number;
  transmittedSize: number;
  symbolSize: number;
}

interface DecodePushRequest {
  type: "decode-push";
  id: number;
  packets: Uint8Array[];
  meta: {
    transmittedSize: number;
    symbolSize: number;
    totalPackets: number;
    transmittedCrc32: number;
  };
}

type WorkerRequest = EncodeRequest | DecodeInitRequest | DecodePushRequest;

// ── Decode state (kept in worker) ──────────────────────────────────────

let decoder: { push: (pkt: Uint8Array) => Uint8Array | null } | null = null;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  try {
    if (msg.type === "encode") {
      const { packets, symbolSize } = await raptorQEncode(msg.data, msg.maxSymbolSize, msg.repairPercent);
      const fileCrc32 = crc32(msg.data);
      const source = createTransferSource(packets, {
        filename: msg.meta.filename,
        mime: msg.meta.mime,
        fileSize: msg.meta.fileSize,
        fileCrc32,
        symbolSize,
        transmittedSize: msg.data.length,
        keyEncoding: msg.meta.keyEncoding,
        keyMaterial: msg.meta.keyMaterial,
        compressed: msg.meta.compressed,
      });

      self.postMessage({
        type: "encode-result",
        id: msg.id,
        meta: source.meta,
        packetCount: source.packets.length,
        packets: source.packets,
      } satisfies EncodeResult);
    }

    if (msg.type === "decode-init") {
      const { RaptorQWasmDecoder } = await import("@raptorqr/core/fec/raptorq_wasm");
      decoder = await RaptorQWasmDecoder.create(msg.transmittedSize, msg.symbolSize);
      self.postMessage({ type: "decode-init-result", id: msg.id });
    }

    if (msg.type === "decode-push" && decoder) {
      let result: Uint8Array | null = null;
      for (const pkt of msg.packets) {
        const r = decoder.push(pkt);
        if (r) { result = new Uint8Array(r); break; }
      }
      self.postMessage({
        type: "decode-push-result",
        id: msg.id,
        complete: result !== null,
        result: result ?? undefined,
      } satisfies DecodePushResult);
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

// ── Response types (for worker-client.ts) ──────────────────────────────

export interface EncodeResult {
  type: "encode-result";
  id: number;
  meta: import("./protocol").TransferMeta;
  packetCount: number;
  packets: Uint8Array[];
}

export interface DecodeInitResult {
  type: "decode-init-result";
  id: number;
}

export interface DecodePushResult {
  type: "decode-push-result";
  id: number;
  complete: boolean;
  result?: Uint8Array;
}

export interface WorkerError {
  type: "error";
  id: number;
  message: string;
}
