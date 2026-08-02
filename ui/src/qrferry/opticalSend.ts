/**
 * Sender-side orchestration for the optical (screen-to-camera) transfer
 * mode. Uses RaptorQ (RFC 6330) via WASM for fountain-code encoding, with
 * optional deflate compression to reduce the number of QR frames needed.
 *
 * Security model (unchanged from v1):
 *  - Paired contact known (recipientPublicKey provided): the AES key is
 *    wrapped with the recipient's X25519 public key (ECIES). Even a full
 *    recording of the optical stream doesn't yield the plaintext without
 *    the recipient's private key.
 *  - No contact (anonymous one-time transfer): the AES key travels inline
 *    in the descriptor frame, same trade-off as the existing "link" mode.
 */
import { deflateSync } from "fflate";
import { encryptChunk, exportAesKey, generateAesKey } from "../crypto/aes";
import { encryptAesKeyForRecipient } from "../crypto/ecies";
import {
  createTransferSource,
  crc32,
  encodeDataFrame,
  encodeDescriptor,
  getDroplet,
  raptorQEncode,
  type TransferSource,
} from "./protocol";
import { renderOpticalFrame } from "./qr";
import { activeProfile } from "./turbo60";

export interface OpticalSendOptions {
  file: File;
  /** Recipient's X25519 public key, if this is a paired-contact transfer. */
  recipientPublicKey?: CryptoKey;
  /** Profile key override — defaults to the active profile from turbo60. */
  profileKey?: string;
  /** Force compression on/off — auto-detects by default. */
  compress?: boolean;
  /** Adaptive rate options. */
  adaptive?: AdaptiveOptions;
}

export interface ThroughputStats {
  /** Symbols (QR frames) sent per second, measured over the last 2 seconds. */
  symbolsPerSecond: number;
  /** Effective data throughput in bytes/sec (after FEC overhead). */
  bytesPerSecond: number;
  /** Total symbols sent so far. */
  totalSymbolsSent: number;
  /** Wall-clock seconds since start. */
  elapsedSeconds: number;
  /** Currently active profile key (may change during adaptive switching). */
  activeProfileKey: string;
}

export interface AdaptiveOptions {
  /** Minimum sustained throughput (bytes/s) before downgrading. */
  minThroughputBytesPerSec?: number;
  /** How many seconds of low throughput before switching. */
  cooldownSeconds?: number;
  /** Callback when profile switches. */
  onProfileSwitch?: (fromKey: string, toKey: string) => void;
}

export interface OpticalSendHandle {
  meta: TransferSource["meta"];
  /** Estimated seconds for the receiver to see every block once (no losses). */
  estimatedSeconds: number;
  /** Whether compression was applied. */
  compressed: boolean;
  /** Subscribe to throughput stats updates (called ~every 500ms). */
  onThroughput?: (stats: ThroughputStats) => void;
  start(laneCanvases: [HTMLCanvasElement, HTMLCanvasElement]): void;
  stop(): void;
}

/** Encrypts the file and prepares the RaptorQ-encoded source. Call once per transfer. */
export async function prepareOpticalSend(options: OpticalSendOptions): Promise<OpticalSendHandle> {
  const plaintext = new Uint8Array(await options.file.arrayBuffer());
  const fileCrc32 = crc32(plaintext);

  // ── Compression ────────────────────────────────────────────────────────
  let payloadToEncrypt: Uint8Array;
  let compressed = false;
  if (plaintext.length >= 256) {
    const deflated = deflateSync(plaintext, { level: 9 });
    if (deflated.length < plaintext.length - 64) {
      payloadToEncrypt = deflated;
      compressed = true;
    } else {
      payloadToEncrypt = plaintext;
    }
  } else {
    payloadToEncrypt = plaintext;
  }

  // ── Encryption ─────────────────────────────────────────────────────────
  const aesKey = await generateAesKey();
  const encrypted = await encryptChunk(aesKey, payloadToEncrypt);

  let keyEncoding: "inline" | "wrapped";
  let keyMaterial: Uint8Array;
  if (options.recipientPublicKey) {
    const rawKey = await exportAesKey(aesKey);
    keyMaterial = await encryptAesKeyForRecipient(rawKey, options.recipientPublicKey);
    keyEncoding = "wrapped";
  } else {
    keyMaterial = await exportAesKey(aesKey);
    keyEncoding = "inline";
  }

  // ── RaptorQ encoding ──────────────────────────────────────────────────
  const profile = activeProfile();
  const maxSymbolSize = profile.maxPacketSize;
  const repairPercent = profile.repairPercent;

  const { packets, symbolSize } = await raptorQEncode(
    encrypted,
    maxSymbolSize,
    repairPercent,
  );

  const source = createTransferSource(packets, {
    filename: options.file.name || "transfer.bin",
    mime: options.file.type || "application/octet-stream",
    fileSize: plaintext.length,
    fileCrc32,
    symbolSize,
    transmittedSize: encrypted.length,
    keyEncoding,
    keyMaterial,
    compressed,
  });

  const estimatedSeconds = source.meta.transmittedSize / profile.nominalThroughput;

  let raf = 0;
  let running = false;
  let sequence = 0;
  let _onThroughput: ((stats: ThroughputStats) => void) | undefined;
  const activeProfileKey = options.profileKey ?? "turbo60";

  function start(laneCanvases: [HTMLCanvasElement, HTMLCanvasElement]) {
    if (running) return;
    running = true;
    const contexts = laneCanvases.map((c) => c.getContext("2d")!);
    let frameCount = 0;
    const descriptorPacket = encodeDescriptor(source.meta);
    const laneCount = profile.lanes;

    // ── Throughput measurement ──────────────────────────────────────────
    const startTime = performance.now();
    const throughputWindow: number[] = [];
    const THROUGHPUT_WINDOW_MS = 2000;
    const THROUGHPUT_REPORT_MS = 500;
    let lastReportTime = startTime;

    const tick = async () => {
      if (!running) return;
      const lane = frameCount % laneCount;
      const showDescriptor = frameCount % (laneCount * 15) === lane;
      const bytes = showDescriptor ? descriptorPacket : encodeDataFrame(source.meta.sessionId, getDroplet(source, sequence++));
      const image = await renderOpticalFrame(bytes);
      const canvas = laneCanvases[lane];
      if (canvas.width !== image.width || canvas.height !== image.height) {
        canvas.width = image.width;
        canvas.height = image.height;
      }
      contexts[lane].putImageData(image, 0, 0);
      frameCount += 1;

      // Track throughput
      const now = performance.now();
      throughputWindow.push(now);
      // Remove entries older than the window
      while (throughputWindow.length > 0 && throughputWindow[0]! < now - THROUGHPUT_WINDOW_MS) {
        throughputWindow.shift();
      }

      // Report throughput periodically
      if (now - lastReportTime >= THROUGHPUT_REPORT_MS && _onThroughput) {
        const elapsed = (now - startTime) / 1000;
        const symbolsInWindow = throughputWindow.length;
        const windowDuration = Math.min(THROUGHPUT_WINDOW_MS, now - startTime);
        const symbolsPerSecond = windowDuration > 0 ? (symbolsInWindow / windowDuration) * 1000 : 0;
        const bytesPerSecond = symbolsPerSecond * symbolSize * (1 - repairPercent / 100);
        _onThroughput({
          symbolsPerSecond: Math.round(symbolsPerSecond * 10) / 10,
          bytesPerSecond: Math.round(bytesPerSecond),
          totalSymbolsSent: sequence,
          elapsedSeconds: Math.round(elapsed * 10) / 10,
          activeProfileKey,
        });
        lastReportTime = now;
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
  }

  const handle: OpticalSendHandle = {
    meta: source.meta,
    estimatedSeconds,
    compressed,
    start,
    stop,
  };

  // Proxy onThroughput setter
  Object.defineProperty(handle, "onThroughput", {
    get: () => _onThroughput,
    set: (fn: ((stats: ThroughputStats) => void) | undefined) => { _onThroughput = fn; },
  });

  return handle;
}
