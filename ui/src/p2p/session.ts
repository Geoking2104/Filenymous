import { describeDevice } from "./device";
import { iceServers } from "./config";
import {
  MAX_PASSWORD_ATTEMPTS,
  P2P_LOCKED_VERSION,
  P2P_EXPIRING_VERSION,
  PASSWORD_ITERATIONS,
  derivePasswordKeys,
  passwordProof,
  randomB64,
  verifyPasswordProof,
  type P2PAuthChallenge,
  type PasswordKeys,
  P2P_CHUNK_SIZE,
  P2P_PROTOCOL_VERSION,
  chunkCount,
  createSecret,
  createShareCode,
  deriveFileKey,
  openChunk,
  parseControl,
  sealChunk,
  unwrapSecret,
  wrapSecret,
  type P2PControl,
  type P2PFileInfo,
} from "./protocol";
import { SignalClient, iceCandidateInit, type SignalPayload } from "./signal";
import type { FileSink } from "./sink";
import { StreamReader } from "./stream";

const HIGH_WATER = 4 * 1024 * 1024;
export const LOW_WATER = 1 * 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 45_000;
/** Receiver: no data for this long while receiving → "stalled". */
export const STALL_TIMEOUT_MS = 30_000;
const PROGRESS_EVERY_MS = 300;

export type SenderStatus =
  | "starting"
  | "waiting"
  | "connecting"
  | "connected"
  | "transferring"
  | "complete"
  | "failed"
  | "reconnecting"
  | "error"
  | "stopped"
  /** Streaming share: serving byte ranges to a player. */
  | "streaming"
  /** Expiry reached: the share is closed for good. */
  | "expired";

export type FileDeliveryState = "pending" | "sending" | "delivered" | "failed";

export interface TransferLogEntry {
  id: number;
  startedAt: number;
  endedAt: number;
  bytes: number;
  totalBytes: number;
  result: "complete" | "failed";
  reason?: string;
}

export interface SenderState {
  status: SenderStatus;
  code: string;
  secret: string;
  /** Bytes handed to the DataChannel for the current recipient. */
  sentBytes: number;
  /** Bytes the current recipient confirmed (decrypted + written). */
  confirmedBytes: number;
  totalBytes: number;
  /** Bytes/second, from recipient confirmations. */
  speed: number;
  fileStates: FileDeliveryState[];
  downloads: number;
  log: TransferLogEntry[];
  /** Password-protected session. */
  protected?: boolean;
  /** Wrong-password attempts so far (whole session). */
  authFailures?: number;
  /** Browser · OS of the connected recipient (from its "hello"). */
  peerDevice?: string;
  /** Expiry (Unix seconds), bound into the link and the file key. */
  expires?: number;
  error?: string;
}

export type ReceiverStatus =
  | "connecting"
  | "waiting-sender"
  | "negotiating"
  | "password"
  | "ready"
  | "receiving"
  | "complete"
  | "error"
  | "streaming";

export interface ReceiverState {
  status: ReceiverStatus;
  files: P2PFileInfo[];
  message?: string;
  receivedBytes: number;
  totalBytes: number;
  speed: number;
  /** Password gate: a check is in flight. */
  authChecking?: boolean;
  /** Password gate: last attempt was wrong; attempts left. */
  authError?: boolean;
  authRemaining?: number;
  /** Browser · OS of the sender (from the manifest). */
  peerDevice?: string;
  /** The sender offers streaming (range requests). */
  streamable?: boolean;
  /** Expiry (Unix seconds) of an expiring share. */
  expires?: number;
  error?: string;
}

function sendJson(channel: RTCDataChannel, msg: P2PControl) {
  if (channel.readyState === "open") channel.send(JSON.stringify(msg));
}

export function waitForDrain(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= HIGH_WATER) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // Poll as a safety net: some browsers skip bufferedamountlow when the
    // threshold is crossed between two event-loop turns.
    const poll = setInterval(() => {
      if (channel.readyState !== "open") onClose();
      else if (channel.bufferedAmount <= LOW_WATER) onLow();
    }, 200);
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("connection-lost"));
    };
    const cleanup = () => {
      clearInterval(poll);
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
    };
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
  });
}

export async function addRemoteCandidate(pc: RTCPeerConnection, payload: SignalPayload, pending: RTCIceCandidateInit[]) {
  if (payload.kind !== "ice") return;
  if (!pc.remoteDescription) {
    pending.push(payload.candidate);
    return;
  }
  try {
    await pc.addIceCandidate(payload.candidate);
  } catch {
    /* stale candidate from a previous negotiation */
  }
}

interface Attempt {
  id: number;
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  open: boolean;
  started: boolean;
  finished: boolean;
  /** Streaming: chunks still to send, on-demand before prefetch. */
  demand?: Array<[number, number]>;
  prefetch?: Array<[number, number]>;
  pumping?: boolean;
  /** Password sessions: set once the recipient proved the password. */
  authed: boolean;
  nonce: string;
  startedAt: number;
  lastConfirm: { at: number; bytes: number };
}

/**
 * Sender side: holds the files (never loaded fully in memory), serves them to
 * successive receivers for as long as the tab stays open.
 *
 * Once the DataChannel is open, signaling events (peer-left / peer-joined from
 * a receiver's WebSocket reconnecting or closing) never tear the live session
 * down: only the DataChannel / ICE state does.
 */
export class P2PSender {
  readonly code: string;
  readonly secret: string;
  private readonly message?: string;
  private readonly pwKeys?: Promise<PasswordKeys>;
  private readonly pwSalt?: string;
  private authFailures = 0;
  private signal: SignalClient;
  private attempt: Attempt | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private state: SenderState;
  private stopped = false;
  private nextId = 1;
  /** Coalesces concurrent offer() calls (start + peer-joined racing). */
  private offerGen = 0;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly streamable: boolean;
  private fileKey?: Promise<CryptoKey>;
  readonly expires?: number;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly files: File[],
    private readonly onState: (s: SenderState) => void,
    opts: { code?: string; secret?: string; message?: string; signalUrl?: string; password?: string; stream?: boolean; expires?: number } = {},
  ) {
    this.streamable = !!opts.stream;
    this.expires = opts.expires ? Math.floor(opts.expires) : undefined;
    if (opts.password) {
      this.pwSalt = randomB64(16);
      this.pwKeys = derivePasswordKeys(opts.password, this.pwSalt);
    }
    this.code = opts.code ?? createShareCode();
    this.secret = opts.secret ?? createSecret();
    this.message = opts.message;
    this.state = {
      status: "starting",
      code: this.code,
      secret: this.secret,
      sentBytes: 0,
      confirmedBytes: 0,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      speed: 0,
      fileStates: files.map(() => "pending"),
      downloads: 0,
      log: [],
      protected: !!opts.password,
      authFailures: 0,
      ...(this.expires ? { expires: this.expires } : {}),
    };
    this.signal = new SignalClient(
      this.code,
      "sender",
      {
        onSignal: (p) => void this.onSignal(p),
        onPeerJoined: () => void this.offer(),
        onPeerLeft: () => {
          // Receiver left before the DataChannel opened: drop the half-open attempt.
          if (this.attempt && !this.attempt.open) this.dropAttempt(this.idleStatus());
        },
        onReconnecting: () => {
          if (!this.attempt?.open) this.update({ status: "reconnecting" });
        },
        onError: (error) => this.update({ status: "error", error }),
      },
      opts.signalUrl,
    );
  }

  private update(patch: Partial<SenderState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  getState(): SenderState {
    return this.state;
  }

  private idleStatus(): SenderStatus {
    if (this.pwKeys && this.authFailures >= MAX_PASSWORD_ATTEMPTS) return "failed";
    const last = this.state.log[0];
    return last ? (last.result === "complete" ? "complete" : "failed") : "waiting";
  }

  private isExpired(): boolean {
    return !!this.expires && Date.now() >= this.expires * 1000;
  }

  /** Expiry: stop serving, drop the current recipient, leave the signaling room. */
  private expire() {
    if (this.stopped && this.state.status === "expired") return;
    clearTimeout(this.expiryTimer);
    clearTimeout(this.connectTimer);
    const a = this.attempt;
    if (a) {
      try { sendJson(a.channel, { type: "cancel", reason: "expired" }); } catch { /* ignore */ }
      if (a.started && !a.finished) this.record(a, "failed", "expired");
      setTimeout(() => { try { a.pc.close(); } catch { /* ignore */ } }, 300);
    }
    this.attempt = null;
    this.stopped = true;
    this.signal.close();
    this.update({ status: "expired", error: "expired" });
  }

  private armExpiry() {
    if (!this.expires) return;
    clearTimeout(this.expiryTimer);
    const ms = this.expires * 1000 - Date.now();
    if (ms <= 0) return this.expire();
    this.expiryTimer = setTimeout(() => this.armExpiry(), Math.min(ms, 2 ** 31 - 1));
  }

  async start(): Promise<void> {
    if (this.isExpired()) {
      this.expire();
      throw new Error("expired");
    }
    this.armExpiry();
    this.update({ status: "starting" });
    await this.signal.connect();
    this.update({ status: "waiting" });
    // Reaches a receiver already waiting in the room; otherwise the relay
    // answers "waiting" and we re-offer on peer-joined.
    await this.offer();
  }

  private dropAttempt(status: SenderStatus) {
    clearTimeout(this.connectTimer);
    const a = this.attempt;
    this.attempt = null;
    this.pendingIce = [];
    if (a) {
      a.finished = true;
      try { a.pc.close(); } catch { /* ignore */ }
    }
    if (!this.stopped) this.update({ status });
  }

  private record(a: Attempt, result: "complete" | "failed", reason?: string) {
    if (a.finished) return;
    a.finished = true;
    const entry: TransferLogEntry = {
      id: a.id,
      startedAt: a.startedAt,
      endedAt: Date.now(),
      bytes: result === "complete" ? this.state.totalBytes : this.state.confirmedBytes,
      totalBytes: this.state.totalBytes,
      result,
      ...(reason ? { reason } : {}),
    };
    this.update({
      log: [entry, ...this.state.log].slice(0, 50),
      downloads: this.state.downloads + (result === "complete" ? 1 : 0),
      status: result === "complete" ? "complete" : "failed",
      error: reason,
      ...(result === "complete"
        ? { confirmedBytes: this.state.totalBytes, fileStates: this.files.map(() => "delivered" as const) }
        : { fileStates: this.state.fileStates.map((f) => (f === "delivered" ? f : "failed")) }),
    });
  }

  private fail(a: Attempt, reason: string) {
    if (this.attempt !== a) return;
    if (a.started && !a.finished) this.record(a, "failed", reason);
    this.dropAttempt(this.idleStatus());
    if (!a.started) this.update({ error: reason });
  }

  private async offer() {
    if (this.stopped) return;
    // A live DataChannel survives receiver WebSocket reconnects.
    if (this.attempt?.open && !this.attempt.finished) return;
    const gen = ++this.offerGen;
    this.dropAttempt(this.idleStatus());
    const servers = await iceServers();
    if (gen !== this.offerGen || this.stopped) return;
    const pc = new RTCPeerConnection({ iceServers: servers });
    const channel = pc.createDataChannel("filenymous-p2p-v2", { ordered: true });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER;
    const a: Attempt = {
      id: this.nextId++,
      pc,
      channel,
      open: false,
      started: false,
      authed: false,
      nonce: "",
      finished: false,
      startedAt: 0,
      lastConfirm: { at: 0, bytes: 0 },
    };
    this.attempt = a;
    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.attempt === a) this.signal.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) });
    };
    pc.onconnectionstatechange = () => {
      if (this.attempt !== a) return;
      if (pc.connectionState === "failed") this.fail(a, a.open ? "connection-lost" : "ice-failed");
    };
    channel.onopen = () => {
      if (this.attempt !== a) return;
      a.open = true;
      clearTimeout(this.connectTimer);
      void this.serve(a);
    };
    channel.onclose = () => {
      if (this.attempt === a && !a.finished) this.fail(a, a.started ? "connection-lost" : "recipient-left");
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.attempt !== a) return;
    this.signal.send({ kind: "offer", sdp: offer.sdp ?? "" });
  }

  private async onSignal(payload: SignalPayload) {
    const a = this.attempt;
    if (!a) return;
    const pc = a.pc;
    if (payload.kind === "answer" && pc.signalingState === "have-local-offer") {
      this.update({ status: "connecting", error: undefined });
      // Arm the timeout *before* awaiting, and only the open flag clears it.
      clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => {
        if (this.attempt === a && !a.open) this.fail(a, "ice-timeout");
      }, CONNECT_TIMEOUT_MS);
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      } catch {
        // Answer to a superseded offer: renegotiate from scratch.
        if (this.attempt === a) void this.offer();
        return;
      }
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
    } else if (payload.kind === "ice") {
      await addRemoteCandidate(pc, payload, this.pendingIce);
    }
  }

  private async serve(a: Attempt) {
    const { channel } = a;
    if (this.isExpired()) return this.expire();
    channel.onmessage = (ev) => {
      if (typeof ev.data !== "string" || this.attempt !== a) return;
      const msg = parseControl(ev.data);
      if (!msg) return;
      switch (msg.type) {
        case "start":
          if (this.pwKeys && !a.authed) {
            this.fail(a, "auth-required");
            break;
          }
          void this.stream(a);
          break;
        case "auth":
          void this.checkAuth(a, msg.proof);
          break;
        case "range":
          if (!this.streamable) break;
          if (this.pwKeys && !a.authed) {
            this.fail(a, "auth-required");
            break;
          }
          this.queueRange(a, msg.index, msg.from, msg.to, msg.prefetch === true);
          break;
        case "progress": {
          const now = Date.now();
          const bytes = Math.min(this.state.totalBytes, Math.max(0, Number(msg.bytes) || 0));
          const dt = (now - a.lastConfirm.at) / 1000;
          const inst = dt > 0 ? (bytes - a.lastConfirm.bytes) / dt : 0;
          a.lastConfirm = { at: now, bytes };
          this.update({ confirmedBytes: bytes, speed: this.state.speed ? this.state.speed * 0.7 + inst * 0.3 : inst });
          break;
        }
        case "file-ack": {
          const fs = [...this.state.fileStates];
          if (msg.index >= 0 && msg.index < fs.length) fs[msg.index] = "delivered";
          this.update({ fileStates: fs });
          break;
        }
        case "ack":
          this.record(a, "complete");
          // Ready for the next recipient while the tab stays open.
          setTimeout(() => {
            if (this.attempt === a) this.dropAttempt("complete");
          }, 1500);
          break;
        case "cancel":
          this.fail(a, msg.reason || "cancelled");
          break;
        case "hello":
          this.update({ peerDevice: msg.device });
          break;
        default:
          break;
      }
    };
    if (this.pwKeys) {
      if (this.authFailures >= MAX_PASSWORD_ATTEMPTS) {
        sendJson(channel, { type: "cancel", reason: "too-many-attempts" });
        this.fail(a, "too-many-attempts");
        return;
      }
      a.nonce = randomB64(16);
      sendJson(channel, {
        type: "manifest",
        v: P2P_LOCKED_VERSION,
        chunkSize: P2P_CHUNK_SIZE,
        files: [{ name: "locked", size: 0, mime: "" }],
        wrappedSecret: "",
        auth: { salt: this.pwSalt!, iter: PASSWORD_ITERATIONS, nonce: a.nonce },
        device: describeDevice(),
      });
      if (this.attempt === a) this.update({ status: "connected", error: undefined });
      return;
    }
    await this.sendManifest(a);
  }

  private async checkAuth(a: Attempt, proof: string) {
    if (!this.pwKeys || a.authed || a.finished) return;
    const ok = typeof proof === "string" && (await verifyPasswordProof(await this.pwKeys, this.code, a.nonce, proof));
    if (this.attempt !== a) return;
    if (ok) {
      a.authed = true;
      sendJson(a.channel, { type: "auth-ok" });
      await this.sendManifest(a);
      return;
    }
    this.authFailures += 1;
    const remaining = Math.max(0, MAX_PASSWORD_ATTEMPTS - this.authFailures);
    this.update({ authFailures: this.authFailures });
    sendJson(a.channel, { type: "auth-fail", remaining });
    if (remaining === 0) {
      sendJson(a.channel, { type: "cancel", reason: "too-many-attempts" });
      this.fail(a, "too-many-attempts");
      // Lock the share for good: leave the signaling room so nobody else can
      // keep guessing. The sender must start a new share.
      setTimeout(() => {
        this.stopped = true;
        this.signal.close();
        this.update({ status: "failed", error: "too-many-attempts" });
      }, 1000);
    }
  }

  private async sendManifest(a: Attempt) {
    const { channel } = a;
    sendJson(channel, {
      type: "manifest",
      v: this.expires ? P2P_EXPIRING_VERSION : P2P_PROTOCOL_VERSION,
      ...(this.expires ? { expires: this.expires } : {}),
      chunkSize: P2P_CHUNK_SIZE,
      files: this.files.map((f) => ({ name: f.name, size: f.size, mime: f.type || "application/octet-stream" })),
      wrappedSecret: await wrapSecret(this.code, this.secret),
      ...(this.message ? { message: this.message } : {}),
      device: describeDevice(),
      ...(this.pwKeys ? { protected: true } : {}),
      ...(this.streamable ? { streamable: true } : {}),
    });
    if (this.attempt === a) this.update({ status: "connected", error: undefined });
  }

  private key(): Promise<CryptoKey> {
    this.fileKey ??= (async () => deriveFileKey(this.secret, this.pwKeys ? (await this.pwKeys).mix : undefined, this.expires))();
    return this.fileKey;
  }

  /** Streaming: queue a range request; on-demand chunks jump ahead of prefetch. */
  private queueRange(a: Attempt, index: number, from: number, to: number, prefetch: boolean) {
    const file = this.files[index];
    if (!file) return;
    const last = chunkCount(file.size) - 1;
    const list = prefetch ? (a.prefetch ??= []) : (a.demand ??= []);
    for (let c = from; c <= Math.min(to, last); c++) list.push([index, c]);
    if (!a.pumping) void this.pumpRanges(a).catch((e) => this.fail(a, String((e as Error).message || e)));
  }

  private async pumpRanges(a: Attempt) {
    a.pumping = true;
    try {
      const key = await this.key();
      const delay = Number((globalThis as { __FILENYMOUS_TEST_CHUNK_DELAY_MS__?: number }).__FILENYMOUS_TEST_CHUNK_DELAY_MS__) || 0;
      const sent = new Set<string>();
      for (;;) {
        const next = a.demand?.shift() ?? a.prefetch?.shift();
        if (!next) break;
        const [index, c] = next;
        // Skip a prefetch chunk that was just sent on demand (and vice versa).
        const k = `${index}:${c}`;
        if (sent.has(k)) continue;
        sent.add(k);
        if (sent.size > 4096) sent.clear();
        if (this.isExpired()) return this.expire();
        if (this.attempt !== a || a.channel.readyState !== "open") throw new Error("connection-lost");
        const slice = new Uint8Array(await this.files[index]!.slice(c * P2P_CHUNK_SIZE, (c + 1) * P2P_CHUNK_SIZE).arrayBuffer());
        await waitForDrain(a.channel);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        a.channel.send(await sealChunk(key, index, c, slice));
        this.update({ status: "streaming", sentBytes: this.state.sentBytes + slice.byteLength, error: undefined });
      }
    } finally {
      a.pumping = false;
    }
  }

  private async stream(a: Attempt) {
    if (a.started) return;
    a.started = true;
    a.startedAt = Date.now();
    a.lastConfirm = { at: a.startedAt, bytes: 0 };
    const { channel } = a;
    this.update({
      status: "transferring",
      sentBytes: 0,
      confirmedBytes: 0,
      speed: 0,
      fileStates: this.files.map(() => "pending"),
      error: undefined,
    });
    try {
      const key = await this.key();
      let sent = 0;
      let lastUi = 0;
      for (let i = 0; i < this.files.length; i++) {
        const file = this.files[i]!;
        const fs = [...this.state.fileStates];
        fs[i] = "sending";
        this.update({ fileStates: fs });
        const n = chunkCount(file.size);
        for (let c = 0; c < n; c++) {
          if (this.isExpired()) return this.expire();
          if (this.attempt !== a || channel.readyState !== "open") throw new Error("connection-lost");
          const slice = new Uint8Array(await file.slice(c * P2P_CHUNK_SIZE, (c + 1) * P2P_CHUNK_SIZE).arrayBuffer());
          await waitForDrain(channel);
          channel.send(await sealChunk(key, i, c, slice));
          sent += slice.byteLength;
          if (Date.now() - lastUi > 150 || sent === this.state.totalBytes) {
            lastUi = Date.now();
            this.update({ sentBytes: sent });
          }
        }
        sendJson(channel, { type: "file-end", index: i, chunks: n });
      }
      sendJson(channel, { type: "done" });
      this.update({ sentBytes: sent });
    } catch (e) {
      this.fail(a, String((e as Error).message || e));
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.expiryTimer);
    const a = this.attempt;
    if (a?.started && !a.finished) this.record(a, "failed", "sender-stopped");
    clearTimeout(this.connectTimer);
    if (a) {
      try { sendJson(a.channel, { type: "cancel", reason: "sender-stopped" }); } catch { /* ignore */ }
      try { a.pc.close(); } catch { /* ignore */ }
    }
    this.attempt = null;
    this.signal.close();
    this.update({ status: "stopped" });
  }
}

/** Receiver side: auto-connects from the link, streams into a FileSink. */
export class P2PReceiver {
  private signal: SignalClient;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private key: CryptoKey | null = null;
  private state: ReceiverState = { status: "connecting", files: [], receivedBytes: 0, totalBytes: 0, speed: 0 };
  private sink: FileSink | null = null;
  private queue: Promise<void> = Promise.resolve();
  private expected = { file: 0, chunk: 0 };
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private stallTimer: ReturnType<typeof setInterval> | undefined;
  private lastData = 0;
  private lastProgressSent = 0;
  private speedRef = { at: 0, bytes: 0 };
  private closed = false;
  private offerGen = 0;
  private challenge: P2PAuthChallenge | null = null;
  private pwMix: Uint8Array | null = null;
  private streamReader: StreamReader | null = null;

  constructor(
    private readonly code: string,
    private readonly secret: string | undefined,
    private readonly onState: (s: ReceiverState) => void,
    signalUrl?: string,
    private readonly stallTimeoutMs = STALL_TIMEOUT_MS,
    /** Expiry from the link (Unix seconds): bound into the file key. */
    private readonly linkExpires?: number,
  ) {
    this.signal = new SignalClient(
      code,
      "receiver",
      {
        onSignal: (p) => void this.onSignal(p),
        onPeerLeft: () => {
          // Only meaningful before the direct channel exists.
          if (!this.channel && this.state.status !== "complete" && this.state.status !== "error") {
            this.update({ status: "waiting-sender" });
          }
        },
        onError: (error) => {
          if (!this.channel) this.update({ status: "error", error });
        },
      },
      signalUrl,
    );
  }

  private update(patch: Partial<ReceiverState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  private fail(error: string) {
    if (this.state.status === "complete" || this.state.status === "error") return;
    clearInterval(this.stallTimer);
    void this.sink?.abort();
    if (this.channel?.readyState === "open") {
      try { this.channel.send(JSON.stringify({ type: "cancel", reason: error })); } catch { /* ignore */ }
    }
    this.update({ status: "error", error });
  }

  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  private armExpiry(expires: number) {
    clearTimeout(this.expiryTimer);
    const ms = expires * 1000 - Date.now();
    if (ms <= 0) return this.expireNow();
    this.expiryTimer = setTimeout(() => this.armExpiry(expires), Math.min(ms, 2 ** 31 - 1));
  }

  /** Expiry reached on this side: stop the player/download and disconnect. */
  private expireNow() {
    this.fail("expired");
    if (this.state.status !== "complete") this.close();
  }

  async start(): Promise<void> {
    if (this.linkExpires) {
      this.update({ expires: this.linkExpires });
      if (Date.now() >= this.linkExpires * 1000) {
        this.update({ status: "error", error: "expired" });
        return;
      }
      this.armExpiry(this.linkExpires);
    }
    // Someone else may be downloading right now (one receiver at a time per
    // code): keep retrying quietly ("waiting" state).
    for (let attempt = 0; !this.closed; attempt++) {
      try {
        await this.signal.connect();
        if (!this.pc) this.update({ status: "waiting-sender", error: undefined });
        return;
      } catch (e) {
        const error = String((e as Error).message || e);
        if (error !== "role-taken" || attempt > 200) {
          this.update({ status: "error", error });
          return;
        }
        this.update({ status: "waiting-sender", error });
        await new Promise((r) => setTimeout(r, 3000));
        this.signal = this.signal.clone();
      }
    }
  }

  private async onSignal(payload: SignalPayload) {
    if (payload.kind === "offer") {
      // Never replace a live channel (sender re-offer after a WS blip).
      if (this.channel?.readyState === "open" || this.state.status === "receiving" || this.state.status === "complete") return;
      // Only the latest offer wins (the sender may re-offer quickly).
      const gen = ++this.offerGen;
      try { this.pc?.close(); } catch { /* ignore */ }
      this.pc = null;
      this.pendingIce = [];
      this.channel = null;
      const servers = await iceServers();
      if (gen !== this.offerGen || this.closed) return;
      const pc = new RTCPeerConnection({ iceServers: servers });
      this.pc = pc;
      this.update({ status: "negotiating", error: undefined });
      clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => {
        if (this.pc === pc && this.state.status === "negotiating") this.update({ status: "error", error: "ice-timeout" });
      }, CONNECT_TIMEOUT_MS);
      pc.onicecandidate = (ev) => {
        if (ev.candidate && this.pc === pc) this.signal.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) });
      };
      pc.onconnectionstatechange = () => {
        if (this.pc === pc && pc.connectionState === "failed") this.fail(this.channel ? "connection-lost" : "ice-failed");
      };
      pc.ondatachannel = (ev) => this.attach(ev.channel);
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (gen !== this.offerGen) return;
      this.signal.send({ kind: "answer", sdp: answer.sdp ?? "" });
    } else if (payload.kind === "ice") {
      // Candidates can arrive while the RTCPeerConnection is still being set up
      // (ICE server fetch): keep them for after setRemoteDescription.
      if (this.pc) await addRemoteCandidate(this.pc, payload, this.pendingIce);
      else this.pendingIce.push(payload.candidate);
    }
  }

  private attach(channel: RTCDataChannel) {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onmessage = (ev) => {
      const data = ev.data as string | ArrayBuffer;
      this.lastData = Date.now();
      this.queue = this.queue.then(() => this.handle(data)).catch((e) => this.fail(String((e as Error).message || e)));
    };
    channel.onclose = () => {
      if (["receiving", "ready", "password", "streaming"].includes(this.state.status)) this.fail("sender-disconnected");
    };
  }

  private sendProgress(force = false) {
    const now = Date.now();
    if (!force && now - this.lastProgressSent < PROGRESS_EVERY_MS) return;
    this.lastProgressSent = now;
    const dt = (now - this.speedRef.at) / 1000;
    if (dt >= 0.5) {
      const inst = (this.state.receivedBytes - this.speedRef.bytes) / dt;
      this.speedRef = { at: now, bytes: this.state.receivedBytes };
      this.update({ speed: this.state.speed ? this.state.speed * 0.7 + inst * 0.3 : inst });
    }
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify({ type: "progress", bytes: this.state.receivedBytes }));
    }
  }

  private async handle(data: string | ArrayBuffer) {
    if (this.state.status === "error") return;
    if (typeof data === "string") {
      const msg = parseControl(data);
      if (!msg) return;
      if (msg.type === "manifest" && msg.v === P2P_LOCKED_VERSION && msg.auth) {
        clearTimeout(this.connectTimer);
        this.challenge = msg.auth;
        this.pwMix = null;
        this.update({ status: "password", peerDevice: msg.device, authChecking: false, authRemaining: MAX_PASSWORD_ATTEMPTS });
      } else if (msg.type === "auth-fail") {
        this.pwMix = null;
        this.update({ authChecking: false, authError: true, authRemaining: Math.max(0, Number(msg.remaining) || 0) });
      } else if (msg.type === "auth-ok") {
        this.update({ authError: false });
      } else if (msg.type === "manifest") {
        clearTimeout(this.connectTimer);
        if (msg.protected && !this.pwMix) throw new Error("auth-required");
        const expiring = msg.v === P2P_EXPIRING_VERSION;
        if ((msg.v !== P2P_PROTOCOL_VERSION && !expiring) || msg.chunkSize !== P2P_CHUNK_SIZE) throw new Error("unsupported-protocol");
        if (expiring && !msg.expires) throw new Error("unsupported-protocol");
        // The expiry in the link must be the one the sender set (and vice versa).
        if (this.linkExpires && this.linkExpires !== msg.expires) throw new Error("integrity-error");
        if (!this.linkExpires && this.secret && expiring) throw new Error("integrity-error");
        if (expiring) {
          if (Date.now() >= msg.expires! * 1000) throw new Error("expired");
          this.armExpiry(msg.expires!);
        }
        const secret = this.secret ?? (await unwrapSecret(this.code, msg.wrappedSecret));
        this.key = await deriveFileKey(secret, msg.protected ? this.pwMix! : undefined, expiring ? msg.expires : undefined);
        this.update({
          status: "ready",
          authChecking: false,
          authError: false,
          files: msg.files,
          message: msg.message,
          peerDevice: msg.device,
          streamable: msg.streamable === true,
          ...(expiring ? { expires: msg.expires } : {}),
          totalBytes: msg.files.reduce((n, f) => n + f.size, 0),
        });
        this.channel?.send(JSON.stringify({ type: "hello", device: describeDevice() }));
      } else if (msg.type === "file-end") {
        const info = this.state.files[msg.index];
        if (!info || msg.index !== this.expected.file || msg.chunks !== chunkCount(info.size) || this.expected.chunk !== msg.chunks) {
          throw new Error("integrity-error");
        }
        if (msg.chunks === 0) await this.sink!.open(msg.index, info);
        await this.sink!.close();
        this.expected = { file: msg.index + 1, chunk: 0 };
        this.sendProgress(true);
        this.channel?.send(JSON.stringify({ type: "file-ack", index: msg.index }));
      } else if (msg.type === "done") {
        if (this.expected.file !== this.state.files.length) throw new Error("integrity-error");
        clearInterval(this.stallTimer);
        // Explicit completion ack: sent only after every file was decrypted,
        // verified (AES-GCM tags + chunk/file counts) and written.
        this.channel?.send(JSON.stringify({ type: "ack", bytes: this.state.receivedBytes }));
        this.update({ status: "complete", receivedBytes: this.state.totalBytes });
        // Let the ack flush (TURN can be slow) before tearing anything down.
        setTimeout(() => this.close(), 5000);
      } else if (msg.type === "cancel") {
        this.fail(msg.reason === "sender-stopped" || msg.reason === "expired" ? msg.reason : msg.reason || "cancelled");
      }
      return;
    }
    if (this.streamReader) {
      await this.streamReader.onFrame(data).catch(() => {
        throw new Error("decrypt-error");
      });
      return;
    }
    if (!this.key || !this.sink) throw new Error("unexpected-data");
    const { fileIndex, chunkIndex, plain } = await openChunk(this.key, data).catch(() => {
      throw new Error("decrypt-error");
    });
    if (fileIndex !== this.expected.file || chunkIndex !== this.expected.chunk) throw new Error("integrity-error");
    if (chunkIndex === 0) await this.sink.open(fileIndex, this.state.files[fileIndex]!);
    await this.sink.write(plain);
    this.expected.chunk += 1;
    this.state = { ...this.state, receivedBytes: this.state.receivedBytes + plain.byteLength };
    this.onState(this.state);
    this.sendProgress();
  }

  /** Password gate: answer the sender's challenge (the password never leaves this browser). */
  async submitPassword(password: string): Promise<void> {
    if (this.state.status !== "password" || !this.challenge || this.state.authChecking) return;
    if (!this.channel || this.channel.readyState !== "open") {
      this.fail("sender-disconnected");
      return;
    }
    this.update({ authChecking: true, authError: false });
    const c = this.challenge;
    const keys = await derivePasswordKeys(password, c.salt, c.iter);
    const proof = await passwordProof(keys, this.code, c.nonce);
    this.pwMix = keys.mix;
    this.channel.send(JSON.stringify({ type: "auth", proof }));
  }

  /**
   * Streaming mode (sender advertised `streamable`): instead of the sequential
   * download, chunks are fetched on demand by byte range for a media player.
   */
  startStreaming(): StreamReader {
    if (this.streamReader) return this.streamReader;
    if (this.state.status !== "ready" || !this.state.streamable || !this.key) throw new Error("not-streamable");
    if (!this.channel || this.channel.readyState !== "open") throw new Error("sender-disconnected");
    const channel = this.channel;
    this.streamReader = new StreamReader(
      this.key,
      this.state.files,
      (msg) => channel.readyState === "open" && channel.send(JSON.stringify(msg)),
      (bytes) => this.update({ receivedBytes: bytes }),
    );
    this.update({ status: "streaming", receivedBytes: 0 });
    return this.streamReader;
  }

  /** Call after the user picked a destination (chooseSink in a click handler). */
  download(sink: FileSink) {
    if (this.state.status !== "ready") throw new Error("not-ready");
    if (!this.channel || this.channel.readyState !== "open") {
      this.fail("sender-disconnected");
      return;
    }
    this.sink = sink;
    this.expected = { file: 0, chunk: 0 };
    this.lastData = Date.now();
    this.speedRef = { at: Date.now(), bytes: 0 };
    this.update({ status: "receiving", receivedBytes: 0, speed: 0 });
    this.channel.send(JSON.stringify({ type: "start" }));
    clearInterval(this.stallTimer);
    this.stallTimer = setInterval(() => {
      if (this.state.status !== "receiving") return clearInterval(this.stallTimer);
      if (Date.now() - this.lastData > this.stallTimeoutMs) this.fail("stalled");
    }, 1000);
  }

  close() {
    this.closed = true;
    clearTimeout(this.expiryTimer);
    clearTimeout(this.connectTimer);
    clearInterval(this.stallTimer);
    this.signal.close();
    try { this.pc?.close(); } catch { /* ignore */ }
  }
}
