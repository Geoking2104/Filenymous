/**
 * Runtime configuration for direct P2P transfers.
 *
 * Build-time (Vite env):
 *   VITE_P2P_SIGNAL_URL   WebSocket URL of p2p-signal (default: OpenDPE relay)
 *   VITE_P2P_ICE_SERVERS  JSON RTCIceServer[]; when set, /ice is not queried
 * Otherwise the browser asks GET <signal>/ice, which returns STUN plus
 * short-lived TURN credentials when the relay has TURN_URLS + TURN_SECRET.
 */

const DEFAULT_SIGNAL_URL = "wss://www.opendpe.net/filenymous-signal/";
const FALLBACK_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function env(name: string): string | undefined {
  const v = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function signalUrl(): string {
  const override = (globalThis as { __FILENYMOUS_SIGNAL_URL__?: string }).__FILENYMOUS_SIGNAL_URL__;
  if (override) return override;
  const fromEnv = env("VITE_P2P_SIGNAL_URL");
  if (fromEnv) return fromEnv;
  const host = typeof location !== "undefined" ? location.hostname : "";
  if (host === "localhost" || host === "127.0.0.1") return "ws://127.0.0.1:8789";
  return DEFAULT_SIGNAL_URL;
}

export function signalHttpBase(wsUrl = signalUrl()): string {
  return wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

let icePromise: Promise<RTCIceServer[]> | null = null;
let iceFetchedAt = 0;

export async function iceServers(): Promise<RTCIceServer[]> {
  const fromEnv = env("VITE_P2P_ICE_SERVERS");
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv) as RTCIceServer[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  // TURN credentials are short-lived: refresh every 30 min.
  if (!icePromise || Date.now() - iceFetchedAt > 30 * 60_000) {
    iceFetchedAt = Date.now();
    icePromise = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(`${signalHttpBase()}/ice`, { signal: ctrl.signal, cache: "no-store" });
        clearTimeout(timer);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { iceServers?: RTCIceServer[] };
        return body.iceServers?.length ? body.iceServers : FALLBACK_ICE;
      } catch {
        return FALLBACK_ICE;
      }
    })();
  }
  return icePromise;
}

export function p2pSupported(): boolean {
  return typeof RTCPeerConnection !== "undefined" && typeof WebSocket !== "undefined";
}
