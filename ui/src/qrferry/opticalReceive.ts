/**
 * Receiver-side orchestration for the optical (screen-to-camera) transfer
 * mode. Uses RaptorQ (RFC 6330) via WASM for fountain-code decoding, with
 * automatic decompression when the sender used deflate.
 *
 * Includes mobile camera fallback (tries multiple constraint sets) and
 * completion notification (vibration + optional audio).
 */
import { inflateSync } from "fflate";
import { decryptChunk, importAesKey } from "../crypto/aes";
import { decryptAesKeyFromBlob } from "../crypto/ecies";
import { toBlobPart } from "../crypto/buffer";
import { crc32, decodeFrame, RaptorQDecoder } from "./protocol";
import { scanOpticalFrames } from "./qr";

export interface OpticalReceiveResult {
  file: Blob;
  filename: string;
  mime: string;
}

export interface OpticalReceiveOptions {
  /** Required if the sender used a paired-contact (wrapped) transfer. */
  recipientPrivateKey?: CryptoKey;
  onProgress?: (solved: number, total: number) => void;
  /** Called when the transfer completes (before decryption). */
  onComplete?: () => void;
}

// ── Completion notification ────────────────────────────────────────────

/** Play a short completion sound (two ascending beeps). */
function playCompleteSound(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    [440, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, now + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.15);
      osc.stop(now + i * 0.15 + 0.25);
    });

    // Close context after sounds finish
    setTimeout(() => ctx.close(), 800);
  } catch {
    // AudioContext not available — skip silently
  }
}

/** Trigger a vibration pattern (short pulse). */
function vibrateComplete(): void {
  try {
    if ("vibrate" in navigator) {
      navigator.vibrate([100, 50, 100]);
    }
  } catch {
    // Vibration not available
  }
}

/** Fire both audio and vibration notifications. */
export function notifyTransferComplete(): void {
  playCompleteSound();
  vibrateComplete();
}

// ── Camera helpers ─────────────────────────────────────────────────────

/** Constraint sets to try in order, from most specific to most permissive. */
const CAMERA_CONSTRAINTS: MediaStreamConstraints[] = [
  {
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  },
  {
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  },
  {
    video: {
      facingMode: { ideal: "environment" },
    },
    audio: false,
  },
  {
    video: true,
    audio: false,
  },
];

/**
 * Requests the rear camera with mobile-friendly fallback.
 * Tries multiple constraint sets: if the phone doesn't support 1920x1080
 * or `facingMode`, it falls back gracefully.
 * Caller is responsible for stopping the returned stream's tracks.
 */
export async function openRearCamera(video: HTMLVideoElement): Promise<MediaStream> {
  let lastError: Error | null = null;
  for (const constraints of CAMERA_CONSTRAINTS) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      return stream;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Try next constraint set
    }
  }
  throw lastError ?? new Error("Camera access denied");
}

export class OpticalReceiver {
  private readonly decoder = new RaptorQDecoder();
  private readonly captureCanvas = document.createElement("canvas");
  private readonly captureCtx = this.captureCanvas.getContext("2d", { willReadFrequently: true })!;
  private _notifiedComplete = false;

  get progress() { return this.decoder.progress; }
  get isComplete() { return this.decoder.isComplete; }

  /** Call once per animation frame (or camera frame) with the live <video>. */
  async ingestVideoFrame(
    video: HTMLVideoElement,
    onProgress?: OpticalReceiveOptions["onProgress"],
    onComplete?: OpticalReceiveOptions["onComplete"],
  ): Promise<void> {
    if (video.videoWidth === 0) return;
    this.captureCanvas.width = video.videoWidth;
    this.captureCanvas.height = video.videoHeight;
    this.captureCtx.drawImage(video, 0, 0);
    const image = this.captureCtx.getImageData(0, 0, this.captureCanvas.width, this.captureCanvas.height);

    const rawFrames = await scanOpticalFrames(image, 2);
    for (const raw of rawFrames) {
      try {
        const frame = decodeFrame(raw);
        if (frame.kind === "descriptor") {
          await this.decoder.setMeta(frame.meta);
        } else {
          this.decoder.receiveData(frame);
        }
      } catch {
        // Corrupt or partial optical read — drop this symbol and keep going,
        // the fountain code tolerates losses by design.
      }
    }

    onProgress?.(this.decoder.solvedCount, this.decoder.totalCount);

    // Fire notification exactly once when transfer completes
    if (this.decoder.isComplete && !this._notifiedComplete) {
      this._notifiedComplete = true;
      notifyTransferComplete();
      onComplete?.();
    }
  }

  /** Once isComplete, decrypt and return the original file. */
  async finish(options: OpticalReceiveOptions = {}): Promise<OpticalReceiveResult> {
    const meta = this.decoder.meta;
    if (!meta) throw new Error("No transfer descriptor received yet.");
    const encrypted = this.decoder.result(); // throws if incomplete or checksum fails

    let aesKey;
    if (meta.keyEncoding === "wrapped") {
      if (!options.recipientPrivateKey) {
        throw new Error("This transfer is encrypted for a specific contact — the recipient private key is required.");
      }
      const rawKey = await decryptAesKeyFromBlob(meta.keyMaterial, options.recipientPrivateKey);
      aesKey = await importAesKey(rawKey);
    } else {
      aesKey = await importAesKey(meta.keyMaterial);
    }

    const decrypted = await decryptChunk(aesKey, encrypted);

    // ── Decompression ─────────────────────────────────────────────────────
    let plaintext: Uint8Array;
    if (meta.compressed) {
      try {
        plaintext = inflateSync(decrypted);
      } catch {
        throw new Error("Decompression failed — the transfer may be corrupted.");
      }
    } else {
      plaintext = decrypted;
    }

    if (crc32(plaintext) !== meta.fileCrc32) {
      throw new Error("Decrypted file failed integrity check.");
    }

    return {
      file: new Blob([toBlobPart(plaintext)], { type: meta.mime || "application/octet-stream" }),
      filename: meta.filename || "transfer.bin",
      mime: meta.mime,
    };
  }
}
