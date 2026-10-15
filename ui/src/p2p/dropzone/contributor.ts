import { iceServers } from "../config";
import { P2P_CHUNK_SIZE, chunkCount, sealChunk, type P2PFileInfo } from "../protocol";
import { CONNECT_TIMEOUT_MS, LOW_WATER, addRemoteCandidate, waitForDrain } from "../session";
import { iceCandidateInit, type SignalPayload } from "../signal";
import { holdUnloadGuard, releaseUnloadGuard } from "../unloadGuard";
import { checkProof, createSessionId, dropBaseMaterial, deriveDropKey, parseDropControl, sealProof, DROP_PROTOCOL_VERSION, type DropControl } from "./crypto";
import { DropSignalClient } from "./dropSignal";
import { isExpired, type DropParams } from "./link";

export type ContributorStatus =
  | "connecting"
  | "owner-offline"
  | "ready"
  | "handshake"
  | "sending"
  | "confirming"
  | "complete"
  | "rejected"
  | "expired"
  | "error";

export interface ContributorState {
  status: ContributorStatus;
  files: P2PFileInfo[];
  sentBytes: number;
  totalBytes: number;
  ownerOnline: boolean;
  /** Set when status is "rejected": bad-password | expired | busy | protocol | owner-proof */
  reason?: string;
  error?: string;
}

const IN_FLIGHT: ContributorStatus[] = ["handshake", "sending", "confirming"];

function randomPeerId(): string {
  return `c-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Contributor side: sends files straight to the owner's tab. The tab-close
 * guard is held from the moment files are chosen until the owner has
 * confirmed reception (`drop-receipt`).
 */
export class DropContributor {
  private signal: DropSignalClient;
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private files: File[] = [];
  private base: Uint8Array | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly guard = `drop-contributor:${Math.random().toString(36).slice(2)}`;
  private state: ContributorState = { status: "connecting", files: [], sentBytes: 0, totalBytes: 0, ownerOnline: false };

  constructor(
    private readonly params: DropParams,
    private readonly onState: (s: ContributorState) => void,
    opts: { signalUrl?: string } = {},
  ) {
    this.signal = new DropSignalClient(
      { dropId: params.dropId, role: "contributor", peerId: randomPeerId() },
      {
        onJoined: ({ ownerOnline }) => this.setOwnerOnline(!!ownerOnline),
        onSignal: (p) => void this.onSignal(p),
        onOwnerOnline: () => this.setOwnerOnline(true),
        onOwnerOffline: () => this.setOwnerOnline(false),
        onExpired: () => this.terminal({ status: "expired" }),
        onReconnecting: () => {
          if (!IN_FLIGHT.includes(this.state.status)) this.update({ status: "connecting" });
        },
        onError: (error) => this.update({ error }),
      },
      opts.signalUrl,
    );
  }

  private update(patch: Partial<ContributorState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  getState(): ContributorState {
    return this.state;
  }

  async start(): Promise<void> {
    if (isExpired(this.params)) {
      this.update({ status: "expired" });
      return;
    }
    try {
      await this.signal.connect();
    } catch (e) {
      const error = String((e as Error).message || e);
      this.update(error === "drop-expired" ? { status: "expired" } : { status: "error", error });
    }
  }

  private terminal(patch: Partial<ContributorState>) {
    this.resetPeer();
    releaseUnloadGuard(this.guard);
    this.update(patch);
  }

  private setOwnerOnline(online: boolean) {
    this.update({ ownerOnline: online });
    const s = this.state.status;
    if (s === "complete" || s === "expired" || s === "rejected") return;
    if (!online) {
      // Transfer interrupted: keep the files and the guard, retry when the owner is back.
      this.resetPeer();
      this.update({ status: "owner-offline", sentBytes: 0 });
      return;
    }
    if (this.files.length && this.base && !IN_FLIGHT.includes(s)) void this.begin();
    else if (!IN_FLIGHT.includes(s)) this.update({ status: "ready" });
  }

  /** Call after the files are chosen (and the password typed, if the link needs one). */
  async send(files: File[], password?: string): Promise<void> {
    if (!files.length || IN_FLIGHT.includes(this.state.status) || this.state.status === "expired") return;
    if (isExpired(this.params)) {
      this.update({ status: "expired" });
      return;
    }
    this.files = files;
    holdUnloadGuard(this.guard);
    this.update({
      files: files.map((f) => ({ name: f.name, size: f.size, mime: f.type || "application/octet-stream" })),
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      sentBytes: 0,
      reason: undefined,
      error: undefined,
    });
    this.base = await dropBaseMaterial(this.params, password);
    if (this.state.ownerOnline) await this.begin();
    else this.update({ status: "owner-offline" });
  }

  private resetPeer() {
    clearTimeout(this.retryTimer);
    try { this.pc?.close(); } catch { /* ignore */ }
    this.pc = null;
    this.pendingIce = [];
  }

  private async begin() {
    this.resetPeer();
    const sid = createSessionId();
    const key = await deriveDropKey(this.params, this.base!, sid);
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    this.pc = pc;
    this.update({ status: "handshake", sentBytes: 0 });
    const channel = pc.createDataChannel("filenymous-drop-v1", { ordered: true });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER;
    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.pc === pc) this.signal.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && pc.connectionState === "failed") this.retry("ice-failed");
    };
    this.retryTimer = setTimeout(() => {
      if (this.pc === pc && this.state.status === "handshake") this.retry("ice-timeout");
    }, CONNECT_TIMEOUT_MS);
    const send = (msg: DropControl) => channel.send(JSON.stringify(msg));
    channel.onopen = async () => send({ type: "drop-hello", v: DROP_PROTOCOL_VERSION, sid, proof: await sealProof(key, `hello:${sid}`) });
    channel.onmessage = async (ev) => {
      if (this.pc !== pc || typeof ev.data !== "string") return;
      const msg = parseDropControl(ev.data);
      if (!msg) return;
      if (msg.type === "drop-ready") {
        clearTimeout(this.retryTimer);
        if (!(await checkProof(key, msg.proof, `ready:${sid}`))) return this.terminal({ status: "rejected", reason: "owner-proof" });
        await this.stream(pc, channel, key, send);
      } else if (msg.type === "drop-reject") {
        if (msg.reason === "busy") {
          this.resetPeer();
          this.update({ status: "owner-offline", reason: "busy" });
          this.retryTimer = setTimeout(() => this.state.ownerOnline && void this.begin(), 3000);
          return;
        }
        this.terminal({ status: msg.reason === "expired" ? "expired" : "rejected", reason: msg.reason });
      } else if (msg.type === "drop-receipt") {
        const ok = msg.files === this.files.length && msg.bytes === this.state.totalBytes;
        if (!ok) return this.retry("receipt-mismatch");
        send({ type: "ack" });
        this.files = [];
        releaseUnloadGuard(this.guard);
        this.update({ status: "complete", sentBytes: this.state.totalBytes });
        setTimeout(() => this.pc === pc && this.resetPeer(), 1000);
      } else if (msg.type === "cancel") {
        this.retry(msg.reason || "cancelled");
      }
    };
    channel.onclose = () => {
      if (this.pc === pc && IN_FLIGHT.includes(this.state.status)) this.retry("disconnected");
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
    } else if (payload.kind === "ice") {
      await addRemoteCandidate(pc, payload, this.pendingIce);
    }
  }

  private async stream(pc: RTCPeerConnection, channel: RTCDataChannel, key: CryptoKey, send: (m: DropControl) => void) {
    this.update({ status: "sending", sentBytes: 0 });
    send({ type: "drop-manifest", files: this.state.files });
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
        send({ type: "file-end", index: i, chunks: n });
      }
      send({ type: "done" });
      this.update({ status: "confirming" });
    } catch {
      if (this.pc === pc) this.retry("disconnected");
    }
  }

  /** Transient failure: start over from the first byte when possible. */
  private retry(error: string) {
    this.resetPeer();
    if (!this.files.length) return;
    this.update({ status: this.state.ownerOnline ? "ready" : "owner-offline", error, sentBytes: 0 });
    if (this.state.ownerOnline) this.retryTimer = setTimeout(() => void this.begin(), 1500);
  }

  close() {
    this.resetPeer();
    releaseUnloadGuard(this.guard);
    this.signal.close();
  }
}
