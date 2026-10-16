import { signalUrl } from "../config";
import type { SignalPayload } from "../signal";

export type DropRole = "owner" | "contributor";

export interface DropSignalHandlers {
  onJoined?(info: { ownerOnline?: boolean; contributors?: string[]; expiresAt?: number }): void;
  onSignal(payload: SignalPayload, from?: string): void;
  onPeerJoined?(peerId: string): void;
  onPeerLeft?(peerId: string): void;
  onOwnerOnline?(): void;
  onOwnerOffline?(): void;
  onExpired?(): void;
  onReconnecting?(): void;
  onError?(error: string): void;
}

export interface DropJoin {
  dropId: string;
  role: DropRole;
  ownerSecret?: string;
  expiresAt?: number;
  peerId?: string;
}

const FATAL = new Set(["drop-expired", "drop-owner-denied", "drop-owner-replaced", "invalid-drop", "drop-full"]);

/** WebSocket client for p2p-signal dropzone rooms, with reconnection. */
export class DropSignalClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private queue: string[] = [];

  constructor(
    readonly join: DropJoin,
    private readonly handlers: DropSignalHandlers,
    private readonly url = signalUrl(),
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
        // close() may have been called while connecting (e.g. React remount).
        if (this.closed) {
          ws.close(1000, "closed");
          settle(new Error("closed"));
          return;
        }
        ws.send(JSON.stringify({ type: "drop-join", ...this.join }));
      };
      ws.onmessage = (ev) => {
        if (this.closed && this.ws === ws && !settled) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (msg.type) {
          case "drop-joined":
            this.attempt = 0;
            settle();
            this.handlers.onJoined?.({
              ownerOnline: msg.ownerOnline as boolean | undefined,
              contributors: msg.contributors as string[] | undefined,
              expiresAt: msg.expiresAt as number | undefined,
            });
            while (this.queue.length) ws.send(this.queue.shift()!);
            break;
          case "drop-signal":
            if (msg.payload) this.handlers.onSignal(msg.payload as SignalPayload, msg.from as string | undefined);
            break;
          case "drop-peer-joined":
            this.handlers.onPeerJoined?.(String(msg.peerId));
            break;
          case "drop-peer-left":
            this.handlers.onPeerLeft?.(String(msg.peerId));
            break;
          case "drop-owner-online":
            this.handlers.onOwnerOnline?.();
            break;
          case "drop-owner-offline":
            this.handlers.onOwnerOffline?.();
            break;
          case "drop-expired":
            this.closed = true;
            this.handlers.onExpired?.();
            break;
          case "error": {
            const error = String(msg.error || "signal-error");
            if (!settled) {
              this.closed = true;
              try { ws.close(); } catch { /* ignore */ }
              settle(new Error(error));
            } else {
              if (FATAL.has(error)) this.closed = true;
              if (error === "drop-expired") this.handlers.onExpired?.();
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
    const text = JSON.stringify({ type: "drop-signal", payload, ...(to ? { to } : {}) });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.queue.push(text);
  }

  close(): void {
    this.closed = true;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "drop-leave" }));
      this.ws?.close(1000, "done");
    } catch {
      /* ignore */
    }
  }
}
