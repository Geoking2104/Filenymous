import { iceServers } from "../p2p/config";
import { CONNECT_TIMEOUT_MS, LOW_WATER, addRemoteCandidate, waitForDrain } from "../p2p/session";
import { iceCandidateInit, type SignalPayload } from "../p2p/signal";
import { b64urlEncode } from "../p2p/protocol";
import { SealedPipe, WALL_PROTOCOL_VERSION, checkProof, deriveWallKeys, parseHandshake, sealProof, wallBaseMaterial } from "./crypto";
import { isExpired, type WallParams } from "./link";
import { MAX_TEXT_BYTES, WALL_CHUNK, admitItem, parseWallMessage, type ItemKind, type ItemMeta, type WallMessage } from "./model";
import { WallSignalClient } from "./signal";

export type PeerStatus =
  | "connecting"
  | "waiting-host"
  | "handshake"
  | "online"
  | "bad-password"
  | "full"
  | "destroyed"
  | "expired"
  | "host-left"
  | "left"
  | "error";

export const ENDED: PeerStatus[] = ["destroyed", "expired", "host-left", "left"];

export interface PeerUpload {
  uid: number;
  name: string;
  kind: ItemKind;
  size: number;
  sent: number;
  status: "sending" | "done" | "failed";
  reason?: string;
}

export interface PeerState {
  status: PeerStatus;
  label?: string;
  items: ItemMeta[];
  peers: number;
  expiresAt: number;
  burn: boolean;
  hostLeave: boolean;
  uploads: PeerUpload[];
  /** Ids of items this tab authored (never burned when it re-opens them). */
  mine: string[];
  error?: string;
}

interface Pending {
  item?: ItemMeta;
  parts: Uint8Array[];
  bytes: number;
  resolve(v: { meta: ItemMeta; data: Blob }): void;
  reject(e: Error): void;
}

export interface WallPeerOptions {
  signalUrl?: string;
}

const randomId = (n = 12) => b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));

/** A participant of a wall: one DataChannel to the host, nothing else. */
export class WallPeer {
  private signal: WallSignalClient | null = null;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private pipe: SealedPipe | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private base: Uint8Array | null = null;
  private readonly peerId = randomId(12);
  private uid = 0;
  private rid = 0;
  private gets = new Map<number, Pending>();
  private puts = new Map<number, (ok: { id?: string; reason?: string }) => void>();
  private out: Promise<void> = Promise.resolve();
  private uploadChain: Promise<void> = Promise.resolve();
  /** Items already fetched by this tab, kept in memory until the wall is wiped. */
  private local = new Map<string, { meta: ItemMeta; data: Blob }>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private wipeListeners = new Set<() => void>();
  state: PeerState;

  constructor(
    readonly params: WallParams,
    private readonly onState: (s: PeerState) => void,
    private readonly opts: WallPeerOptions = {},
  ) {
    this.state = {
      status: "connecting",
      items: [],
      peers: 0,
      expiresAt: params.expiresAt,
      burn: params.burn,
      hostLeave: params.hostLeave,
      uploads: [],
      mine: [],
    };
  }

  private update(patch: Partial<PeerState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  private get ended() {
    return ENDED.includes(this.state.status);
  }

  /** Called when everything must be forgotten (UI revokes its Blob URLs here). */
  onWipe(fn: () => void): () => void {
    this.wipeListeners.add(fn);
    return () => this.wipeListeners.delete(fn);
  }

  async start(password?: string): Promise<void> {
    if (isExpired(this.params)) return this.wipe("expired");
    const base = await wallBaseMaterial(this.params, password);
    if (this.ended) return;
    this.base = base;
    this.tick ??= setInterval(() => isExpired(this.params) && this.wipe("expired"), 1000);
    if (this.signal) {
      // Retrying with another password: reuse the signaling session.
      this.update({ status: "connecting", error: undefined });
      return this.begin();
    }
    this.signal = new WallSignalClient(
      { wallId: this.params.wallId, role: "peer", peerId: this.peerId },
      {
        onJoined: (info) => {
          if (info.hostOnline) void this.begin();
          else if (!this.pipe) this.update({ status: "waiting-host" });
        },
        onSignal: (p) => void this.onSignal(p).catch(() => undefined),
        onHostOnline: () => !this.pipe && void this.begin(),
        onHostOffline: () => {
          if (!this.pipe && !this.ended) this.update({ status: "waiting-host" });
        },
        onClosed: (reason) => this.wipe(reason === "expired" ? "expired" : reason === "host-left" ? "host-left" : "destroyed"),
        onError: (e) => !this.ended && this.update({ error: e }),
      },
      this.opts.signalUrl,
    );
    try {
      await this.signal.connect();
    } catch (e) {
      const error = String((e as Error).message || e);
      if (error === "wall-closed" || error === "invalid-wall") return this.wipe("destroyed");
      this.update({ status: error === "wall-full" ? "full" : "error", error });
    }
  }

  private closePc() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const pc = this.pc;
    this.pc = null;
    this.channel = null;
    this.pipe = null;
    try { pc?.close(); } catch { /* ignore */ }
  }

  private async begin() {
    if (this.ended || !this.base) return;
    this.closePc();
    this.update({ status: "handshake" });
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    this.pc = pc;
    this.pendingIce = [];
    const channel = pc.createDataChannel("filenymous-wall-v1", { ordered: true });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER;
    this.channel = channel;
    const sid = randomId(16);
    pc.onicecandidate = (ev) => ev.candidate && this.pc === pc && this.signal?.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) });
    const timer = setTimeout(() => {
      if (this.pc === pc && !this.pipe) this.lost(pc);
    }, CONNECT_TIMEOUT_MS);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.lost(pc);
    };
    let keys: Awaited<ReturnType<typeof deriveWallKeys>> | null = null;
    let queue = Promise.resolve();
    channel.onopen = async () => {
      clearTimeout(timer);
      keys = await deriveWallKeys(this.params, this.base!, sid);
      channel.send(JSON.stringify({ type: "wall-hello", v: WALL_PROTOCOL_VERSION, sid, proof: await sealProof(keys.proof, `hello:${sid}`) }));
    };
    const handle = async (data: string | ArrayBuffer) => {
      if (this.pc !== pc) return;
      if (!this.pipe) {
        if (typeof data !== "string" || !keys) return this.lost(pc);
        const msg = parseHandshake(data);
        if (msg?.type === "wall-reject") {
          this.closePc();
          if (msg.reason === "bad-password") return this.update({ status: "bad-password" });
          if (msg.reason === "full") return this.update({ status: "full" });
          return this.wipe("destroyed");
        }
        if (msg?.type !== "wall-ready" || !(await checkProof(keys.proof, msg.proof, `ready:${sid}`))) return this.lost(pc);
        this.pipe = new SealedPipe(keys.up, keys.down);
        this.update({ status: "online", error: undefined });
        return;
      }
      if (typeof data === "string") return this.lost(pc);
      let frame;
      try {
        frame = await this.pipe.open(data);
      } catch {
        return this.lost(pc);
      }
      if (frame.bytes) {
        const g = this.gets.get(frame.stream);
        if (!g?.item) return;
        g.bytes += frame.bytes.byteLength;
        if (g.bytes > g.item.size) {
          this.gets.delete(frame.stream);
          return g.reject(new Error("size"));
        }
        g.parts.push(frame.bytes);
        return;
      }
      const msg = parseWallMessage(frame.control);
      if (!msg) return this.lost(pc);
      this.onHostMessage(msg);
    };
    channel.onmessage = (ev) => {
      queue = queue.then(() => handle(ev.data as string | ArrayBuffer)).catch(() => this.lost(pc));
    };
    channel.onclose = () => this.pc === pc && this.lost(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal?.send({ kind: "offer", sdp: offer.sdp ?? "" });
  }

  private async onSignal(payload: SignalPayload) {
    const pc = this.pc;
    if (!pc) return;
    if (payload.kind === "answer") {
      if (pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
    } else if (payload.kind === "ice") {
      await addRemoteCandidate(pc, payload, this.pendingIce);
    }
  }

  private lost(pc: RTCPeerConnection) {
    if (this.pc !== pc || this.ended) return;
    const wasOnline = !!this.pipe;
    this.closePc();
    for (const g of this.gets.values()) g.reject(new Error("connection-lost"));
    this.gets.clear();
    for (const done of this.puts.values()) done({ reason: "connection-lost" });
    this.puts.clear();
    if (wasOnline && this.params.hostLeave) return this.wipe("host-left");
    this.update({ status: "waiting-host" });
    this.retry = setTimeout(() => void this.begin(), 3000);
  }

  private onHostMessage(msg: WallMessage) {
    switch (msg.t) {
      case "welcome":
        return this.update({ label: msg.label, expiresAt: Math.min(msg.expiresAt, this.params.expiresAt) });
      case "state":
        // Live items only; copies this tab already fetched stay readable via fetch() until wipe.
        return this.update({ items: msg.items, peers: msg.peers });
      case "put-ok":
        this.puts.get(msg.uid)?.({ id: msg.id });
        return;
      case "put-fail":
        this.puts.get(msg.uid)?.({ reason: msg.reason });
        return;
      case "get-begin": {
        const g = this.gets.get(msg.rid);
        if (g) g.item = msg.item;
        return;
      }
      case "get-end": {
        const g = this.gets.get(msg.rid);
        if (!g?.item) return;
        this.gets.delete(msg.rid);
        if (g.bytes !== g.item.size) return g.reject(new Error("size"));
        const data = new Blob(g.parts as BlobPart[], { type: g.item.mime });
        g.parts = [];
        this.local.set(g.item.id, { meta: g.item, data });
        return g.resolve({ meta: g.item, data });
      }
      case "get-fail": {
        const g = this.gets.get(msg.rid);
        this.gets.delete(msg.rid);
        g?.reject(new Error(msg.reason));
        return;
      }
      case "destroy":
        return this.wipe(msg.reason);
      default:
        return;
    }
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.out.then(job, job);
    this.out = run.catch(() => undefined);
    return run;
  }

  private sendControl(msg: WallMessage): Promise<void> {
    return this.enqueue(async () => {
      if (!this.pipe || this.channel?.readyState !== "open") throw new Error("offline");
      this.channel.send(await this.pipe.sealControl(msg));
    });
  }

  private patchUpload(uid: number, patch: Partial<PeerUpload>) {
    this.update({ uploads: this.state.uploads.map((u) => (u.uid === uid ? { ...u, ...patch } : u)) });
  }

  private putOne(kind: ItemKind, name: string, mime: string, data: Blob): Promise<void> {
    const uid = ++this.uid;
    this.update({ uploads: [...this.state.uploads, { uid, name, kind, size: data.size, sent: 0, status: "sending" }] });
    const local = admitItem(kind, data.size, 0, 0);
    if (local) {
      this.patchUpload(uid, { status: "failed", reason: local });
      return Promise.resolve();
    }
    const result = new Promise<{ id?: string; reason?: string }>((resolve) => this.puts.set(uid, resolve));
    const send = this.enqueue(async () => {
      const ch = this.channel;
      const pipe = this.pipe;
      if (!pipe || ch?.readyState !== "open") throw new Error("offline");
      ch.send(await pipe.sealControl({ t: "put", uid, kind, name, size: data.size, mime } satisfies WallMessage));
      let chunks = 0;
      for (let off = 0; off < data.size; off += WALL_CHUNK) {
        if (this.pipe !== pipe || ch.readyState !== "open") throw new Error("offline");
        ch.send(await pipe.sealData(uid, new Uint8Array(await data.slice(off, off + WALL_CHUNK).arrayBuffer())));
        chunks++;
        this.patchUpload(uid, { sent: Math.min(data.size, off + WALL_CHUNK) });
        await waitForDrain(ch);
      }
      ch.send(await pipe.sealControl({ t: "put-end", uid, chunks } satisfies WallMessage));
    });
    return send.then(
      async () => {
        const r = await result;
        this.puts.delete(uid);
        if (r.id) {
          this.update({ mine: [...this.state.mine, r.id] });
          this.patchUpload(uid, { status: "done", sent: data.size });
        } else this.patchUpload(uid, { status: "failed", reason: r.reason });
      },
      (e) => {
        this.puts.delete(uid);
        this.patchUpload(uid, { status: "failed", reason: String((e as Error).message || e) });
      },
    );
  }

  /** Queues files for upload to the host (one at a time, in order). */
  addFiles(files: File[]): Promise<void> {
    for (const f of files) {
      this.uploadChain = this.uploadChain.then(() => (this.ended ? undefined : this.putOne("file", f.name, f.type || "application/octet-stream", f)));
    }
    return this.uploadChain;
  }

  addText(text: string, title = ""): Promise<void> | string {
    const data = new Blob([text], { type: "text/plain" });
    if (!data.size || data.size > MAX_TEXT_BYTES) return "text-too-large";
    this.uploadChain = this.uploadChain.then(() => (this.ended ? undefined : this.putOne("text", title, "text/plain", data)));
    return this.uploadChain;
  }

  /** Item bytes: from this tab's memory if already fetched, otherwise from the host. */
  fetch(id: string): Promise<{ meta: ItemMeta; data: Blob }> {
    const cached = this.local.get(id);
    if (cached) return Promise.resolve(cached);
    if (!this.pipe) return Promise.reject(new Error("offline"));
    const rid = ++this.rid;
    const p = new Promise<{ meta: ItemMeta; data: Blob }>((resolve, reject) => this.gets.set(rid, { parts: [], bytes: 0, resolve, reject }));
    this.sendControl({ t: "get", rid, id }).catch((e) => {
      this.gets.get(rid)?.reject(e);
      this.gets.delete(rid);
    });
    return p;
  }

  hasLocal(id: string): boolean {
    return this.local.has(id);
  }

  /** Forgets everything this tab knows about the wall. */
  wipe(reason: "destroyed" | "expired" | "host-left" | "left") {
    if (this.ended) return;
    for (const g of this.gets.values()) g.reject(new Error("wiped"));
    this.gets.clear();
    this.puts.clear();
    this.local.clear();
    this.base = null;
    if (this.tick) clearInterval(this.tick);
    this.closePc();
    this.signal?.close();
    for (const fn of this.wipeListeners) fn();
    this.update({ status: reason, items: [], uploads: [], mine: [], peers: 0, label: undefined });
  }

  async leave() {
    if (this.ended) return;
    await Promise.race([this.sendControl({ t: "bye" }).catch(() => undefined), new Promise((r) => setTimeout(r, 300))]);
    this.wipe("left");
  }

  stop() {
    if (!this.ended) this.wipe("left");
  }
}
