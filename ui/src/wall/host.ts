import { iceServers } from "../p2p/config";
import { CONNECT_TIMEOUT_MS, LOW_WATER, addRemoteCandidate, waitForDrain } from "../p2p/session";
import { iceCandidateInit, type SignalPayload } from "../p2p/signal";
import { holdUnloadGuard, releaseUnloadGuard } from "../p2p/unloadGuard";
import { SealedPipe, checkProof, deriveWallKeys, parseHandshake, sealProof, wallBaseMaterial } from "./crypto";
import { isExpired, type HostWallParams } from "./link";
import {
  MAX_TEXT_BYTES,
  WALL_CHUNK,
  WallStore,
  parseWallMessage,
  type DestroyReason,
  type ItemKind,
  type ItemMeta,
  type WallMessage,
} from "./model";
import { WallSignalClient, type WallJoin } from "./signal";

export const MAX_PEERS = 8;
export const HOST_LABEL = "host";
export const HOST_GUARD = "wall-host";

export type HostStatus = "starting" | "online" | "reconnecting" | "destroyed" | "expired" | "error";

export interface HostPeerInfo {
  id: string;
  label: string;
}

export interface HostState {
  status: HostStatus;
  items: ItemMeta[];
  peers: HostPeerInfo[];
  expiresAt: number;
  error?: string;
  notice?: string;
}

interface Upload {
  kind: ItemKind;
  name: string;
  mime: string;
  size: number;
  parts: Uint8Array[];
  bytes: number;
}

interface Peer {
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  channel?: RTCDataChannel;
  pipe?: SealedPipe;
  label?: string;
  uploads: Map<number, Upload>;
  out: Promise<void>;
}

export interface WallHostOptions {
  signalUrl?: string;
  password?: string;
}

/**
 * Host of a Sharewall. The host's tab is the hub of a star: every peer opens
 * one WebRTC DataChannel to the host only, sends its items there and fetches
 * other items on demand. Items live in this tab's memory and nowhere else.
 */
export class WallHost {
  readonly store: WallStore;
  private signal: WallSignalClient | null = null;
  private peers = new Map<string, Peer>();
  private base: Uint8Array | null = null;
  private labelSeq = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private done = false;
  state: HostState;

  constructor(
    readonly params: HostWallParams,
    private readonly onState: (s: HostState) => void,
    private readonly opts: WallHostOptions = {},
  ) {
    this.store = new WallStore(params.burn);
    this.state = { status: "starting", items: [], peers: [], expiresAt: params.expiresAt };
  }

  private update(patch: Partial<HostState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  async start(): Promise<void> {
    if (isExpired(this.params)) return this.finish("expired", false);
    const base = await wallBaseMaterial(this.params, this.opts.password);
    if (this.done) return;
    this.base = base;
    this.tick = setInterval(() => {
      if (!this.done && isExpired(this.params)) void this.destroy("expired");
    }, 1000);
    const join: WallJoin = {
      wallId: this.params.wallId,
      role: "host",
      hostSecret: this.params.hostSecret,
      expiresAt: this.params.expiresAt,
      destroyOnHostLeave: this.params.hostLeave,
    };
    this.signal = new WallSignalClient(
      join,
      {
        onJoined: () => this.update({ status: "online", error: undefined }),
        onSignal: (p, from) => void this.onSignal(p, from).catch(() => from && this.dropPeer(from)),
        onPeerLeft: (id) => {
          // A peer whose DataChannel is up keeps its session even if its
          // WebSocket drops; only peers still negotiating are cleaned up.
          const p = this.peers.get(id);
          if (p && !p.pipe) this.dropPeer(id);
        },
        onReconnecting: () => !this.done && this.update({ status: "reconnecting" }),
        onClosed: (reason) => void this.finish(reason === "expired" ? "expired" : "destroyed", false),
        onError: (e) => !this.done && this.update({ error: e }),
      },
      this.opts.signalUrl,
    );
    try {
      await this.signal.connect();
    } catch (e) {
      const error = String((e as Error).message || e);
      if (error === "wall-closed") return this.finish("destroyed", false);
      this.update({ status: "error", error });
    }
  }

  private readyPeers(): Array<[string, Peer]> {
    return Array.from(this.peers.entries()).filter(([, p]) => p.pipe && p.channel?.readyState === "open");
  }

  private refresh() {
    const ready = this.readyPeers();
    const items = this.store.list();
    this.update({ items, peers: ready.map(([id, p]) => ({ id, label: p.label! })) });
    if (ready.length && !this.done) holdUnloadGuard(HOST_GUARD);
    else releaseUnloadGuard(HOST_GUARD);
    for (const [, p] of ready) this.sendControl(p, { t: "state", items, peers: ready.length });
  }

  /** Serializes sealing + sending per peer so frame counters match the wire order. */
  private enqueue(peer: Peer, job: () => Promise<void>): Promise<void> {
    const run = peer.out.then(job, job);
    peer.out = run.catch(() => undefined);
    return run;
  }

  private sendControl(peer: Peer, msg: WallMessage): Promise<void> {
    return this.enqueue(peer, async () => {
      if (!peer.pipe || peer.channel?.readyState !== "open") return;
      peer.channel.send(await peer.pipe.sealControl(msg));
    });
  }

  private dropPeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.uploads.clear();
    try { peer.pc.close(); } catch { /* ignore */ }
    this.refresh();
  }

  private async onSignal(payload: SignalPayload, from?: string) {
    if (!from || this.done) return;
    if (payload.kind === "offer") {
      if (isExpired(this.params)) return;
      this.dropPeer(from);
      if (this.peers.size >= MAX_PEERS) return;
      const pc = new RTCPeerConnection({ iceServers: await iceServers() });
      const peer: Peer = { pc, pendingIce: [], uploads: new Map(), out: Promise.resolve() };
      this.peers.set(from, peer);
      pc.onicecandidate = (ev) => {
        if (ev.candidate && this.peers.get(from) === peer) this.signal?.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) }, from);
      };
      pc.ondatachannel = (ev) => {
        ev.channel.binaryType = "arraybuffer";
        ev.channel.bufferedAmountLowThreshold = LOW_WATER;
        this.serve(from, peer, ev.channel);
      };
      const timer = setTimeout(() => {
        if (this.peers.get(from) === peer && !peer.pipe) this.dropPeer(from);
      }, CONNECT_TIMEOUT_MS);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          clearTimeout(timer);
          if (this.peers.get(from) === peer) this.dropPeer(from);
        }
      };
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      for (const c of peer.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal?.send({ kind: "answer", sdp: answer.sdp ?? "" }, from);
    } else if (payload.kind === "ice") {
      const peer = this.peers.get(from);
      if (peer) await addRemoteCandidate(peer.pc, payload, peer.pendingIce);
    }
  }

  private serve(peerId: string, peer: Peer, channel: RTCDataChannel) {
    peer.channel = channel;
    let queue = Promise.resolve();
    const kick = (): void => {
      setTimeout(() => this.peers.get(peerId) === peer && this.dropPeer(peerId), 300);
    };
    const plain = (msg: object) => channel.readyState === "open" && channel.send(JSON.stringify(msg));

    const handshake = async (text: string) => {
      const hello = parseHandshake(text);
      if (!hello || hello.type !== "wall-hello" || !this.base) {
        plain({ type: "wall-reject", reason: "protocol" });
        return kick();
      }
      if (this.done || isExpired(this.params)) {
        plain({ type: "wall-reject", reason: "closed" });
        return kick();
      }
      const keys = await deriveWallKeys(this.params, this.base, hello.sid);
      if (!(await checkProof(keys.proof, hello.proof, `hello:${hello.sid}`))) {
        plain({ type: "wall-reject", reason: "bad-password" });
        return kick();
      }
      // Host seals with the "down" key and opens with the "up" key.
      peer.pipe = new SealedPipe(keys.down, keys.up);
      peer.label = `peer:${++this.labelSeq}`;
      plain({ type: "wall-ready", proof: await sealProof(keys.proof, `ready:${hello.sid}`) });
      void this.sendControl(peer, { t: "welcome", label: peer.label, expiresAt: this.params.expiresAt, burn: this.params.burn, hostLeave: this.params.hostLeave });
      this.refresh();
    };

    const handle = async (data: string | ArrayBuffer) => {
      if (this.peers.get(peerId) !== peer) return;
      if (!peer.pipe) {
        if (typeof data !== "string") return kick();
        return handshake(data);
      }
      if (typeof data === "string") return kick();
      let frame;
      try {
        frame = await peer.pipe.open(data);
      } catch {
        return this.dropPeer(peerId);
      }
      if (frame.bytes) {
        const up = peer.uploads.get(frame.stream);
        if (!up) return; // upload already refused: ignore its in-flight frames
        up.bytes += frame.bytes.byteLength;
        if (up.bytes > up.size) {
          peer.uploads.delete(frame.stream);
          return void this.sendControl(peer, { t: "put-fail", uid: frame.stream, reason: "size" });
        }
        up.parts.push(frame.bytes);
        return;
      }
      const msg = parseWallMessage(frame.control);
      if (!msg) return this.dropPeer(peerId);
      await this.onPeerMessage(peerId, peer, msg);
    };

    channel.onmessage = (ev) => {
      queue = queue.then(() => handle(ev.data as string | ArrayBuffer)).catch(() => this.dropPeer(peerId));
    };
    channel.onclose = () => this.peers.get(peerId) === peer && this.dropPeer(peerId);
  }

  private async onPeerMessage(peerId: string, peer: Peer, msg: WallMessage) {
    switch (msg.t) {
      case "put": {
        const reason = this.done ? "closed" : this.store.admit(msg.kind, msg.size);
        if (reason || peer.uploads.has(msg.uid)) return void this.sendControl(peer, { t: "put-fail", uid: msg.uid, reason: reason ?? "protocol" });
        peer.uploads.set(msg.uid, { kind: msg.kind, name: msg.name, mime: msg.mime, size: msg.size, parts: [], bytes: 0 });
        return;
      }
      case "put-end": {
        const up = peer.uploads.get(msg.uid);
        if (!up) return;
        peer.uploads.delete(msg.uid);
        const reason = up.bytes !== up.size ? "size" : this.store.admit(up.kind, up.size);
        if (reason) return void this.sendControl(peer, { t: "put-fail", uid: msg.uid, reason });
        const meta = this.store.add({
          kind: up.kind,
          name: up.name,
          mime: up.kind === "text" ? "text/plain" : up.mime,
          by: peer.label!,
          owner: peerId,
          data: new Blob(up.parts as BlobPart[], { type: up.kind === "text" ? "text/plain" : up.mime }),
        });
        up.parts = [];
        void this.sendControl(peer, { t: "put-ok", uid: msg.uid, id: meta.id });
        return this.refresh();
      }
      case "get": {
        const got = this.store.take(msg.id, peerId);
        if (!got) return void this.sendControl(peer, { t: "get-fail", rid: msg.rid, reason: "gone" });
        if (got.burned) this.refresh();
        void this.streamItem(peer, msg.rid, got.meta, got.data);
        return;
      }
      case "bye":
        return this.dropPeer(peerId);
      default:
        return this.dropPeer(peerId);
    }
  }

  private streamItem(peer: Peer, rid: number, meta: ItemMeta, data: Blob): Promise<void> {
    return this.enqueue(peer, async () => {
      const ch = peer.channel;
      const pipe = peer.pipe;
      if (!pipe || ch?.readyState !== "open") return;
      ch.send(await pipe.sealControl({ t: "get-begin", rid, item: meta } satisfies WallMessage));
      let chunks = 0;
      for (let off = 0; off < data.size; off += WALL_CHUNK) {
        if (this.done || ch.readyState !== "open") return;
        const bytes = new Uint8Array(await data.slice(off, off + WALL_CHUNK).arrayBuffer());
        ch.send(await pipe.sealData(rid, bytes));
        chunks++;
        await waitForDrain(ch);
      }
      ch.send(await pipe.sealControl({ t: "get-end", rid, chunks } satisfies WallMessage));
    });
  }

  // ---- host-side actions ---------------------------------------------------

  /** Adds files dropped by the host; returns the refusal reasons (if any) by file name. */
  async addFiles(files: File[]): Promise<Array<{ name: string; reason: string }>> {
    const refused: Array<{ name: string; reason: string }> = [];
    for (const f of files) {
      const reason = this.done ? "closed" : this.store.admit("file", f.size);
      if (reason) {
        refused.push({ name: f.name, reason });
        continue;
      }
      // Copy into memory so the item no longer depends on the file on disk.
      const data = new Blob([await f.arrayBuffer()], { type: f.type || "application/octet-stream" });
      this.store.add({ kind: "file", name: f.name, mime: f.type, by: HOST_LABEL, owner: HOST_LABEL, data });
    }
    this.refresh();
    return refused;
  }

  addText(text: string, title = ""): string | null {
    const data = new Blob([text], { type: "text/plain" });
    const reason = this.done ? "closed" : data.size > MAX_TEXT_BYTES ? "text-too-large" : this.store.admit("text", data.size);
    if (reason) return reason;
    this.store.add({ kind: "text", name: title, mime: "text/plain", by: HOST_LABEL, owner: HOST_LABEL, data });
    this.refresh();
    return null;
  }

  /** The host opening an item counts as a download (burns it unless the host wrote it). */
  fetch(id: string): { meta: ItemMeta; data: Blob } | null {
    const got = this.store.take(id, HOST_LABEL);
    if (got?.burned) this.refresh();
    return got;
  }

  removeItem(id: string) {
    if (this.store.remove(id)) this.refresh();
  }

  /** Kill switch: tells every peer to wipe, closes the room on the relay, wipes the host. */
  async destroy(reason: DestroyReason = "destroyed"): Promise<void> {
    if (this.done) return;
    const ready = this.readyPeers();
    await Promise.race([
      Promise.all(ready.map(([, p]) => this.sendControl(p, { t: "destroy", reason }))),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    this.signal?.closeWall();
    // Give the SCTP stack a moment to flush the sealed "destroy" before closing.
    await new Promise((r) => setTimeout(r, 200));
    this.finish(reason === "expired" ? "expired" : "destroyed", false);
  }

  private finish(status: "destroyed" | "expired", notify: boolean) {
    if (this.done) return;
    this.done = true;
    if (notify) for (const [, p] of this.readyPeers()) void this.sendControl(p, { t: "destroy", reason: status === "expired" ? "expired" : "destroyed" });
    if (this.tick) clearInterval(this.tick);
    for (const p of this.peers.values()) {
      try { p.pc.close(); } catch { /* ignore */ }
    }
    this.peers.clear();
    this.store.wipe();
    this.base = null;
    this.signal?.close();
    releaseUnloadGuard(HOST_GUARD);
    this.update({ status, items: [], peers: [] });
  }

  /** Leaving the page / unmount: peers see the host go away (and wipe if the option is on). */
  stop() {
    if (this.done) return;
    this.finish("destroyed", false);
  }
}
