/**
 * Client API for the RaptorQ Web Worker.
 *
 * Provides promise-based wrappers around postMessage to keep
 * encode/decode off the main thread.
 */
import type { TransferMeta } from "./protocol";

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.type === "error") {
        p.reject(new Error(msg.message));
      } else {
        p.resolve(msg);
      }
    }
  };
  worker.onerror = (e) => {
    // Reject all pending
    for (const [id, p] of pending) {
      p.reject(new Error(e.message ?? "Worker error"));
      pending.delete(id);
    }
    worker = null;
  };
  return worker;
}

function post<T>(msg: { id: number } & Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(msg, transfer ?? []);
  });
}

// ── Public API ──────────────────────────────────────────────────────────

export interface WorkerEncodeResult {
  type: "encode-result";
  id: number;
  meta: TransferMeta;
  packetCount: number;
  packets: Uint8Array[];
}

export async function workerEncode(
  data: Uint8Array,
  maxSymbolSize: number,
  repairPercent: number,
  meta: {
    filename: string;
    mime: string;
    fileSize: number;
    keyEncoding: "inline" | "wrapped";
    keyMaterial: Uint8Array;
    compressed: boolean;
  },
): Promise<WorkerEncodeResult> {
  const id = nextId++;
  return post<WorkerEncodeResult>(
    { type: "encode", id, data, maxSymbolSize, repairPercent, meta },
    [data.buffer],
  );
}

export async function workerDecodeInit(
  transmittedSize: number,
  symbolSize: number,
): Promise<{ type: "decode-init-result"; id: number }> {
  const id = nextId++;
  return post({ type: "decode-init", id, transmittedSize, symbolSize });
}

export async function workerDecodePush(
  packets: Uint8Array[],
  meta: {
    transmittedSize: number;
    symbolSize: number;
    totalPackets: number;
    transmittedCrc32: number;
  },
): Promise<{ type: "decode-push-result"; id: number; complete: boolean; result?: Uint8Array }> {
  const id = nextId++;
  return post(
    { type: "decode-push", id, packets, meta },
    packets.map((p) => p.buffer),
  );
}

/** Terminate the worker (call on app shutdown or unmount). */
export function terminateWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
    for (const [, p] of pending) p.reject(new Error("Worker terminated"));
    pending.clear();
  }
}
