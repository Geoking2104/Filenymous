import { iceServers } from "../config";
import { openChunk, type P2PFileInfo } from "../protocol";
import { CONNECT_TIMEOUT_MS, addRemoteCandidate } from "../session";
import { iceCandidateInit, type SignalPayload } from "../signal";
import { MemorySink, type FileSink } from "../sink";
import { holdUnloadGuard, releaseUnloadGuard } from "../unloadGuard";
import { checkProof, dropBaseMaterial, deriveDropKey, parseDropControl, sealProof, type DropControl } from "./crypto";
import { DropSignalClient } from "./dropSignal";
import { isExpired, type OwnerDropParams } from "./link";

export type OwnerStatus = "starting" | "online" | "reconnecting" | "expired" | "error" | "stopped";
export type ContributionStatus = "verifying" | "receiving" | "confirming" | "done" | "failed";

export interface Contribution {
  id: string;
  status: ContributionStatus;
  files: P2PFileInfo[];
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  error?: string;
}

export interface OwnerState {
  status: OwnerStatus;
  contributions: Contribution[];
  /** Contributor transfers not yet fully confirmed by both sides. */
  active: number;
  error?: string;
}

interface Peer {
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
}

export interface DropOwnerOptions {
  signalUrl?: string;
  sinkFactory?: () => FileSink;
  maxParallel?: number;
}

const ACTIVE: ContributionStatus[] = ["verifying", "receiving", "confirming"];

/**
 * Owner side of a 100 % P2P Dropzone: this tab is the receiver. Each
 * contributor opens its own RTCPeerConnection; files are decrypted and handed
 * to a FileSink locally, nothing is stored on any server.
 */
export class DropOwner {
  private signal: DropSignalClient;
  private peers = new Map<string, Peer>();
  private base: Uint8Array | null = null;
  private state: OwnerState = { status: "starting", contributions: [], active: 0 };
  private seq = 0;
  private stopped = false;
  private readonly sinkFactory: () => FileSink;
  private readonly maxParallel: number;

  constructor(
    private readonly params: OwnerDropParams,
    private readonly password: string | undefined,
    private readonly onState: (s: OwnerState) => void,
    opts: DropOwnerOptions = {},
  ) {
    this.sinkFactory = opts.sinkFactory ?? (() => new MemorySink());
    this.maxParallel = opts.maxParallel ?? 4;
    this.signal = new DropSignalClient(
      { dropId: params.dropId, role: "owner", ownerSecret: params.ownerSecret, ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}) },
      {
        onJoined: () => this.update({ status: "online", error: undefined }),
        onSignal: (p, from) => void this.onSignal(p, from),
        onPeerLeft: (peerId) => this.dropPeer(peerId),
        onExpired: () => this.expire(),
        onReconnecting: () => this.update({ status: "reconnecting" }),
        onError: (error) => this.update({ error }),
      },
      opts.signalUrl,
    );
  }

  private update(patch: Partial<OwnerState>) {
    this.state = { ...this.state, ...patch };
    this.state.active = this.state.contributions.filter((c) => ACTIVE.includes(c.status)).length;
    this.onState(this.state);
  }

  private patchContribution(id: string, patch: Partial<Contribution>) {
    this.update({ contributions: this.state.contributions.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  }

  getState(): OwnerState {
    return this.state;
  }

  async start(): Promise<void> {
    if (isExpired(this.params)) {
      this.update({ status: "expired" });
      return;
    }
    this.base = await dropBaseMaterial(this.params, this.password);
    try {
      await this.signal.connect();
    } catch (e) {
      const error = String((e as Error).message || e);
      this.update(error === "drop-expired" ? { status: "expired" } : { status: "error", error });
    }
  }

  private expire() {
    for (const id of Array.from(this.peers.keys())) this.dropPeer(id);
    this.update({ status: "expired" });
  }

  private dropPeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    try { peer.pc.close(); } catch { /* ignore */ }
  }

  private async onSignal(payload: SignalPayload, from?: string) {
    if (!from || this.stopped) return;
    if (payload.kind === "offer") {
      if (isExpired(this.params)) return;
      this.dropPeer(from);
      const pc = new RTCPeerConnection({ iceServers: await iceServers() });
      const peer: Peer = { pc, pendingIce: [] };
      this.peers.set(from, peer);
      pc.onicecandidate = (ev) => {
        if (ev.candidate && this.peers.get(from) === peer) this.signal.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) }, from);
      };
      pc.ondatachannel = (ev) => {
        ev.channel.binaryType = "arraybuffer";
        this.serve(from, peer, ev.channel);
      };
      const timer = setTimeout(() => {
        if (this.peers.get(from) === peer && pc.connectionState !== "connected") this.dropPeer(from);
      }, CONNECT_TIMEOUT_MS);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") clearTimeout(timer);
        if (pc.connectionState === "failed" && this.peers.get(from) === peer) this.dropPeer(from);
      };
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      for (const c of peer.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal.send({ kind: "answer", sdp: answer.sdp ?? "" }, from);
    } else if (payload.kind === "ice") {
      const peer = this.peers.get(from);
      if (peer) await addRemoteCandidate(peer.pc, payload, peer.pendingIce);
    }
  }

  private serve(peerId: string, peer: Peer, channel: RTCDataChannel) {
    let key: CryptoKey | null = null;
    let id: string | null = null;
    let sink: FileSink | null = null;
    let files: P2PFileInfo[] = [];
    let cur = 0;
    let chunk = 0;
    let fileBytes = 0;
    let received = 0;
    let queue = Promise.resolve();
    const guard = () => `drop-owner:${id}`;
    const send = (msg: DropControl) => {
      if (channel.readyState === "open") channel.send(JSON.stringify(msg));
    };
    const status = () => this.state.contributions.find((c) => c.id === id)?.status;
    const finish = (s: "done" | "failed", error?: string) => {
      if (!id) return;
      const st = status();
      if (st === "done" || st === "failed") return;
      releaseUnloadGuard(guard());
      if (s === "failed") void sink?.abort();
      this.patchContribution(id, { status: s, ...(error ? { error } : {}) });
    };
    const fail = (error: string) => {
      finish("failed", error);
      send({ type: "cancel", reason: error });
      setTimeout(() => this.peers.get(peerId) === peer && this.dropPeer(peerId), 300);
    };

    const handle = async (data: string | ArrayBuffer) => {
      if (typeof data !== "string") {
        if (!key || !sink || status() !== "receiving") return fail("protocol");
        let frame;
        try {
          frame = await openChunk(key, data);
        } catch {
          return fail("integrity");
        }
        if (frame.fileIndex !== cur || frame.chunkIndex !== chunk) return fail("order");
        fileBytes += frame.plain.byteLength;
        received += frame.plain.byteLength;
        if (fileBytes > files[cur]!.size) return fail("size");
        await sink.write(frame.plain);
        chunk++;
        this.patchContribution(id!, { receivedBytes: received });
        return;
      }
      const msg = parseDropControl(data);
      if (!msg) return fail("protocol");
      switch (msg.type) {
        case "drop-hello": {
          if (id) return fail("protocol");
          if (isExpired(this.params)) {
            send({ type: "drop-reject", reason: "expired" });
            return;
          }
          if (this.state.active >= this.maxParallel) {
            send({ type: "drop-reject", reason: "busy" });
            return;
          }
          const k = await deriveDropKey(this.params, this.base!, msg.sid);
          if (!(await checkProof(k, msg.proof, `hello:${msg.sid}`))) {
            send({ type: "drop-reject", reason: "bad-password" });
            return;
          }
          key = k;
          id = `c${++this.seq}`;
          holdUnloadGuard(guard());
          this.update({
            contributions: [
              ...this.state.contributions,
              { id, status: "verifying", files: [], receivedBytes: 0, totalBytes: 0, startedAt: Date.now() },
            ],
          });
          send({ type: "drop-ready", proof: await sealProof(k, `ready:${msg.sid}`) });
          return;
        }
        case "drop-manifest": {
          if (!key || status() !== "verifying") return fail("protocol");
          files = msg.files;
          sink = this.sinkFactory();
          this.patchContribution(id!, { status: "receiving", files, totalBytes: files.reduce((n, f) => n + f.size, 0) });
          await sink.open(0, files[0]!);
          return;
        }
        case "file-end": {
          if (!sink || status() !== "receiving") return fail("protocol");
          if (msg.index !== cur || msg.chunks !== chunk || fileBytes !== files[cur]!.size) return fail("size");
          await sink.close();
          cur++;
          chunk = 0;
          fileBytes = 0;
          if (cur < files.length) await sink.open(cur, files[cur]!);
          return;
        }
        case "done": {
          if (status() !== "receiving" || cur !== files.length) return fail("protocol");
          this.patchContribution(id!, { status: "confirming" });
          send({ type: "drop-receipt", files: files.length, bytes: received });
          return;
        }
        case "ack": {
          if (status() !== "confirming") return fail("protocol");
          finish("done");
          setTimeout(() => this.peers.get(peerId) === peer && this.dropPeer(peerId), 1000);
          return;
        }
        case "cancel":
          finish("failed", msg.reason || "cancelled");
          return;
        default:
          return fail("protocol");
      }
    };

    channel.onmessage = (ev) => {
      queue = queue.then(() => handle(ev.data)).catch(() => fail("error"));
    };
    channel.onclose = () => {
      queue = queue.then(() => {
        // Receipt sent and every byte written: the files are safe locally even
        // if the contributor vanished before acknowledging.
        if (status() === "confirming") finish("done");
        else finish("failed", "disconnected");
      });
    };
  }

  stop() {
    this.stopped = true;
    for (const c of this.state.contributions) releaseUnloadGuard(`drop-owner:${c.id}`);
    for (const id of Array.from(this.peers.keys())) this.dropPeer(id);
    this.signal.close();
    this.update({ status: "stopped" });
  }
}
