import { iceServers } from "./config";
import {
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

const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 45_000;

export type SenderStatus =
  | "starting"
  | "waiting"
  | "connecting"
  | "transferring"
  | "complete"
  | "reconnecting"
  | "error"
  | "stopped";

export interface SenderState {
  status: SenderStatus;
  code: string;
  secret: string;
  sentBytes: number;
  totalBytes: number;
  downloads: number;
  error?: string;
}

export type ReceiverStatus =
  | "connecting"
  | "waiting-sender"
  | "negotiating"
  | "ready"
  | "receiving"
  | "complete"
  | "error";

export interface ReceiverState {
  status: ReceiverStatus;
  files: P2PFileInfo[];
  message?: string;
  receivedBytes: number;
  totalBytes: number;
  error?: string;
}

function sendJson(channel: RTCDataChannel, msg: P2PControl) {
  channel.send(JSON.stringify(msg));
}

function waitForDrain(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= HIGH_WATER) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("channel-closed"));
    };
    const cleanup = () => {
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
    };
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
  });
}

async function addRemoteCandidate(pc: RTCPeerConnection, payload: SignalPayload, pending: RTCIceCandidateInit[]) {
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

/**
 * Sender side: holds the files (never loaded fully in memory), serves them to
 * successive receivers for as long as the tab stays open — like file.pizza.
 */
export class P2PSender {
  readonly code: string;
  readonly secret: string;
  private signal: SignalClient;
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private state: SenderState;
  private stopped = false;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly files: File[],
    private readonly onState: (s: SenderState) => void,
    opts: { code?: string; secret?: string; message?: string; signalUrl?: string } = {},
  ) {
    this.code = opts.code ?? createShareCode();
    this.secret = opts.secret ?? createSecret();
    this.message = opts.message;
    this.state = {
      status: "starting",
      code: this.code,
      secret: this.secret,
      sentBytes: 0,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      downloads: 0,
    };
    this.signal = new SignalClient(
      this.code,
      "sender",
      {
        onSignal: (p) => void this.onSignal(p),
        onPeerJoined: () => void this.offer(),
        onPeerLeft: () => {
          if (this.state.status === "connecting" || this.state.status === "transferring") this.resetPeer("waiting");
        },
        onReconnecting: () => this.update({ status: "reconnecting" }),
        onError: (error) => this.update({ status: "error", error }),
      },
      opts.signalUrl,
    );
  }

  private readonly message?: string;

  private update(patch: Partial<SenderState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  getState(): SenderState {
    return this.state;
  }

  async start(): Promise<void> {
    this.update({ status: "starting" });
    await this.signal.connect();
    this.update({ status: "waiting" });
    // If a receiver was already waiting in the room, this reaches it;
    // otherwise the relay answers "waiting" and we re-offer on peer-joined.
    await this.offer();
  }

  private resetPeer(status: SenderStatus) {
    clearTimeout(this.connectTimer);
    try { this.pc?.close(); } catch { /* ignore */ }
    this.pc = null;
    this.pendingIce = [];
    if (!this.stopped) this.update({ status, sentBytes: 0 });
  }

  private async offer() {
    if (this.stopped) return;
    if (this.state.status === "transferring") return;
    this.resetPeer(this.state.status === "complete" ? "complete" : "waiting");
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    this.pc = pc;
    const channel = pc.createDataChannel("filenymous-p2p-v2", { ordered: true });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER;
    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.pc === pc) this.signal.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connecting") this.update({ status: "connecting" });
      if (pc.connectionState === "failed") {
        this.resetPeer("waiting");
        this.update({ error: "ice-failed" });
      }
    };
    channel.onopen = () => {
      clearTimeout(this.connectTimer);
      void this.serve(pc, channel);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal.send({ kind: "offer", sdp: offer.sdp ?? "" });
  }

  private async onSignal(payload: SignalPayload) {
    const pc = this.pc;
    if (!pc) return;
    if (payload.kind === "answer" && pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
      this.update({ status: "connecting" });
      clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => {
        if (this.pc === pc && this.state.status === "connecting") {
          this.resetPeer("waiting");
          this.update({ error: "ice-timeout" });
        }
      }, CONNECT_TIMEOUT_MS);
    } else if (payload.kind === "ice") {
      await addRemoteCandidate(pc, payload, this.pendingIce);
    }
  }

  private async serve(pc: RTCPeerConnection, channel: RTCDataChannel) {
    const key = await deriveFileKey(this.secret);
    sendJson(channel, {
      type: "manifest",
      v: P2P_PROTOCOL_VERSION,
      chunkSize: P2P_CHUNK_SIZE,
      files: this.files.map((f) => ({ name: f.name, size: f.size, mime: f.type || "application/octet-stream" })),
      wrappedSecret: await wrapSecret(this.code, this.secret),
      ...(this.message ? { message: this.message } : {}),
    });
    this.update({ status: "connecting", error: undefined });

    channel.onmessage = async (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseControl(ev.data);
      if (!msg) return;
      if (msg.type === "start") {
        this.update({ status: "transferring", sentBytes: 0 });
        try {
          let sent = 0;
          for (let i = 0; i < this.files.length; i++) {
            const file = this.files[i]!;
            const n = chunkCount(file.size);
            for (let c = 0; c < n; c++) {
              if (this.pc !== pc || channel.readyState !== "open") throw new Error("channel-closed");
              const slice = new Uint8Array(await file.slice(c * P2P_CHUNK_SIZE, (c + 1) * P2P_CHUNK_SIZE).arrayBuffer());
              await waitForDrain(channel);
              channel.send(await sealChunk(key, i, c, slice));
              sent += slice.byteLength;
              this.update({ sentBytes: sent });
            }
            sendJson(channel, { type: "file-end", index: i, chunks: n });
          }
          sendJson(channel, { type: "done" });
        } catch {
          if (this.pc === pc) this.resetPeer("waiting");
        }
      } else if (msg.type === "ack") {
        this.update({ status: "complete", downloads: this.state.downloads + 1, sentBytes: this.state.totalBytes });
        // Ready for the next recipient (multiple downloads while the tab stays open).
        setTimeout(() => {
          if (this.pc === pc) {
            try { pc.close(); } catch { /* ignore */ }
            this.pc = null;
          }
        }, 1000);
      } else if (msg.type === "cancel") {
        this.resetPeer("waiting");
      }
    };
    channel.onclose = () => {
      if (this.pc === pc && this.state.status === "transferring") this.resetPeer("waiting");
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.connectTimer);
    try { this.pc?.close(); } catch { /* ignore */ }
    this.pc = null;
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
  private state: ReceiverState = { status: "connecting", files: [], receivedBytes: 0, totalBytes: 0 };
  private sink: FileSink | null = null;
  private queue: Promise<void> = Promise.resolve();
  private expected = { file: 0, chunk: 0 };
  private connectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly code: string,
    private readonly secret: string | undefined,
    private readonly onState: (s: ReceiverState) => void,
    signalUrl?: string,
  ) {
    this.signal = new SignalClient(
      code,
      "receiver",
      {
        onSignal: (p) => void this.onSignal(p),
        onPeerLeft: () => {
          if (this.state.status !== "complete") this.update({ status: "waiting-sender" });
        },
        onError: (error) => this.update({ status: "error", error }),
      },
      signalUrl,
    );
  }

  private update(patch: Partial<ReceiverState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  private closed = false;

  async start(): Promise<void> {
    // Someone else may be downloading right now (one receiver at a time per
    // code): keep retrying quietly, like file.pizza's "waiting" state.
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
      if (this.state.status === "receiving" || this.state.status === "complete") return;
      try { this.pc?.close(); } catch { /* ignore */ }
      this.pendingIce = [];
      const pc = new RTCPeerConnection({ iceServers: await iceServers() });
      this.pc = pc;
      this.update({ status: "negotiating" });
      pc.onicecandidate = (ev) => {
        if (ev.candidate && this.pc === pc) this.signal.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) });
      };
      pc.onconnectionstatechange = () => {
        if (this.pc === pc && pc.connectionState === "failed") this.update({ status: "error", error: "ice-failed" });
      };
      pc.ondatachannel = (ev) => this.attach(ev.channel);
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal.send({ kind: "answer", sdp: answer.sdp ?? "" });
      clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => {
        if (this.pc === pc && this.state.status === "negotiating") this.update({ status: "error", error: "ice-timeout" });
      }, CONNECT_TIMEOUT_MS);
    } else if (payload.kind === "ice" && this.pc) {
      await addRemoteCandidate(this.pc, payload, this.pendingIce);
    }
  }

  private attach(channel: RTCDataChannel) {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onmessage = (ev) => {
      const data = ev.data as string | ArrayBuffer;
      this.queue = this.queue.then(() => this.handle(data)).catch((e) => {
        void this.sink?.abort();
        this.update({ status: "error", error: String((e as Error).message || e) });
        try { channel.send(JSON.stringify({ type: "cancel", reason: "receiver-error" })); } catch { /* ignore */ }
      });
    };
    channel.onclose = () => {
      if (this.state.status === "receiving") this.update({ status: "error", error: "sender-disconnected" });
    };
  }

  private async handle(data: string | ArrayBuffer) {
    if (typeof data === "string") {
      const msg = parseControl(data);
      if (!msg) return;
      if (msg.type === "manifest") {
        clearTimeout(this.connectTimer);
        if (msg.v !== P2P_PROTOCOL_VERSION || msg.chunkSize !== P2P_CHUNK_SIZE) throw new Error("unsupported-protocol");
        const secret = this.secret ?? (await unwrapSecret(this.code, msg.wrappedSecret));
        this.key = await deriveFileKey(secret);
        this.update({
          status: "ready",
          files: msg.files,
          message: msg.message,
          totalBytes: msg.files.reduce((n, f) => n + f.size, 0),
        });
      } else if (msg.type === "file-end") {
        const info = this.state.files[msg.index];
        if (!info || msg.index !== this.expected.file || msg.chunks !== chunkCount(info.size) || this.expected.chunk !== msg.chunks) {
          throw new Error("integrity-error");
        }
        if (msg.chunks === 0) await this.sink!.open(msg.index, info);
        await this.sink!.close();
        this.expected = { file: msg.index + 1, chunk: 0 };
      } else if (msg.type === "done") {
        if (this.expected.file !== this.state.files.length) throw new Error("integrity-error");
        this.channel?.send(JSON.stringify({ type: "ack" }));
        this.update({ status: "complete", receivedBytes: this.state.totalBytes });
        // Free the receiver slot right away so the next recipient can join.
        this.signal.close();
        setTimeout(() => this.close(), 1500);
      }
      return;
    }
    if (!this.key || !this.sink) throw new Error("unexpected-data");
    const { fileIndex, chunkIndex, plain } = await openChunk(this.key, data);
    if (fileIndex !== this.expected.file || chunkIndex !== this.expected.chunk) throw new Error("integrity-error");
    if (chunkIndex === 0) await this.sink.open(fileIndex, this.state.files[fileIndex]!);
    await this.sink.write(plain);
    this.expected.chunk += 1;
    this.update({ receivedBytes: this.state.receivedBytes + plain.byteLength });
  }

  /** Call after the user picked a destination (chooseSink in a click handler). */
  download(sink: FileSink) {
    if (this.state.status !== "ready" || !this.channel) throw new Error("not-ready");
    this.sink = sink;
    this.expected = { file: 0, chunk: 0 };
    this.update({ status: "receiving", receivedBytes: 0 });
    this.channel.send(JSON.stringify({ type: "start" }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.connectTimer);
    this.signal.close();
    try { this.pc?.close(); } catch { /* ignore */ }
  }
}
