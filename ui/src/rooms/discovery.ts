/**
 * Filenymous Room P2P Discovery Protocol
 *
 * Browser-first peer discovery for Rooms:
 *  - Transport A: BroadcastChannel (same-origin multi-tab, zero server)
 *  - Transport B: pluggable send hook (WebRTC DataChannel / future Holochain signal)
 *
 * Protocol messages are JSON, versioned, and room-scoped via channel name
 * derived from roomId + inviteCode (no plaintext secrets on the wire beyond
 * what the invite already grants).
 *
 * Message kinds:
 *  hello          — join announcement + full presence
 *  presence       — heartbeat / status update
 *  bye            — graceful leave
 *  library-sync   — full or delta shared-file catalog
 *  library-query  — ask peers to re-announce library
 *  transfer-ask   — request a shared file from owner
 *  signal         — WebRTC SDP/ICE relay (uses assertAllowedSignalPayload)
 */

import { assertAllowedSignalPayload, type SignalPayload } from "./directTransfer";
import type { PresenceStatus, RoomPeer, RoomSharedFile } from "./types";

export const DISCOVERY_PROTOCOL_VERSION = 1;
export const PRESENCE_TTL_MS = 45_000;
export const HEARTBEAT_INTERVAL_MS = 12_000;
export const STALE_SWEEP_INTERVAL_MS = 8_000;

export type DiscoveryMessage =
  | {
      v: typeof DISCOVERY_PROTOCOL_VERSION;
      kind: "hello";
      roomId: string;
      peer: RoomPeer;
      sharedFiles: RoomSharedFile[];
      ts: number;
    }
  | {
      v: typeof DISCOVERY_PROTOCOL_VERSION;
      kind: "presence";
      roomId: string;
      peer: RoomPeer;
      ts: number;
    }
  | {
      v: typeof DISCOVERY_PROTOCOL_VERSION;
      kind: "bye";
      roomId: string;
      peerId: string;
      ts: number;
    }
  | {
      v: typeof DISCOVERY_PROTOCOL_VERSION;
      kind: "library-sync";
      roomId: string;
      peerId: string;
      files: RoomSharedFile[];
      mode: "full" | "delta-add" | "delta-remove";
      ts: number;
    }
  | {
      v: typeof DISCOVERY_PROTOCOL_VERSION;
      kind: "library-query";
      roomId: string;
      peerId: string;
      ts: number;
    }
  | {
      v: typeof DISCOVERY_PROTOCOL_VERSION;
      kind: "transfer-ask";
      roomId: string;
      fromPeerId: string;
      toPeerId: string;
      shareId: string;
      fileName: string;
      ts: number;
    }
  | {
      v: typeof DISCOVERY_PROTOCOL_VERSION;
      kind: "signal";
      roomId: string;
      fromPeerId: string;
      toPeerId: string;
      payload: SignalPayload;
      ts: number;
    };

export interface DiscoveryHandlers {
  onPeerJoin?(peer: RoomPeer): void;
  onPeerUpdate?(peer: RoomPeer): void;
  onPeerLeave?(peerId: string): void;
  onLibrarySync?(peerId: string, files: RoomSharedFile[], mode: "full" | "delta-add" | "delta-remove"): void;
  onTransferAsk?(msg: Extract<DiscoveryMessage, { kind: "transfer-ask" }>): void;
  onSignal?(fromPeerId: string, payload: SignalPayload): void;
  /** Optional external transport (e.g. WebRTC DataChannel send) */
  sendExternal?(raw: string): void;
}

function channelName(roomId: string, inviteCode: string): string {
  // Scope discovery to room + invite so random rooms don't collide
  const safe = `${roomId}:${inviteCode}`.replace(/[^a-zA-Z0-9:_-]/g, "_");
  return `filenymous-room-v${DISCOVERY_PROTOCOL_VERSION}:${safe}`;
}

function isDiscoveryMessage(value: unknown): value is DiscoveryMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.v !== DISCOVERY_PROTOCOL_VERSION) return false;
  if (typeof m.kind !== "string" || typeof m.roomId !== "string" || typeof m.ts !== "number") return false;
  return [
    "hello",
    "presence",
    "bye",
    "library-sync",
    "library-query",
    "transfer-ask",
    "signal",
  ].includes(m.kind);
}

function freshPeer(peer: RoomPeer, now = Date.now()): RoomPeer {
  return {
    ...peer,
    lastSeenMs: now,
    expiresAtMs: now + PRESENCE_TTL_MS,
    status: peer.status === "leaving" ? "leaving" : "online",
  };
}

/**
 * RoomDiscovery — manages presence + library advertisement over BroadcastChannel
 * (and optional external send). Safe to construct per active room session.
 */
export class RoomDiscovery {
  readonly roomId: string;
  readonly inviteCode: string;
  readonly localPeer: RoomPeer;

  private channel: BroadcastChannel | null = null;
  private handlers: DiscoveryHandlers;
  private peers = new Map<string, RoomPeer>();
  private localLibrary: RoomSharedFile[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    roomId: string,
    inviteCode: string,
    localPeer: RoomPeer,
    handlers: DiscoveryHandlers = {},
  ) {
    this.roomId = roomId;
    this.inviteCode = inviteCode;
    this.localPeer = freshPeer(localPeer);
    this.handlers = handlers;
  }

  /** Start listening and announce ourselves */
  start(initialLibrary: RoomSharedFile[] = []): void {
    if (this.closed) return;
    this.localLibrary = initialLibrary.map((f) => ({ ...f, roomId: this.roomId }));

    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(channelName(this.roomId, this.inviteCode));
      this.channel.onmessage = (ev) => this.handleRaw(ev.data);
    }

    this.broadcast(this.makeHello());
    // Ask others to re-announce libraries
    this.broadcast({
      v: DISCOVERY_PROTOCOL_VERSION,
      kind: "library-query",
      roomId: this.roomId,
      peerId: this.localPeer.peerId,
      ts: Date.now(),
    });

    this.heartbeatTimer = setInterval(() => this.tickHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.sweepTimer = setInterval(() => this.sweepStale(), STALE_SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.broadcast({
      v: DISCOVERY_PROTOCOL_VERSION,
      kind: "bye",
      roomId: this.roomId,
      peerId: this.localPeer.peerId,
      ts: Date.now(),
    });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.channel?.close();
    this.channel = null;
    this.peers.clear();
  }

  getPeers(): RoomPeer[] {
    return [this.localPeer, ...Array.from(this.peers.values())];
  }

  setLocalLibrary(files: RoomSharedFile[]): void {
    this.localLibrary = files.map((f) => ({ ...f, roomId: this.roomId, ownerId: this.localPeer.peerId }));
    this.broadcast({
      v: DISCOVERY_PROTOCOL_VERSION,
      kind: "library-sync",
      roomId: this.roomId,
      peerId: this.localPeer.peerId,
      files: this.localLibrary,
      mode: "full",
      ts: Date.now(),
    });
  }

  announceLibraryAdd(files: RoomSharedFile[]): void {
    const owned = files.map((f) => ({ ...f, roomId: this.roomId, ownerId: this.localPeer.peerId }));
    this.localLibrary = [
      ...owned,
      ...this.localLibrary.filter((f) => !owned.some((o) => o.shareId === f.shareId)),
    ];
    this.broadcast({
      v: DISCOVERY_PROTOCOL_VERSION,
      kind: "library-sync",
      roomId: this.roomId,
      peerId: this.localPeer.peerId,
      files: owned,
      mode: "delta-add",
      ts: Date.now(),
    });
  }

  announceLibraryRemove(shareIds: string[]): void {
    this.localLibrary = this.localLibrary.filter((f) => !shareIds.includes(f.shareId));
    this.broadcast({
      v: DISCOVERY_PROTOCOL_VERSION,
      kind: "library-sync",
      roomId: this.roomId,
      peerId: this.localPeer.peerId,
      files: shareIds.map((shareId) => ({
        shareId,
        roomId: this.roomId,
        ownerId: this.localPeer.peerId,
        ownerName: this.localPeer.displayName,
        fileName: "",
        fileSize: 0,
        mimeType: "",
        localOnly: true,
        addedAtMs: 0,
      })),
      mode: "delta-remove",
      ts: Date.now(),
    });
  }

  askTransfer(toPeerId: string, shareId: string, fileName: string): void {
    this.broadcast({
      v: DISCOVERY_PROTOCOL_VERSION,
      kind: "transfer-ask",
      roomId: this.roomId,
      fromPeerId: this.localPeer.peerId,
      toPeerId,
      shareId,
      fileName,
      ts: Date.now(),
    });
  }

  /** Relay WebRTC signaling to a specific peer (validated) */
  sendSignal(toPeerId: string, payload: SignalPayload): void {
    assertAllowedSignalPayload(payload);
    this.broadcast({
      v: DISCOVERY_PROTOCOL_VERSION,
      kind: "signal",
      roomId: this.roomId,
      fromPeerId: this.localPeer.peerId,
      toPeerId,
      payload,
      ts: Date.now(),
    });
  }

  /** Inject a message from an external transport (DataChannel, etc.) */
  receiveExternal(raw: unknown): void {
    this.handleRaw(raw);
  }

  setExternalSender(send: (raw: string) => void): void {
    this.handlers.sendExternal = send;
  }

  // ── internals ──────────────────────────────────────────────

  private makeHello(): DiscoveryMessage {
    return {
      v: DISCOVERY_PROTOCOL_VERSION,
      kind: "hello",
      roomId: this.roomId,
      peer: freshPeer(this.localPeer),
      sharedFiles: this.localLibrary,
      ts: Date.now(),
    };
  }

  private tickHeartbeat(): void {
    if (this.closed) return;
    this.localPeer.lastSeenMs = Date.now();
    this.localPeer.expiresAtMs = Date.now() + PRESENCE_TTL_MS;
    this.localPeer.status = "online";
    this.broadcast({
      v: DISCOVERY_PROTOCOL_VERSION,
      kind: "presence",
      roomId: this.roomId,
      peer: freshPeer(this.localPeer),
      ts: Date.now(),
    });
  }

  private sweepStale(): void {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (peer.expiresAtMs <= now) {
        this.peers.delete(id);
        this.handlers.onPeerLeave?.(id);
      }
    }
  }

  private broadcast(msg: DiscoveryMessage): void {
    if (this.closed) return;
    const raw = JSON.stringify(msg);
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* channel closed */
    }
    try {
      this.handlers.sendExternal?.(raw);
    } catch {
      /* external transport failed */
    }
  }

  private handleRaw(data: unknown): void {
    let msg: unknown = data;
    if (typeof data === "string") {
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!isDiscoveryMessage(msg)) return;
    if (msg.roomId !== this.roomId) return;

    // Ignore our own echoes
    if ("peerId" in msg && msg.peerId === this.localPeer.peerId) return;
    if ("peer" in msg && msg.peer.peerId === this.localPeer.peerId) return;
    if ("fromPeerId" in msg && msg.fromPeerId === this.localPeer.peerId) return;

    switch (msg.kind) {
      case "hello":
        this.upsertPeer(msg.peer, true);
        this.handlers.onLibrarySync?.(msg.peer.peerId, msg.sharedFiles, "full");
        // Reply with our hello so the newcomer sees us
        this.broadcast(this.makeHello());
        break;
      case "presence":
        this.upsertPeer(msg.peer, false);
        break;
      case "bye":
        if (this.peers.delete(msg.peerId)) this.handlers.onPeerLeave?.(msg.peerId);
        break;
      case "library-sync":
        this.handlers.onLibrarySync?.(msg.peerId, msg.files, msg.mode);
        break;
      case "library-query":
        this.broadcast({
          v: DISCOVERY_PROTOCOL_VERSION,
          kind: "library-sync",
          roomId: this.roomId,
          peerId: this.localPeer.peerId,
          files: this.localLibrary,
          mode: "full",
          ts: Date.now(),
        });
        break;
      case "transfer-ask":
        if (msg.toPeerId === this.localPeer.peerId) {
          this.handlers.onTransferAsk?.(msg);
        }
        break;
      case "signal":
        if (msg.toPeerId === this.localPeer.peerId) {
          try {
            assertAllowedSignalPayload(msg.payload);
            this.handlers.onSignal?.(msg.fromPeerId, msg.payload);
          } catch {
            /* drop invalid signal */
          }
        }
        break;
    }
  }

  private upsertPeer(peer: RoomPeer, isJoin: boolean): void {
    const prev = this.peers.get(peer.peerId);
    const next = freshPeer(peer);
    this.peers.set(peer.peerId, next);
    if (!prev || isJoin) this.handlers.onPeerJoin?.(next);
    else this.handlers.onPeerUpdate?.(next);
  }
}

/** Derive a stable local peer id for this browser profile (sessionStorage). */
export function getOrCreateLocalPeerId(): string {
  const key = "filenymous.room.peerId";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) return existing;
    const id = `peer-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 12)}`;
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `peer-${Date.now().toString(36)}`;
  }
}

export function createLocalRoomPeer(displayName = "You"): RoomPeer {
  const peerId = getOrCreateLocalPeerId();
  const now = Date.now();
  return {
    peerId,
    displayName,
    avatarSeed: peerId,
    status: "online" as PresenceStatus,
    lastSeenMs: now,
    expiresAtMs: now + PRESENCE_TTL_MS,
  };
}
