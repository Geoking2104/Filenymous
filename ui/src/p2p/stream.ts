/**
 * Streaming receiver: fetches encrypted chunks on demand (range requests over
 * the DataChannel), decrypts them in the browser and serves byte ranges to a
 * media element through the Service Worker (see public/sw.js).
 */
import { MAX_RANGE_CHUNKS, P2P_CHUNK_SIZE, openChunk, type P2PControl, type P2PFileInfo } from "./protocol";
import { chunksForRange, mediaMime } from "./media";

const CACHE_CHUNKS = 256; // 16 MiB of decrypted chunks
const PREFETCH_CHUNKS = 32; // read-ahead after each request (2 MiB)

/** Contiguous runs of missing chunks, each ≤ MAX_RANGE_CHUNKS. */
export function missingRuns(from: number, to: number, have: (c: number) => boolean): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let c = from; c <= to + 1; c++) {
    const missing = c <= to && !have(c);
    if (missing && start < 0) start = c;
    if (start >= 0 && (!missing || c - start === MAX_RANGE_CHUNKS)) {
      runs.push([start, c - 1]);
      start = missing ? c : -1;
    }
  }
  return runs;
}

export class StreamReader {
  private cache = new Map<string, Uint8Array>();
  private waiters = new Map<string, Array<(b: Uint8Array) => void>>();
  private requested = new Set<string>();
  private received = 0;

  constructor(
    private readonly key: CryptoKey,
    private readonly files: P2PFileInfo[],
    private readonly send: (msg: P2PControl) => unknown,
    private readonly onBytes?: (receivedBytes: number) => void,
  ) {}

  get receivedBytes(): number {
    return this.received;
  }

  async onFrame(frame: ArrayBuffer): Promise<void> {
    const { fileIndex, chunkIndex, plain } = await openChunk(this.key, frame);
    const k = `${fileIndex}:${chunkIndex}`;
    this.requested.delete(k);
    this.received += plain.byteLength;
    this.onBytes?.(this.received);
    this.cache.delete(k);
    this.cache.set(k, plain);
    while (this.cache.size > CACHE_CHUNKS) this.cache.delete(this.cache.keys().next().value!);
    const w = this.waiters.get(k);
    if (w) {
      this.waiters.delete(k);
      for (const fn of w) fn(plain);
    }
  }

  private request(file: number, from: number, to: number, prefetch = false) {
    const has = (c: number) => this.cache.has(`${file}:${c}`) || this.requested.has(`${file}:${c}`);
    for (const [a, b] of missingRuns(from, to, has)) {
      for (let c = a; c <= b; c++) this.requested.add(`${file}:${c}`);
      this.send({ type: "range", index: file, from: a, to: b, ...(prefetch ? { prefetch: true } : {}) });
    }
  }

  private chunk(file: number, c: number): Promise<Uint8Array> {
    const k = `${file}:${c}`;
    const hit = this.cache.get(k);
    if (hit) {
      this.cache.delete(k);
      this.cache.set(k, hit);
      return Promise.resolve(hit);
    }
    return new Promise((ok) => {
      const list = this.waiters.get(k) ?? [];
      list.push(ok);
      this.waiters.set(k, list);
    });
  }

  /** Plaintext bytes [start, end] (inclusive) of a file. */
  async read(file: number, start: number, end: number): Promise<Uint8Array> {
    const info = this.files[file];
    if (!info) throw new Error("bad-file");
    if (info.size === 0) return new Uint8Array(0);
    const { from, to } = chunksForRange(start, end, info.size);
    this.request(file, from, to);
    const lastChunk = Math.ceil(info.size / P2P_CHUNK_SIZE) - 1;
    if (to < lastChunk) this.request(file, to + 1, Math.min(lastChunk, to + PREFETCH_CHUNKS), true);
    const parts = await Promise.all(Array.from({ length: to - from + 1 }, (_, i) => this.chunk(file, from + i)));
    const out = new Uint8Array(Math.min(end, info.size - 1) - start + 1);
    let pos = 0;
    let offset = start - from * P2P_CHUNK_SIZE;
    for (const p of parts) {
      const piece = p.subarray(offset, offset + (out.length - pos));
      out.set(piece, pos);
      pos += piece.length;
      offset = 0;
    }
    return out;
  }
}

function swBase(): string {
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL || "/";
  return base.endsWith("/") ? base : `${base}/`;
}

async function streamController(timeoutMs = 4000): Promise<ServiceWorker | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const sw = navigator.serviceWorker;
  if (sw.controller) return sw.controller;
  try {
    await Promise.race([sw.ready, new Promise((_, ko) => setTimeout(() => ko(new Error("timeout")), timeoutMs))]);
  } catch {
    return null;
  }
  if (sw.controller) return sw.controller;
  // First visit: the worker claims open pages on activation.
  await new Promise<void>((ok) => {
    const t = setTimeout(ok, timeoutMs);
    sw.addEventListener("controllerchange", () => { clearTimeout(t); ok(); }, { once: true });
  });
  return sw.controller;
}

/** True when a Service Worker controls this page (needed to stream). */
export async function streamingAvailable(): Promise<boolean> {
  return (await streamController()) !== null;
}

export interface StreamHandle {
  url: string;
  mime: string;
  close(): void;
}

/**
 * Registers a file with the Service Worker and returns a same-origin URL that
 * answers HTTP Range requests from the P2P channel. null → no SW available.
 */
export async function openStreamUrl(reader: StreamReader, fileIndex: number, info: P2PFileInfo): Promise<StreamHandle | null> {
  const controller = await streamController();
  if (!controller) return null;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  const mime = mediaMime(info.name, info.mime) || "application/octet-stream";
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = async (ev: MessageEvent<{ req: number; start: number; end: number }>) => {
    const { req, start, end } = ev.data;
    try {
      const bytes = await reader.read(fileIndex, start, end);
      port1.postMessage({ req, bytes: bytes.buffer }, [bytes.buffer]);
    } catch (e) {
      port1.postMessage({ req, error: String((e as Error).message || e) });
    }
  };
  controller.postMessage({ type: "FY_STREAM_REGISTER", id, size: info.size, mime }, [port2]);
  // Messages keep the worker alive while the player is paused.
  const ping = setInterval(() => navigator.serviceWorker.controller?.postMessage({ type: "FY_STREAM_PING", id }), 10_000);
  return {
    url: `${swBase()}__fy_stream/${id}/${encodeURIComponent(info.name)}`,
    mime,
    close() {
      clearInterval(ping);
      navigator.serviceWorker.controller?.postMessage({ type: "FY_STREAM_CLOSE", id });
      port1.close();
    },
  };
}
