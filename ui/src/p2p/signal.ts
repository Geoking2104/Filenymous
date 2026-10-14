import { signalUrl } from "./config";

export type SignalRole = "sender" | "receiver";
export type SignalPayload =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export interface SignalHandlers {
  onSignal(payload: SignalPayload): void;
  onPeerJoined?(): void;
  onPeerLeft?(): void;
  onReconnecting?(): void;
  onError?(error: string): void;
}

/**
 * WebSocket client for p2p-signal one-time-code rooms, with automatic
 * reconnection (exponential backoff) so a sender's link survives network blips.
 */
export class SignalClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private queue: string[] = [];

  constructor(
    readonly code: string,
    readonly role: SignalRole,
    private readonly handlers: SignalHandlers,
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

      ws.onopen = () => ws.send(JSON.stringify({ type: "join", code: this.code, role: this.role }));
      ws.onmessage = (ev) => {
        let msg: { type?: string; error?: string; payload?: SignalPayload };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (msg.type) {
          case "joined":
            this.attempt = 0;
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
            while (this.queue.length) ws.send(this.queue.shift()!);
            break;
          case "peer-joined":
            this.handlers.onPeerJoined?.();
            break;
          case "peer-left":
            this.handlers.onPeerLeft?.();
            break;
          case "signal":
            if (msg.payload) this.handlers.onSignal(msg.payload);
            break;
          case "error":
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              this.closed = true;
              ws.close();
              reject(new Error(msg.error || "signal-error"));
            } else {
              this.handlers.onError?.(msg.error || "signal-error");
            }
            break;
          default:
            break;
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("signal-unreachable"));
        }
      };
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

  /** Fresh client with the same room/handlers (after a refused join). */
  clone(): SignalClient {
    return new SignalClient(this.code, this.role, this.handlers, this.url);
  }

  send(payload: SignalPayload): void {
    const text = JSON.stringify({ type: "signal", code: this.code, payload });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.queue.push(text);
  }

  close(): void {
    this.closed = true;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "leave" }));
      this.ws?.close(1000, "done");
    } catch {
      /* ignore */
    }
  }
}

export function iceCandidateInit(c: RTCIceCandidate): RTCIceCandidateInit {
  const init: RTCIceCandidateInit = { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
  if (c.usernameFragment) init.usernameFragment = c.usernameFragment;
  return init;
}
