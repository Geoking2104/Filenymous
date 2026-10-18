import { signalUrl } from "../p2p/config";
import type { SignalPayload } from "../p2p/signal";

export type WallRole = "host" | "peer";

export interface WallJoin {
  wallId: string;
  role: WallRole;
  hostSecret?: string;
  expiresAt?: number;
  destroyOnHostLeave?: boolean;
  peerId?: string;
}

export interface WallSignalHandlers {
  onJoined?(info: { hostOnline?: boolean; peers?: string[]; expiresAt?: number }): void;
  onSignal(payload: SignalPayload, from?: string): void;
  onPeerJoined?(peerId: string): void;
  onPeerLeft?(peerId: string): void;
  onHostOnline?(): void;
  onHostOffline?(): void;
  onClosed?(reason: string): void;
  onReconnecting?(): void;
  onError?(error: string): void;
}

/** Sharewall signaling lives on its own path so the relay's nginx can skip access logs for it. */
export function wallSignalUrl(base = signalUrl()): string {
  return `${base.replace(/\/+$/, "")}/wall`;
}

/**
 * The only thing the relay ever receives to join a wall: an opaque wall id,
 * a random peer id, and for the host the host secret (whose hash is the wall
 * id), the expiry and the "destroy on host leave" flag. Never the wall key,
 * a password, a name or any content.
 */
export function wallJoinMessage(j: WallJoin): Record<string, unknown> {
  if (j.role === "host") {
    return { type: "wall-join", wallId: j.wallId, role: "host", hostSecret: j.hostSecret, expiresAt: j.expiresAt, destroyOnHostLeave: !!j.destroyOnHostLeave };
  }
  return { type: "wall-join", wallId: j.wallId, role: "peer", peerId: j.peerId };
}

const FATAL = new Set(["wall-closed", "wall-host-denied", "wall-host-replaced", "invalid-wall", "wall-full"]);

/** WebSocket client for p2p-signal walls, with reconnection. */
export class WallSignalClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private queue: string[] = [];

  constructor(
    readonly join: WallJoin,
    private readonly handlers: WallSignalHandlers,
    private readonly url = wallSignalUrl(),
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("signal-timeout"));
      }, 10_000);
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      ws.onopen = () => {
        if (this.closed) {
          ws.close(1000, "closed");
          settle(new Error("closed"));
          return;
        }
        ws.send(JSON.stringify(wallJoinMessage(this.join)));
      };
      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (msg.type) {
          case "wall-joined":
            this.attempt = 0;
            settle();
            this.handlers.onJoined?.({ hostOnline: msg.hostOnline as boolean | undefined, peers: msg.peers as string[] | undefined, expiresAt: msg.expiresAt as number | undefined });
            while (this.queue.length) ws.send(this.queue.shift()!);
            break;
          case "wall-signal":
            if (msg.payload) this.handlers.onSignal(msg.payload as SignalPayload, msg.from as string | undefined);
            break;
          case "wall-peer-joined":
            this.handlers.onPeerJoined?.(String(msg.peerId));
            break;
          case "wall-peer-left":
            this.handlers.onPeerLeft?.(String(msg.peerId));
            break;
          case "wall-host-online":
            this.handlers.onHostOnline?.();
            break;
          case "wall-host-offline":
            this.handlers.onHostOffline?.();
            break;
          case "wall-closed":
            this.closed = true;
            this.handlers.onClosed?.(String(msg.reason || "closed"));
            break;
          case "error": {
            const error = String(msg.error || "signal-error");
            if (!settled) {
              this.closed = true;
              try { ws.close(); } catch { /* ignore */ }
              settle(new Error(error));
            } else {
              if (FATAL.has(error)) this.closed = true;
              if (error === "wall-closed") this.handlers.onClosed?.("closed");
              else this.handlers.onError?.(error);
            }
            break;
          }
          default:
            break;
        }
      };
      ws.onerror = () => settle(new Error("signal-unreachable"));
      ws.onclose = () => {
        if (this.ws !== ws || this.closed || !settled) return;
        this.handlers.onReconnecting?.();
        const delay = Math.min(15_000, 500 * 2 ** this.attempt++);
        setTimeout(() => {
          if (this.closed) return;
          this.connect().catch((e) => this.handlers.onError?.(String((e as Error).message || e)));
        }, delay);
      };
    });
  }

  send(payload: SignalPayload, to?: string): void {
    const text = JSON.stringify({ type: "wall-signal", payload, ...(to ? { to } : {}) });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.queue.push(text);
  }

  /** Host kill switch: asks the relay to close the wall for everyone, then disconnects. */
  closeWall(): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "wall-close" }));
    } catch {
      /* ignore */
    }
    this.close();
  }

  close(): void {
    this.closed = true;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "wall-leave" }));
      this.ws?.close(1000, "done");
    } catch {
      /* ignore */
    }
  }
}
