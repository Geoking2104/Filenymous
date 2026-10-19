import { iceServers } from "../p2p/config";
import { CONNECT_TIMEOUT_MS, LOW_WATER, addRemoteCandidate, waitForDrain } from "../p2p/session";
import { iceCandidateInit, type SignalPayload } from "../p2p/signal";
import { b64urlEncode } from "../p2p/protocol";
import { SealedPipe, WALL_PROTOCOL_VERSION, checkProof, deriveWallKeys, parseHandshake, sealProof, wallBaseMaterial } from "./crypto";
import { MAX_POSTS, diffMembers, type BurstKind, type LiveInfo, type LiveKind, type Member, type Post, type WallEvent } from "./feed";
import { isExpired, type WallParams } from "./link";
import { MediaLink, stopStream } from "./live";
import { MAX_TEXT_BYTES, WALL_CHUNK, admitItem, parseWallMessage, type ItemKind, type ItemMeta, type RtcMessage, type WallMessage } from "./model";
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
  | "kicked"
  | "agents-off"
  | "error";

export const ENDED: PeerStatus[] = ["destroyed", "expired", "host-left", "left", "kicked", "agents-off"];
type EndReason = "destroyed" | "expired" | "host-left" | "left" | "kicked" | "agents-off";

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
  /** Wall display name sent by the host ("" = untitled). */
  title: string;
  expiresAt: number;
  burn: boolean;
  hostLeave: boolean;
  /** Host setting: AI agents allowed. */
  agents: boolean;
  /** The host can forward live media. */
  hostMedia: boolean;
  posts: Post[];
  members: Member[];
  pinned: string | null;
  live: LiveInfo[];
  /** sid → stream (own capture, or received from the host). */
  media: Record<string, MediaStream>;
  typing: Record<string, number>;
  uploads: PeerUpload[];
  /** Ids of items this tab authored (never burned when it re-opens them). */
  mine: string[];
  notice?: { code: string; at: number; retryMs?: number };
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
  /** Display name shown to the others. */
  name?: string;
  /** Self-declared AI agent (CLI/MCP). */
  agent?: boolean;
  /** This runtime can show/send live media (browser). */
  media?: boolean;
}

const randomId = (n = 12) => b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));

/** A participant of a wall: one DataChannel to the host (plus media links for live streams). */
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
  private attempt = 0;
  /** Password of the start in progress or done (React effects can call start() twice on mount). */
  private started: string | null = null;
  private gets = new Map<number, Pending>();
  private puts = new Map<number, (ok: { id?: string; reason?: string }) => void>();
  private out: Promise<void> = Promise.resolve();
  private uploadChain: Promise<void> = Promise.resolve();
  /** Items already fetched by this tab, kept in memory until the wall is wiped. */
  private local = new Map<string, { meta: ItemMeta; data: Blob }>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private wipeListeners = new Set<() => void>();
  private listeners = new Set<(e: WallEvent) => void>();
  private down = new Map<string, MediaLink>();
  private myPub: { sid: string; stream: MediaStream; link?: MediaLink; seen: boolean } | null = null;
  private liveWait: ((r: { sid?: string; reason?: string }) => void) | null = null;
  private name: string;
  state: PeerState;

  constructor(
    readonly params: WallParams,
    private readonly onState: (s: PeerState) => void,
    private readonly opts: WallPeerOptions = {},
  ) {
    this.name = opts.name ?? "";
    this.state = {
      status: "connecting",
      title: "",
      expiresAt: params.expiresAt,
      burn: params.burn,
      hostLeave: params.hostLeave,
      agents: false,
      hostMedia: false,
      posts: [],
      members: [],
      pinned: null,
      live: [],
      media: {},
      typing: {},
      uploads: [],
      mine: [],
    };
  }

  private update(patch: Partial<PeerState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  private emit(e: WallEvent) {
    for (const fn of this.listeners) {
      try { fn(e); } catch { /* ignore */ }
    }
  }

  on(fn: (e: WallEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private get ended() {
    return ENDED.includes(this.state.status);
  }

  get label() {
    return this.state.label;
  }

  /** Called when everything must be forgotten (UI revokes its Blob URLs here). */
  onWipe(fn: () => void): () => void {
    this.wipeListeners.add(fn);
    return () => this.wipeListeners.delete(fn);
  }

  async start(password?: string): Promise<void> {
    // A duplicate call would open a second WebRTC attempt before "joined": the host
    // answers both offers in order and the newest connection takes the stale answer.
    const pw = password ?? "";
    if (this.started === pw && this.state.status !== "bad-password") return;
    this.started = pw;
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

  private closeMedia() {
    for (const l of this.down.values()) l.close();
    this.down.clear();
    if (this.myPub) {
      this.myPub.link?.close();
      stopStream(this.myPub.stream);
      this.myPub = null;
    }
    this.liveWait?.({ reason: "offline" });
    this.liveWait = null;
  }

  private closePc() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.closeMedia();
    const pc = this.pc;
    this.pc = null;
    this.channel = null;
    this.pipe = null;
    try { pc?.close(); } catch { /* ignore */ }
  }

  private async begin() {
    if (this.ended || !this.base) return;
    // "joined (host online)" and "host-online" can both fire: only the latest attempt survives,
    // otherwise the answer to a stale offer would be applied to the newer connection.
    const attempt = ++this.attempt;
    this.closePc();
    this.update({ status: "handshake" });
    const servers = await iceServers();
    if (attempt !== this.attempt || this.ended) return;
    const pc = new RTCPeerConnection({ iceServers: servers });
    this.pc = pc;
    this.pendingIce = [];
    const channel = pc.createDataChannel("filenymous-wall-v2", { ordered: true });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER;
    this.channel = channel;
    const sid = randomId(16);
    pc.onicecandidate = (ev) => ev.candidate && this.pc === pc && this.signal?.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) });
    const timer = setTimeout(() => {
      if (this.pc === pc && this.state.status !== "online") this.lost(pc);
    }, CONNECT_TIMEOUT_MS);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.lost(pc);
    };
    let keys: Awaited<ReturnType<typeof deriveWallKeys>> | null = null;
    let queue = Promise.resolve();
    channel.onopen = async () => {
      keys = await deriveWallKeys(this.params, this.base!, sid);
      channel.send(JSON.stringify({ type: "wall-hello", v: WALL_PROTOCOL_VERSION, sid, proof: await sealProof(keys.proof, `hello:${sid}`) }));
    };
    const handle = async (data: string | ArrayBuffer) => {
      if (this.pc !== pc) return;
      if (!this.pipe) {
        if (typeof data !== "string" || !keys) return this.lost(pc);
        const msg = parseHandshake(data);
        if (msg?.type === "wall-reject") {
          clearTimeout(timer);
          this.closePc();
          if (msg.reason === "bad-password") return this.update({ status: "bad-password" });
          if (msg.reason === "full") return this.update({ status: "full" });
          return this.wipe("destroyed");
        }
        if (msg?.type !== "wall-ready" || !(await checkProof(keys.proof, msg.proof, `ready:${sid}`))) return this.lost(pc);
        this.pipe = new SealedPipe(keys.up, keys.down);
        // First sealed message: who we say we are (name, agent badge, media capability).
        void this.sendControl({ t: "profile", name: this.name, agent: !!this.opts.agent, media: !!this.opts.media });
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
      if (msg.t === "welcome") clearTimeout(timer);
      await this.onHostMessage(msg);
    };
    channel.onmessage = (ev) => {
      queue = queue.then(() => handle(ev.data as string | ArrayBuffer)).catch(() => this.lost(pc));
    };
    channel.onclose = () => this.pc === pc && this.lost(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.pc === pc) this.signal?.send({ kind: "offer", sdp: offer.sdp ?? "" });
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
    const wasOnline = this.state.status === "online";
    this.closePc();
    for (const g of this.gets.values()) g.reject(new Error("connection-lost"));
    this.gets.clear();
    for (const done of this.puts.values()) done({ reason: "connection-lost" });
    this.puts.clear();
    if (wasOnline && this.params.hostLeave) return this.wipe("host-left");
    this.update({ status: "waiting-host", live: [], media: {}, typing: {} });
    this.retry = setTimeout(() => void this.begin(), 3000);
  }

  private setPosts(posts: Post[]) {
    this.update({ posts: posts.length > MAX_POSTS + 220 ? posts.slice(-MAX_POSTS - 220) : posts });
  }

  private async onHostMessage(msg: WallMessage) {
    switch (msg.t) {
      case "welcome":
        // A (re)connection: the host replays the feed right after.
        return this.update({
          status: "online",
          error: undefined,
          label: msg.label,
          title: msg.title ?? "",
          // 0 = no expiry: keep the tighter of the two real deadlines.
          expiresAt: !msg.expiresAt ? this.params.expiresAt : !this.params.expiresAt ? msg.expiresAt : Math.min(msg.expiresAt, this.params.expiresAt),
          agents: msg.agents,
          hostMedia: msg.media,
          posts: [],
          pinned: null,
          live: [],
          media: {},
        });
      case "members": {
        const { joined, left } = diffMembers(this.state.members, msg.members);
        const typing = { ...this.state.typing };
        for (const m of left) delete typing[m.label];
        this.update({ members: msg.members, typing });
        for (const m of joined) this.emit({ type: "join", member: m });
        for (const m of left) this.emit({ type: "leave", member: m });
        this.emit({ type: "members", members: msg.members });
        return;
      }
      case "post": {
        const posts = [...this.state.posts];
        const i = posts.findIndex((p) => p.id === msg.post.id);
        if (i >= 0) posts[i] = msg.post;
        else posts.push(msg.post);
        const typing = { ...this.state.typing };
        if (i < 0) delete typing[msg.post.by];
        this.setPosts(posts);
        this.update({ typing });
        this.emit({ type: "post", post: msg.post, update: i >= 0 });
        return;
      }
      case "unpost":
        this.update({ posts: this.state.posts.filter((p) => p.id !== msg.id), pinned: this.state.pinned === msg.id ? null : this.state.pinned });
        this.emit({ type: "unpost", id: msg.id });
        return;
      case "pin":
        this.update({ pinned: msg.id });
        this.emit({ type: "pin", id: msg.id });
        return;
      case "settings":
        return this.update({ agents: msg.agents });
      case "typing-by":
        this.update({ typing: { ...this.state.typing, [msg.label]: Date.now() } });
        this.emit({ type: "typing", label: msg.label });
        return;
      case "burst-by":
        this.emit({ type: "burst", label: msg.label, kind: msg.kind });
        return;
      case "notice":
        this.update({ notice: { code: msg.code, at: Date.now(), ...(msg.retryMs !== undefined ? { retryMs: msg.retryMs } : {}) } });
        this.emit({ type: "notice", code: msg.code, ...(msg.retryMs !== undefined ? { retryMs: msg.retryMs } : {}) });
        return;
      case "kick":
        return this.wipe(msg.reason);
      case "live":
        return this.onLive(msg.streams);
      case "live-ok":
        this.liveWait?.({ sid: msg.sid });
        this.liveWait = null;
        return;
      case "live-fail":
        this.liveWait?.({ reason: msg.reason });
        this.liveWait = null;
        return;
      case "rtc":
        return this.onRtc(msg);
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

  // ---- live media ------------------------------------------------------------

  private onLive(streams: LiveInfo[]) {
    const ids = new Set(streams.map((s) => s.sid));
    const media = { ...this.state.media };
    for (const [sid, link] of [...this.down]) {
      if (!ids.has(sid)) {
        link.close();
        this.down.delete(sid);
        delete media[sid];
      }
    }
    if (this.myPub) {
      if (ids.has(this.myPub.sid)) this.myPub.seen = true;
      else if (this.myPub.seen) {
        // The host ended our stream (moderation or limit).
        this.myPub.link?.close();
        stopStream(this.myPub.stream);
        delete media[this.myPub.sid];
        this.myPub = null;
      }
    }
    this.update({ live: streams, media });
    this.emit({ type: "live", streams });
  }

  private async onRtc(msg: RtcMessage) {
    const [dir, sid] = msg.link.split(":") as [string, string];
    if (dir === "up") {
      if (this.myPub?.sid === sid) await this.myPub.link?.onRtc(msg);
      return;
    }
    if (!this.opts.media) return;
    let link = this.down.get(sid);
    if (!link) {
      if (msg.kind !== "offer") return;
      link = await MediaLink.create(msg.link, (m) => void this.sendControl(m).catch(() => undefined), {
        onTrack: (track, stream) => {
          const cur = this.state.media[sid];
          const s = cur ?? stream ?? new MediaStream();
          if (!s.getTracks().includes(track)) s.addTrack(track);
          this.update({ media: { ...this.state.media, [sid]: s } });
        },
      });
      this.down.set(sid, link);
    }
    await link.onRtc(msg);
  }

  /** Publishes a captured stream through the host; returns a refusal code or null. */
  async startLive(stream: MediaStream, kind: LiveKind): Promise<string | null> {
    if (!this.pipe || this.state.status !== "online") return "offline";
    if (this.myPub || this.liveWait) return "already-live";
    const tracks = stream.getTracks().slice(0, 2);
    const r = await new Promise<{ sid?: string; reason?: string }>((resolve) => {
      this.liveWait = resolve;
      this.sendControl({ t: "live-start", kind, tracks: tracks.length }).catch(() => resolve({ reason: "offline" }));
    });
    if (!r.sid) return r.reason ?? "live-failed";
    const sid = r.sid;
    this.myPub = { sid, stream, seen: false };
    this.update({ media: { ...this.state.media, [sid]: stream } });
    for (const t of tracks) t.addEventListener("ended", () => tracks.every((x) => x.readyState === "ended") && this.stopLive());
    const link = await MediaLink.create(`up:${sid}`, (m) => void this.sendControl(m).catch(() => undefined), { onFail: () => this.stopLive() });
    if (this.myPub?.sid !== sid) {
      link.close();
      return "stopped";
    }
    this.myPub.link = link;
    await link.offer(tracks, stream);
    return null;
  }

  stopLive() {
    const pub = this.myPub;
    if (!pub) return;
    this.myPub = null;
    pub.link?.close();
    stopStream(pub.stream);
    const media = { ...this.state.media };
    delete media[pub.sid];
    this.update({ media });
    void this.sendControl({ t: "live-stop", sid: pub.sid }).catch(() => undefined);
  }

  get myLiveSid(): string | null {
    return this.myPub?.sid ?? null;
  }

  // ---- outgoing ----------------------------------------------------------------

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

  private putOne(kind: ItemKind, name: string, mime: string, data: Blob, replyTo?: string): Promise<string | null> {
    const uid = ++this.uid;
    this.update({ uploads: [...this.state.uploads.slice(-20), { uid, name, kind, size: data.size, sent: 0, status: "sending" }] });
    const local = admitItem(kind, data.size, 0, 0);
    if (local) {
      this.patchUpload(uid, { status: "failed", reason: local });
      return Promise.resolve(local);
    }
    const result = new Promise<{ id?: string; reason?: string }>((resolve) => this.puts.set(uid, resolve));
    const send = (async () => {
      const pipe = this.pipe;
      const ch = this.channel;
      const alive = () => this.pipe === pipe && !!pipe && ch?.readyState === "open";
      await this.sendControl({ t: "put", uid, kind, name, size: data.size, mime, ...(replyTo ? { replyTo } : {}) });
      let chunks = 0;
      for (let off = 0; off < data.size; off += WALL_CHUNK) {
        if (!alive()) throw new Error("offline");
        const bytes = new Uint8Array(await data.slice(off, off + WALL_CHUNK).arrayBuffer());
        // One job per chunk: chat and reactions can slip in between chunks.
        await this.enqueue(async () => {
          if (!alive()) throw new Error("offline");
          ch!.send(await pipe!.sealData(uid, bytes));
          chunks++;
          await waitForDrain(ch!);
        });
        this.patchUpload(uid, { sent: Math.min(data.size, off + WALL_CHUNK) });
      }
      await this.sendControl({ t: "put-end", uid, chunks });
    })();
    return send.then(
      async () => {
        const r = await result;
        this.puts.delete(uid);
        if (r.id) {
          this.update({ mine: [...this.state.mine, r.id] });
          this.patchUpload(uid, { status: "done", sent: data.size });
          return null;
        }
        this.patchUpload(uid, { status: "failed", reason: r.reason });
        return r.reason ?? "failed";
      },
      (e) => {
        this.puts.delete(uid);
        const reason = String((e as Error).message || e);
        this.patchUpload(uid, { status: "failed", reason });
        return reason;
      },
    );
  }

  private chain(job: () => Promise<string | null>): Promise<string | null> {
    const run = this.uploadChain.then(() => (this.ended ? "closed" : job()));
    this.uploadChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Queues files for upload to the host (one at a time, in order). */
  addFiles(files: File[], replyTo?: string): Promise<void> {
    for (const f of files) void this.chain(() => this.putOne("file", f.name, f.type || "application/octet-stream", f, replyTo));
    return this.uploadChain;
  }

  /** Uploads an in-memory blob as a file item; resolves to a refusal reason or null. */
  addBlob(name: string, mime: string, data: Blob, replyTo?: string): Promise<string | null> {
    return this.chain(() => this.putOne("file", name, mime || "application/octet-stream", data, replyTo));
  }

  addText(text: string, title = ""): Promise<void> | string {
    const data = new Blob([text], { type: "text/plain" });
    if (!data.size || data.size > MAX_TEXT_BYTES) return "text-too-large";
    void this.chain(() => this.putOne("text", title, "text/plain", data));
    return this.uploadChain;
  }

  say(text: string, replyTo?: string): Promise<void> {
    return this.sendControl({ t: "say", text, ...(replyTo ? { replyTo } : {}) });
  }

  react(id: string, emoji: string): Promise<void> {
    return this.sendControl({ t: "react", id, emoji });
  }

  createPoll(question: string, options: string[]): Promise<void> {
    return this.sendControl({ t: "poll", question, options });
  }

  vote(id: string, option: number): Promise<void> {
    return this.sendControl({ t: "vote", id, option });
  }

  closePoll(id: string): Promise<void> {
    return this.sendControl({ t: "poll-close", id });
  }

  removeItem(id: string): Promise<void> {
    return this.sendControl({ t: "remove", id });
  }

  typing() {
    void this.sendControl({ t: "typing" }).catch(() => undefined);
  }

  burst(kind: BurstKind) {
    void this.sendControl({ t: "burst", kind }).catch(() => undefined);
  }

  setHand(up: boolean): Promise<void> {
    return this.sendControl({ t: "hand", up });
  }

  rename(name: string): Promise<void> {
    this.name = name;
    return this.sendControl({ t: "rename", name });
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
  wipe(reason: EndReason) {
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
    this.update({ status: reason, posts: [], members: [], pinned: null, live: [], media: {}, typing: {}, uploads: [], mine: [], label: undefined });
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
