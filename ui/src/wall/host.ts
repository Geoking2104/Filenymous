import { iceServers } from "../p2p/config";
import { CONNECT_TIMEOUT_MS, LOW_WATER, addRemoteCandidate, waitForDrain } from "../p2p/session";
import { iceCandidateInit, type SignalPayload } from "../p2p/signal";
import { holdUnloadGuard, releaseUnloadGuard } from "../p2p/unloadGuardCore";
import { SealedPipe, WALL_PROTOCOL_VERSION, checkProof, deriveWallKeys, parseHandshake, sealProof, wallBaseMaterial } from "./crypto";
import {
  LIMITS,
  MAX_LIVE,
  MAX_POSTS,
  RateLimiter,
  castVote,
  cleanMessage,
  cleanName,
  extractMentions,
  makePoll,
  randomPostId,
  toggleReaction,
  type BurstKind,
  type LiveInfo,
  type LiveKind,
  type Member,
  type Post,
  type WallEvent,
} from "./feed";
import { isExpired, type HostWallParams } from "./link";
import { LIVE_WAIT_TRACKS_MS, MediaLink, stopStream } from "./live";
import {
  MAX_TEXT_BYTES,
  WALL_CHUNK,
  WallStore,
  parseWallMessage,
  type DestroyReason,
  type ItemKind,
  type ItemMeta,
  type KickReason,
  type RtcMessage,
  type WallMessage,
} from "./model";
import { WallSignalClient, type WallJoin } from "./signal";

export const MAX_PEERS = 8;
export const HOST_LABEL = "host";
export const HOST_GUARD = "wall-host";

export type HostStatus = "starting" | "online" | "reconnecting" | "destroyed" | "expired" | "error";

export interface HostState {
  status: HostStatus;
  expiresAt: number;
  posts: Post[];
  members: Member[];
  pinned: string | null;
  live: LiveInfo[];
  /** sid → stream shown in this tab (own capture or forwarded from a publisher). */
  media: Record<string, MediaStream>;
  /** label → last "typing" signal (ms). */
  typing: Record<string, number>;
  /** Whether AI agents may join (host setting, off by default). */
  agents: boolean;
  error?: string;
  notice?: { code: string; at: number; retryMs?: number };
}

interface Upload {
  kind: ItemKind;
  name: string;
  mime: string;
  size: number;
  replyTo?: string;
  parts: Uint8Array[];
  bytes: number;
}

interface Peer {
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  channel?: RTCDataChannel;
  pipe?: SealedPipe;
  label?: string;
  /** Set once the peer sent its profile (it is then a member of the wall). */
  member?: Member;
  uploads: Map<number, Upload>;
  out: Promise<void>;
  lastTyping: number;
  /** Host → this viewer media links, by publication sid. */
  down: Map<string, MediaLink>;
}

interface Publication {
  sid: string;
  by: string;
  kind: LiveKind;
  tracks: number;
  got: MediaStreamTrack[];
  stream?: MediaStream;
  up?: MediaLink;
  local: boolean;
  announced: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface WallHostOptions {
  signalUrl?: string;
  password?: string;
  /** Display name of the host. */
  name?: string;
  /** The host is an AI agent (CLI `wall create`). */
  agent?: boolean;
  /** This runtime can forward live media (browser). */
  media?: boolean;
  /** Let AI agents join (default false). */
  allowAgents?: boolean;
}

/**
 * Host of a Sharewall. The host's tab is the hub of a star: every peer opens
 * one WebRTC DataChannel to the host only. The host keeps the feed (messages,
 * items, reactions, polls) in memory, relays it to the members and enforces
 * the limits. Nothing is ever written to disk.
 */
export class WallHost {
  readonly store: WallStore;
  private signal: WallSignalClient | null = null;
  private peers = new Map<string, Peer>();
  private base: Uint8Array | null = null;
  private labelSeq = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private done = false;
  private pubs = new Map<string, Publication>();
  private listeners = new Set<(e: WallEvent) => void>();
  private chatLimit: RateLimiter;
  private reactLimit: RateLimiter;
  private burstLimit: RateLimiter;
  private self: Member;
  state: HostState;

  constructor(
    readonly params: HostWallParams,
    private readonly onState: (s: HostState) => void,
    private readonly opts: WallHostOptions = {},
  ) {
    this.store = new WallStore(params.burn);
    this.self = { label: HOST_LABEL, name: cleanName(opts.name) || "Hôte", agent: !!opts.agent, host: true, hand: false, media: !!opts.media };
    this.chatLimit = new RateLimiter(LIMITS.chat.capacity, LIMITS.chat.perSecond);
    this.reactLimit = new RateLimiter(LIMITS.react.capacity, LIMITS.react.perSecond);
    this.burstLimit = new RateLimiter(LIMITS.burst.capacity, LIMITS.burst.perSecond);
    this.state = {
      status: "starting",
      expiresAt: params.expiresAt,
      posts: [],
      members: [this.self],
      pinned: null,
      live: [],
      media: {},
      typing: {},
      agents: !!opts.allowAgents,
    };
  }

  /** Subscribes to feed events (posts, joins, reactions…). */
  on(fn: (e: WallEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: WallEvent) {
    for (const fn of this.listeners) {
      try { fn(e); } catch { /* listener errors never break the wall */ }
    }
  }

  private update(patch: Partial<HostState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  get label() {
    return HOST_LABEL;
  }

  async start(): Promise<void> {
    if (isExpired(this.params)) return this.finish("expired");
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
        onClosed: (reason) => void this.finish(reason === "expired" ? "expired" : "destroyed"),
        onError: (e) => !this.done && this.update({ error: e }),
      },
      this.opts.signalUrl,
    );
    try {
      await this.signal.connect();
    } catch (e) {
      const error = String((e as Error).message || e);
      if (error === "wall-closed") return this.finish("destroyed");
      this.update({ status: "error", error });
    }
  }

  // ---- peers & transport ---------------------------------------------------

  /** Members connected over an open sealed channel. */
  private members(): Array<[string, Peer]> {
    return Array.from(this.peers.entries()).filter(([, p]) => p.member && p.pipe && p.channel?.readyState === "open");
  }

  private peerByLabel(label: string): [string, Peer] | undefined {
    return Array.from(this.peers.entries()).find(([, p]) => p.label === label);
  }

  private memberList(): Member[] {
    return [this.self, ...this.members().map(([, p]) => p.member!)];
  }

  private refreshMembers() {
    const before = this.state.members;
    const members = this.memberList();
    const left = before.filter((m) => !members.some((n) => n.label === m.label));
    const joined = members.filter((m) => !before.some((n) => n.label === m.label));
    const typing = { ...this.state.typing };
    for (const m of left) delete typing[m.label];
    this.update({ members, typing });
    if (members.length > 1 && !this.done) holdUnloadGuard(HOST_GUARD);
    else releaseUnloadGuard(HOST_GUARD);
    this.broadcast({ t: "members", members });
    for (const m of joined) this.emit({ type: "join", member: m });
    for (const m of left) this.emit({ type: "leave", member: m });
    this.emit({ type: "members", members });
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

  private broadcast(msg: WallMessage, except?: string) {
    for (const [, p] of this.members()) if (p.label !== except) void this.sendControl(p, msg);
  }

  private notify(peer: Peer | null, code: string, retryMs?: number) {
    if (peer) void this.sendControl(peer, { t: "notice", code, ...(retryMs !== undefined ? { retryMs } : {}) });
    else this.update({ notice: { code, at: Date.now(), ...(retryMs !== undefined ? { retryMs } : {}) } });
  }

  private dropPeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.uploads.clear();
    for (const l of peer.down.values()) l.close();
    peer.down.clear();
    if (peer.label) {
      for (const pub of [...this.pubs.values()]) if (pub.by === peer.label) this.stopPub(pub.sid);
      this.chatLimit.forget(peer.label);
      this.reactLimit.forget(peer.label);
      this.burstLimit.forget(peer.label);
    }
    try { peer.pc.close(); } catch { /* ignore */ }
    if (peer.member) this.refreshMembers();
  }

  private async onSignal(payload: SignalPayload, from?: string) {
    if (!from || this.done) return;
    if (payload.kind === "offer") {
      if (isExpired(this.params)) return;
      this.dropPeer(from);
      if (this.peers.size >= MAX_PEERS) return;
      const pc = new RTCPeerConnection({ iceServers: await iceServers() });
      const peer: Peer = { pc, pendingIce: [], uploads: new Map(), out: Promise.resolve(), lastTyping: 0, down: new Map() };
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
        if (this.peers.get(from) === peer && !peer.member) this.dropPeer(from);
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
    // After a reject, let the message reach the peer before closing: closing
    // too early can overtake it on slow links, and the peer would then retry
    // forever instead of reporting "bad password". The peer closes itself
    // when it reads the reject; this is only the fallback.
    const later = (): void => {
      const t0 = Date.now();
      const tick = () => {
        if (this.peers.get(peerId) !== peer) return;
        if (channel.readyState === "open" && channel.bufferedAmount > 0 && Date.now() - t0 < 3000) return void setTimeout(tick, 100);
        setTimeout(() => this.peers.get(peerId) === peer && this.dropPeer(peerId), 1500);
      };
      setTimeout(tick, 100);
    };
    const plain = (msg: object) => channel.readyState === "open" && channel.send(JSON.stringify(msg));

    const handshake = async (text: string) => {
      const hello = parseHandshake(text);
      if (!hello || hello.type !== "wall-hello" || hello.v !== WALL_PROTOCOL_VERSION || !this.base) {
        plain({ type: "wall-reject", reason: "protocol" });
        return later();
      }
      if (this.done || isExpired(this.params)) {
        plain({ type: "wall-reject", reason: "closed" });
        return later();
      }
      const keys = await deriveWallKeys(this.params, this.base, hello.sid);
      if (!(await checkProof(keys.proof, hello.proof, `hello:${hello.sid}`))) {
        plain({ type: "wall-reject", reason: "bad-password" });
        return later();
      }
      // Host seals with the "down" key and opens with the "up" key.
      peer.pipe = new SealedPipe(keys.down, keys.up);
      peer.label = `peer:${++this.labelSeq}`;
      plain({ type: "wall-ready", proof: await sealProof(keys.proof, `ready:${hello.sid}`) });
      // The peer must now send its (sealed) profile before anything else.
    };

    const handle = async (data: string | ArrayBuffer) => {
      if (this.peers.get(peerId) !== peer) return;
      if (!peer.pipe) {
        if (typeof data !== "string") return later();
        return handshake(data);
      }
      if (typeof data === "string") return later();
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
      if (!peer.member) {
        if (msg.t !== "profile") return this.dropPeer(peerId);
        return this.admit(peerId, peer, msg);
      }
      await this.onPeerMessage(peerId, peer, msg);
    };

    channel.onmessage = (ev) => {
      queue = queue.then(() => handle(ev.data as string | ArrayBuffer)).catch(() => this.dropPeer(peerId));
    };
    channel.onclose = () => this.peers.get(peerId) === peer && this.dropPeer(peerId);
  }

  private admit(peerId: string, peer: Peer, msg: Extract<WallMessage, { t: "profile" }>) {
    if (msg.agent && !this.state.agents) {
      void this.sendControl(peer, { t: "kick", reason: "agents-off" });
      setTimeout(() => this.peers.get(peerId) === peer && this.dropPeer(peerId), 300);
      return;
    }
    const label = peer.label!;
    peer.member = { label, name: msg.name || label, agent: msg.agent, host: false, hand: false, media: msg.media };
    void this.sendControl(peer, {
      t: "welcome",
      label,
      expiresAt: this.params.expiresAt,
      burn: this.params.burn,
      hostLeave: this.params.hostLeave,
      agents: this.state.agents,
      media: !!this.opts.media,
    });
    // Posts go one by one so no single message hits the DataChannel size limit.
    for (const post of this.state.posts) void this.sendControl(peer, { t: "post", post });
    if (this.state.pinned) void this.sendControl(peer, { t: "pin", id: this.state.pinned });
    void this.sendControl(peer, { t: "live", streams: this.state.live });
    this.refreshMembers();
    if (msg.media) for (const pub of this.pubs.values()) if (pub.announced) void this.openDown(peer, pub);
  }

  private async onPeerMessage(peerId: string, peer: Peer, msg: WallMessage) {
    const label = peer.label!;
    switch (msg.t) {
      case "put": {
        if (!this.chatLimit.take(label)) {
          this.notify(peer, "rate-limited", this.chatLimit.retryIn(label));
          return void this.sendControl(peer, { t: "put-fail", uid: msg.uid, reason: "rate-limited" });
        }
        const reason = this.done ? "closed" : this.store.admit(msg.kind, msg.size);
        if (reason || peer.uploads.has(msg.uid)) return void this.sendControl(peer, { t: "put-fail", uid: msg.uid, reason: reason ?? "protocol" });
        peer.uploads.set(msg.uid, { kind: msg.kind, name: msg.name, mime: msg.mime, size: msg.size, replyTo: msg.replyTo, parts: [], bytes: 0 });
        return;
      }
      case "put-end": {
        const up = peer.uploads.get(msg.uid);
        if (!up) return;
        peer.uploads.delete(msg.uid);
        const reason = up.bytes !== up.size ? "size" : this.store.admit(up.kind, up.size);
        if (reason) return void this.sendControl(peer, { t: "put-fail", uid: msg.uid, reason });
        const meta = this.addItem({
          kind: up.kind,
          name: up.name,
          mime: up.kind === "text" ? "text/plain" : up.mime,
          by: label,
          owner: peerId,
          data: new Blob(up.parts as BlobPart[], { type: up.kind === "text" ? "text/plain" : up.mime }),
          replyTo: up.replyTo,
        });
        up.parts = [];
        void this.sendControl(peer, { t: "put-ok", uid: msg.uid, id: meta.id });
        return;
      }
      case "get": {
        const got = this.store.take(msg.id, peerId);
        if (!got) return void this.sendControl(peer, { t: "get-fail", rid: msg.rid, reason: "gone" });
        if (got.burned) this.unpost(msg.id);
        void this.streamItem(peer, msg.rid, got.meta, got.data);
        return;
      }
      case "rtc":
        return this.onRtc(peer, msg);
      case "live-start":
        return this.onLiveStart(peer, msg.kind, msg.tracks);
      case "live-stop": {
        const pub = this.pubs.get(msg.sid);
        if (pub && pub.by === label) this.stopPub(msg.sid);
        return;
      }
      case "bye":
        return this.dropPeer(peerId);
      case "profile":
      case "welcome":
        return this.dropPeer(peerId);
      default:
        return this.apply(label, peer, msg);
    }
  }

  /**
   * Feed actions, from a peer (`peer` set) or from the host itself (`peer`
   * null, never rate limited). The host is the only writer of the feed.
   */
  private apply(label: string, peer: Peer | null, msg: WallMessage) {
    if (this.done) return;
    const limited = (rl: RateLimiter) => {
      if (!peer || rl.take(label)) return false;
      this.notify(peer, "rate-limited", rl.retryIn(label));
      return true;
    };
    switch (msg.t) {
      case "say": {
        const text = cleanMessage(msg.text);
        if (!text || limited(this.chatLimit)) return;
        const replyTo = msg.replyTo && this.findPost(msg.replyTo) ? msg.replyTo : undefined;
        const mentions = extractMentions(text, this.state.members);
        this.upsert({ id: randomPostId("m"), kind: "msg", by: label, at: Date.now(), text, ...(replyTo ? { replyTo } : {}), ...(mentions.length ? { mentions } : {}), reactions: {} });
        return;
      }
      case "poll": {
        if (limited(this.chatLimit)) return;
        const poll = makePoll(msg.question, msg.options);
        if (!poll) return this.notify(peer, "bad-poll");
        this.upsert({ id: randomPostId("q"), kind: "poll", by: label, at: Date.now(), poll, reactions: {} });
        return;
      }
      case "react": {
        const post = this.findPost(msg.id);
        if (!post || limited(this.reactLimit)) return;
        const next = toggleReaction(post, msg.emoji, label);
        if (next !== post) this.upsert(next);
        return;
      }
      case "vote": {
        const post = this.findPost(msg.id);
        if (!post || limited(this.reactLimit)) return;
        const next = castVote(post, msg.option, label);
        if (next !== post) this.upsert(next);
        return;
      }
      case "poll-close": {
        const post = this.findPost(msg.id);
        if (!post?.poll || (post.by !== label && peer)) return;
        this.upsert({ ...post, poll: { ...post.poll, closed: true } });
        return;
      }
      case "remove": {
        const post = this.findPost(msg.id);
        if (!post || (post.by !== label && peer)) return;
        if (post.item) this.store.remove(post.id);
        this.unpost(post.id);
        return;
      }
      case "typing": {
        const now = Date.now();
        if (peer) {
          if (now - peer.lastTyping < LIMITS.typingGapMs) return;
          peer.lastTyping = now;
          this.update({ typing: { ...this.state.typing, [label]: now } });
          this.emit({ type: "typing", label });
        }
        this.broadcast({ t: "typing-by", label }, label);
        return;
      }
      case "burst": {
        if (limited(this.burstLimit)) return;
        if (peer) this.emit({ type: "burst", label, kind: msg.kind });
        this.broadcast({ t: "burst-by", label, kind: msg.kind }, label);
        return;
      }
      case "hand":
      case "rename": {
        if (limited(this.reactLimit)) return;
        const patch = msg.t === "hand" ? { hand: msg.up } : { name: cleanName(msg.name) };
        if (msg.t === "rename" && !patch.name) return;
        if (peer?.member) peer.member = { ...peer.member, ...patch };
        else if (!peer) this.self = { ...this.self, ...patch };
        this.refreshMembers();
        return;
      }
      default:
        return;
    }
  }

  private findPost(id: string): Post | undefined {
    return this.state.posts.find((p) => p.id === id);
  }

  private upsert(post: Post) {
    const posts = [...this.state.posts];
    const i = posts.findIndex((p) => p.id === post.id);
    const update = i >= 0;
    if (update) posts[i] = post;
    else posts.push(post);
    const dropped: string[] = [];
    while (posts.length > MAX_POSTS) {
      const j = posts.findIndex((p) => p.kind === "msg" || p.kind === "poll");
      if (j < 0) break;
      dropped.push(posts[j]!.id);
      posts.splice(j, 1);
    }
    if (!update && this.state.typing[post.by]) {
      const typing = { ...this.state.typing };
      delete typing[post.by];
      this.update({ posts, typing });
    } else this.update({ posts });
    this.broadcast({ t: "post", post });
    this.emit({ type: "post", post, update });
    for (const id of dropped) {
      this.broadcast({ t: "unpost", id });
      this.emit({ type: "unpost", id });
    }
  }

  private unpost(id: string) {
    if (!this.findPost(id)) return;
    const pinned = this.state.pinned === id ? null : this.state.pinned;
    this.update({ posts: this.state.posts.filter((p) => p.id !== id), pinned });
    this.broadcast({ t: "unpost", id });
    this.emit({ type: "unpost", id });
  }

  private addItem(input: { kind: ItemKind; name: string; mime: string; by: string; owner: string; data: Blob; replyTo?: string }): ItemMeta {
    const meta = this.store.add(input);
    const replyTo = input.replyTo && this.findPost(input.replyTo) ? input.replyTo : undefined;
    this.upsert({ id: meta.id, kind: meta.kind === "text" ? "note" : "file", by: input.by, at: meta.at, item: meta, ...(replyTo ? { replyTo } : {}), reactions: {} });
    return meta;
  }

  /** Streams an item chunk by chunk, letting chat/control messages interleave. */
  private async streamItem(peer: Peer, rid: number, meta: ItemMeta, data: Blob): Promise<void> {
    const ok = () => !this.done && !!peer.pipe && peer.channel?.readyState === "open";
    await this.sendControl(peer, { t: "get-begin", rid, item: meta });
    let chunks = 0;
    for (let off = 0; off < data.size; off += WALL_CHUNK) {
      if (!ok()) return;
      const bytes = new Uint8Array(await data.slice(off, off + WALL_CHUNK).arrayBuffer());
      await this.enqueue(peer, async () => {
        if (!ok()) return;
        peer.channel!.send(await peer.pipe!.sealData(rid, bytes));
        chunks++;
        await waitForDrain(peer.channel!);
      });
    }
    if (ok()) await this.sendControl(peer, { t: "get-end", rid, chunks });
  }

  // ---- live media ------------------------------------------------------------

  private liveSlots(): number {
    return this.pubs.size;
  }

  private onLiveStart(peer: Peer, kind: LiveKind, tracks: number) {
    const label = peer.label!;
    if (!this.opts.media || !peer.member?.media) return void this.sendControl(peer, { t: "live-fail", reason: "unsupported" });
    if ([...this.pubs.values()].some((p) => p.by === label)) return void this.sendControl(peer, { t: "live-fail", reason: "already-live" });
    if (this.liveSlots() >= MAX_LIVE) return void this.sendControl(peer, { t: "live-fail", reason: "live-limit" });
    const sid = randomPostId("s");
    const pub: Publication = { sid, by: label, kind, tracks, got: [], local: false, announced: false };
    pub.timer = setTimeout(() => !pub.announced && this.stopPub(sid), LIVE_WAIT_TRACKS_MS);
    this.pubs.set(sid, pub);
    void this.sendControl(peer, { t: "live-ok", sid });
  }

  private async onRtc(peer: Peer, msg: RtcMessage) {
    const [dir, sid] = msg.link.split(":") as [string, string];
    if (dir === "up") {
      const pub = this.pubs.get(sid);
      if (!pub || pub.by !== peer.label || pub.local) return;
      if (!pub.up) {
        if (msg.kind !== "offer") return;
        pub.up = await MediaLink.create(msg.link, (m) => void this.sendControl(peer, m), {
          onTrack: (track, stream) => {
            if (pub.got.includes(track)) return;
            pub.got.push(track);
            pub.stream ??= stream;
            if (!pub.announced && pub.got.length >= pub.tracks) this.announce(pub);
          },
          onFail: () => this.stopPub(sid),
        });
      }
      await pub.up.onRtc(msg);
    } else {
      await peer.down.get(sid)?.onRtc(msg);
    }
  }

  private announce(pub: Publication) {
    if (pub.timer) clearTimeout(pub.timer);
    pub.announced = true;
    const stream = pub.stream && pub.stream.getTracks().length >= pub.got.length ? pub.stream : new MediaStream(pub.got);
    pub.stream = stream;
    const live = [...this.state.live, { sid: pub.sid, by: pub.by, kind: pub.kind }];
    this.update({ live, media: { ...this.state.media, [pub.sid]: stream } });
    this.broadcast({ t: "live", streams: live });
    this.emit({ type: "live", streams: live });
    for (const [, p] of this.members()) if (p.member!.media && p.label !== pub.by) void this.openDown(p, pub);
  }

  private async openDown(peer: Peer, pub: Publication) {
    if (peer.down.has(pub.sid) || !pub.stream) return;
    const link = await MediaLink.create(`down:${pub.sid}`, (m) => void this.sendControl(peer, m), {
      onFail: () => {
        if (peer.down.get(pub.sid) === link) {
          link.close();
          peer.down.delete(pub.sid);
        }
      },
    });
    if (!this.pubs.has(pub.sid) || peer.down.has(pub.sid)) return link.close();
    peer.down.set(pub.sid, link);
    await link.offer(pub.got, pub.stream).catch(() => {
      link.close();
      peer.down.delete(pub.sid);
    });
  }

  private stopPub(sid: string) {
    const pub = this.pubs.get(sid);
    if (!pub) return;
    this.pubs.delete(sid);
    if (pub.timer) clearTimeout(pub.timer);
    pub.up?.close();
    for (const p of this.peers.values()) {
      p.down.get(sid)?.close();
      p.down.delete(sid);
    }
    if (pub.local) stopStream(pub.stream);
    const media = { ...this.state.media };
    delete media[sid];
    const live = this.state.live.filter((l) => l.sid !== sid);
    this.update({ live, media });
    if (pub.announced) {
      this.broadcast({ t: "live", streams: live });
      this.emit({ type: "live", streams: live });
    }
  }

  /** The host goes live with a captured stream; returns a refusal code or null. */
  startLive(stream: MediaStream, kind: LiveKind): string | null {
    if (this.done) return "closed";
    if (!this.opts.media) return "unsupported";
    if ([...this.pubs.values()].some((p) => p.by === HOST_LABEL)) return "already-live";
    if (this.liveSlots() >= MAX_LIVE) return "live-limit";
    const sid = randomPostId("s");
    const tracks = stream.getTracks();
    const pub: Publication = { sid, by: HOST_LABEL, kind, tracks: tracks.length, got: tracks, stream, local: true, announced: false };
    this.pubs.set(sid, pub);
    for (const t of tracks) t.addEventListener("ended", () => tracks.every((x) => x.readyState === "ended") && this.stopPub(sid));
    this.announce(pub);
    return null;
  }

  stopLive(sid?: string) {
    for (const pub of [...this.pubs.values()]) if (pub.by === HOST_LABEL && (!sid || pub.sid === sid)) this.stopPub(pub.sid);
  }

  /** Host moderation: ends any live stream. */
  stopAnyLive(sid: string) {
    this.stopPub(sid);
  }

  // ---- host-side actions ---------------------------------------------------

  say(text: string, replyTo?: string) {
    this.apply(HOST_LABEL, null, { t: "say", text, ...(replyTo ? { replyTo } : {}) });
  }

  react(id: string, emoji: string) {
    this.apply(HOST_LABEL, null, { t: "react", id, emoji });
  }

  createPoll(question: string, options: string[]): boolean {
    const n = this.state.posts.length;
    this.apply(HOST_LABEL, null, { t: "poll", question, options });
    return this.state.posts.length > n || this.state.posts.length >= MAX_POSTS;
  }

  vote(id: string, option: number) {
    this.apply(HOST_LABEL, null, { t: "vote", id, option });
  }

  closePoll(id: string) {
    this.apply(HOST_LABEL, null, { t: "poll-close", id });
  }

  typing() {
    this.apply(HOST_LABEL, null, { t: "typing" });
  }

  burst(kind: BurstKind) {
    this.apply(HOST_LABEL, null, { t: "burst", kind });
  }

  setHand(up: boolean) {
    this.apply(HOST_LABEL, null, { t: "hand", up });
  }

  rename(name: string) {
    this.apply(HOST_LABEL, null, { t: "rename", name });
  }

  pin(id: string | null) {
    if (this.done || (id && !this.findPost(id))) return;
    this.update({ pinned: id });
    this.broadcast({ t: "pin", id });
    this.emit({ type: "pin", id });
  }

  /** Disconnects a participant (they can come back with the link unless agents are turned off). */
  kick(label: string, reason: KickReason = "kicked") {
    const found = this.peerByLabel(label);
    if (!found) return;
    const [id, peer] = found;
    void this.sendControl(peer, { t: "kick", reason });
    setTimeout(() => this.peers.get(id) === peer && this.dropPeer(id), 300);
  }

  setAgentsAllowed(allowed: boolean) {
    if (this.done || this.state.agents === allowed) return;
    this.update({ agents: allowed });
    this.broadcast({ t: "settings", agents: allowed });
    if (!allowed) for (const [, p] of this.members()) if (p.member!.agent) this.kick(p.label!, "agents-off");
  }

  /** Adds files dropped by the host; returns the refusal reasons (if any) by file name. */
  async addFiles(files: File[], replyTo?: string): Promise<Array<{ name: string; reason: string }>> {
    const refused: Array<{ name: string; reason: string }> = [];
    for (const f of files) {
      const reason = this.addBlob(f.name, f.type, new Blob([await f.arrayBuffer()], { type: f.type || "application/octet-stream" }), replyTo);
      if (reason) refused.push({ name: f.name, reason });
    }
    return refused;
  }

  /** Adds an in-memory blob as a file item (copied: no link to the disk). */
  addBlob(name: string, mime: string, data: Blob, replyTo?: string): string | null {
    const reason = this.done ? "closed" : this.store.admit("file", data.size);
    if (reason) return reason;
    this.addItem({ kind: "file", name, mime, by: HOST_LABEL, owner: HOST_LABEL, data, replyTo });
    return null;
  }

  addText(text: string, title = ""): string | null {
    const data = new Blob([text], { type: "text/plain" });
    const reason = this.done ? "closed" : data.size > MAX_TEXT_BYTES ? "text-too-large" : this.store.admit("text", data.size);
    if (reason) return reason;
    this.addItem({ kind: "text", name: title, mime: "text/plain", by: HOST_LABEL, owner: HOST_LABEL, data });
    return null;
  }

  /** The host opening an item counts as a download (burns it unless the host wrote it). */
  fetch(id: string): { meta: ItemMeta; data: Blob } | null {
    const got = this.store.take(id, HOST_LABEL);
    if (got?.burned) this.unpost(id);
    return got;
  }

  removeItem(id: string) {
    this.apply(HOST_LABEL, null, { t: "remove", id });
  }

  /** Kill switch: tells every peer to wipe, closes the room on the relay, wipes the host. */
  async destroy(reason: DestroyReason = "destroyed"): Promise<void> {
    if (this.done) return;
    const ready = this.members();
    await Promise.race([
      Promise.all(ready.map(([, p]) => this.sendControl(p, { t: "destroy", reason }))),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    this.signal?.closeWall();
    // Give the SCTP stack a moment to flush the sealed "destroy" before closing.
    await new Promise((r) => setTimeout(r, 200));
    this.finish(reason === "expired" ? "expired" : "destroyed");
  }

  private finish(status: "destroyed" | "expired") {
    if (this.done) return;
    this.done = true;
    if (this.tick) clearInterval(this.tick);
    for (const sid of [...this.pubs.keys()]) this.stopPub(sid);
    for (const p of this.peers.values()) {
      for (const l of p.down.values()) l.close();
      try { p.pc.close(); } catch { /* ignore */ }
    }
    this.peers.clear();
    this.store.wipe();
    this.base = null;
    this.signal?.close();
    releaseUnloadGuard(HOST_GUARD);
    this.update({ status, posts: [], members: [], pinned: null, live: [], media: {}, typing: {} });
  }

  /** Leaving the page / unmount: peers see the host go away (and wipe if the option is on). */
  stop() {
    if (this.done) return;
    this.finish("destroyed");
  }
}
