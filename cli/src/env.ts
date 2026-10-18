/**
 * Browser-API shims so the web app's own P2P code (ui/src/p2p) runs unchanged
 * in Node: WebRTC via node-datachannel (libdatachannel), WebSocket via ws.
 */
import { RTCPeerConnection as NdcPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel } from "node-datachannel/polyfill";
import WebSocketImpl from "ws";
import { webcrypto } from "node:crypto";

type IceHandler = ((ev: { candidate: RTCIceCandidateInit | null }) => void) | null;

/** "a=candidate:…" → "candidate:…" (browsers expect the bare attribute value). */
export function normalizeCandidate(c: string): string {
  return c.replace(/^a=/, "");
}

/**
 * libdatachannel emits host candidates *during* createOffer/setLocalDescription,
 * i.e. before the app has sent its description; a browser peer would drop those
 * early candidates. Hold them (see flush) and normalise their shape.
 */
export class CliPeerConnection extends NdcPeerConnection {
  private pendingLocal = 0;
  private remoteSet = false;
  private held: Array<{ candidate: RTCIceCandidateInit | null }> = [];
  private userHandler: IceHandler = null;

  constructor(config?: RTCConfiguration) {
    super(config as never);
    const inner = (ev: { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null }) => {
      const c = ev.candidate;
      const out = { candidate: c ? { candidate: normalizeCandidate(c.candidate), sdpMid: c.sdpMid ?? "0", sdpMLineIndex: c.sdpMLineIndex ?? 0 } : null };
      if (this.pendingLocal > 0 || !this.remoteSet) this.held.push(out);
      else this.userHandler?.(out);
    };
    Object.defineProperty(this, "onicecandidate", {
      configurable: true,
      get: () => (this.userHandler ? inner : null),
      set: (h: IceHandler) => { this.userHandler = h; },
    });
  }

  // The polyfill may start gathering as soon as createOffer/createAnswer runs.
  override async createOffer(_opts?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.pendingLocal = 1;
    return super.createOffer() as Promise<RTCSessionDescriptionInit>;
  }

  override async createAnswer(_opts?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
    this.pendingLocal = 1;
    return super.createAnswer() as Promise<RTCSessionDescriptionInit>;
  }

  override async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
    this.pendingLocal = 1;
    try {
      await super.setLocalDescription(desc as never);
    } finally {
      // A macrotask later the app has sent the description over signaling.
      setTimeout(() => {
        this.pendingLocal = 0;
        this.flush();
      }, 0);
    }
  }

  override async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await super.setRemoteDescription(desc as never);
    this.remoteSet = true;
    this.flush();
  }

  /**
   * Released only once the peer surely has a connection object: after our
   * description was sent AND theirs arrived. Web receivers (≤ v2026-10) drop
   * candidates that arrive while they're still fetching ICE servers.
   */
  private flush() {
    if (this.pendingLocal > 0 || !this.remoteSet) return;
    for (const ev of this.held.splice(0)) this.userHandler?.(ev);
  }
}

export function installBrowserShims(signalUrl: string): void {
  const g = globalThis as Record<string, unknown>;
  // Node 18 only exposes WebCrypto on node:crypto.
  if (!(g.crypto as Crypto | undefined)?.subtle) Object.defineProperty(g, "crypto", { value: webcrypto, configurable: true });
  g.RTCPeerConnection = CliPeerConnection;
  g.RTCSessionDescription ??= RTCSessionDescription;
  g.RTCIceCandidate ??= RTCIceCandidate;
  g.RTCDataChannel ??= RTCDataChannel;
  if (!g.WebSocket) g.WebSocket = WebSocketImpl;
  g.__FILENYMOUS_SIGNAL_URL__ = signalUrl;
}
