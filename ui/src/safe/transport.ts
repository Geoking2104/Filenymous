/**
 * Coffre-fort P2P transport: WebRTC DataChannels, negotiated through the
 * existing Filenymous signaling relay (its Sharewall "wall" rooms).
 *
 * Each unlocked vault hosts an inbox room whose id is in its contact card;
 * only that vault can host it (the relay checks sha256(secret) = id). A
 * sender joins the room as a peer, opens a DataChannel and pushes one signed,
 * encrypted envelope; the relay only relays SDP/ICE and sees no content.
 * Phase 1: both vaults must be open at the same time (no offline mailbox).
 * The envelope is self-contained, so a TTL mailbox can carry it later.
 */
import { iceServers } from "../p2p/config";
import { iceCandidateInit, type SignalPayload } from "../p2p/signal";
import { WallSignalClient } from "../wall/signal";
import type { Envelope, Outgoing } from "./types";

const CHANNEL = "fny-safe-v1";
const SLICE = 64 * 1024;
const LOW_WATER = 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;

export type DeliveryResult = { status: "new" | "updated" | "stale" | "conflict" | "pending"; } | { status: "rejected"; reason: string } | { status: "offline" | "failed"; reason?: string };

async function addCandidate(pc: RTCPeerConnection, c: RTCIceCandidateInit, pending: RTCIceCandidateInit[]) {
  if (!pc.remoteDescription) return void pending.push(c);
  try {
    await pc.addIceCandidate(c);
  } catch {
    /* stale */
  }
}

function waitLow(ch: RTCDataChannel): Promise<void> {
  if (ch.bufferedAmount <= LOW_WATER) return Promise.resolve();
  return new Promise((ok, ko) => {
    const done = () => {
      ch.removeEventListener("bufferedamountlow", done);
      ch.removeEventListener("close", fail);
      ok();
    };
    const fail = () => {
      ch.removeEventListener("bufferedamountlow", done);
      ko(new Error("closed"));
    };
    ch.addEventListener("bufferedamountlow", done);
    ch.addEventListener("close", fail);
  });
}

function randomPeerId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `s${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/* ── Receiving side: the vault's inbox ── */

export type InboxState = "connecting" | "online" | "busy" | "offline";

export class SafeInbox {
  private signal: WallSignalClient | null = null;
  private pcs = new Map<string, { pc: RTCPeerConnection; pending: RTCIceCandidateInit[] }>();
  private stopped = false;

  constructor(
    private readonly inboxId: string,
    private readonly hostSecret: string,
    private readonly onEnvelope: (env: Envelope) => Promise<DeliveryResult>,
    private readonly onState: (s: InboxState) => void,
  ) {}

  async start(): Promise<void> {
    this.onState("connecting");
    this.signal = new WallSignalClient(
      { wallId: this.inboxId, role: "host", hostSecret: this.hostSecret, destroyOnHostLeave: false },
      {
        onJoined: () => this.onState("online"),
        onSignal: (p, from) => void this.onSignal(p, from),
        onPeerLeft: (id) => this.drop(id),
        onReconnecting: () => this.onState("connecting"),
        onError: (e) => this.onState(e === "wall-host-replaced" ? "busy" : "offline"),
        onClosed: () => this.onState("offline"),
      },
    );
    try {
      await this.signal.connect();
    } catch (e) {
      this.onState(String((e as Error).message) === "wall-host-replaced" ? "busy" : "offline");
    }
  }

  private drop(id: string) {
    const p = this.pcs.get(id);
    this.pcs.delete(id);
    try {
      p?.pc.close();
    } catch {
      /* ignore */
    }
  }

  private async onSignal(payload: SignalPayload, from?: string) {
    if (!from || this.stopped) return;
    if (payload.kind === "offer") {
      this.drop(from);
      const pc = new RTCPeerConnection({ iceServers: await iceServers() });
      const entry = { pc, pending: [] as RTCIceCandidateInit[] };
      this.pcs.set(from, entry);
      pc.onicecandidate = (ev) => ev.candidate && this.signal?.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) }, from);
      pc.ondatachannel = (ev) => {
        if (ev.channel.label !== CHANNEL) return ev.channel.close();
        this.serve(from, ev.channel);
      };
      setTimeout(() => this.pcs.get(from) === entry && this.drop(from), 10 * 60_000);
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      for (const c of entry.pending.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal?.send({ kind: "answer", sdp: answer.sdp ?? "" }, from);
    } else if (payload.kind === "ice") {
      const e = this.pcs.get(from);
      if (e) await addCandidate(e.pc, payload.candidate, e.pending);
    }
  }

  private serve(from: string, ch: RTCDataChannel) {
    ch.binaryType = "arraybuffer";
    let head: { h: string; sig: string; sizes: number[] } | null = null;
    let chunks: Uint8Array[] = [];
    let cur: Uint8Array | null = null;
    let off = 0;
    const reply = (m: object) => ch.readyState === "open" && ch.send(JSON.stringify(m));
    const finish = async () => {
      const result = await this.onEnvelope({ h: head!.h, sig: head!.sig, chunks }).catch((e): DeliveryResult => ({ status: "rejected", reason: String((e as Error).message) }));
      reply({ t: "ack", ...result });
      head = null;
      chunks = [];
      setTimeout(() => this.drop(from), 3000);
    };
    const nextChunk = () => {
      const size = head!.sizes[chunks.length];
      cur = size !== undefined ? new Uint8Array(size) : null;
      off = 0;
    };
    ch.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        let m: { t?: string; h?: string; sig?: string; sizes?: number[] };
        try {
          m = JSON.parse(ev.data);
        } catch {
          return ch.close();
        }
        if (m.t !== "env" || typeof m.h !== "string" || typeof m.sig !== "string" || !Array.isArray(m.sizes) || m.h.length > 4 * 1024 * 1024) return ch.close();
        const sizes = m.sizes.map(Number);
        if (sizes.some((s) => !Number.isSafeInteger(s) || s <= 0) || sizes.reduce((a, b) => a + b, 0) > MAX_TOTAL || sizes.length > 300) return reply({ t: "ack", status: "rejected", reason: "too-large" });
        head = { h: m.h, sig: m.sig, sizes };
        chunks = [];
        nextChunk();
        if (!cur) void finish();
        return;
      }
      if (!head || !cur) return ch.close();
      const data = new Uint8Array(ev.data as ArrayBuffer);
      if (off + data.length > cur.length) return ch.close();
      cur.set(data, off);
      off += data.length;
      if (off === cur.length) {
        chunks.push(cur);
        nextChunk();
        if (!cur) void finish();
      }
    };
  }

  stop() {
    this.stopped = true;
    for (const id of [...this.pcs.keys()]) this.drop(id);
    this.signal?.close();
    this.signal = null;
  }
}

/* ── Sending side ── */

export async function deliver(out: Outgoing, opts: { timeoutMs?: number; onState?: (s: "connecting" | "waiting" | "sending") => void } = {}): Promise<DeliveryResult> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  let pc: RTCPeerConnection | null = null;
  let signal: WallSignalClient | null = null;
  const pendingIce: RTCIceCandidateInit[] = [];
  let begun = false;
  return new Promise<DeliveryResult>((resolve) => {
    let settled = false;
    const done = (r: DeliveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc?.close();
      } catch {
        /* ignore */
      }
      signal?.close();
      resolve(r);
    };
    // Bounded wait: the relay closes rooms left without a host for too long, so never linger.
    const timer = setTimeout(() => done({ status: begun ? "failed" : "offline", reason: "timeout" }), timeoutMs);
    const begin = async () => {
      if (begun || settled) return;
      begun = true;
      opts.onState?.("sending");
      pc = new RTCPeerConnection({ iceServers: await iceServers() });
      const ch = pc.createDataChannel(CHANNEL, { ordered: true });
      ch.binaryType = "arraybuffer";
      ch.bufferedAmountLowThreshold = LOW_WATER / 2;
      pc.onicecandidate = (ev) => ev.candidate && signal?.send({ kind: "ice", candidate: iceCandidateInit(ev.candidate) });
      pc.onconnectionstatechange = () => pc?.connectionState === "failed" && done({ status: "failed", reason: "ice" });
      ch.onopen = async () => {
        try {
          const env = out.envelope;
          ch.send(JSON.stringify({ t: "env", h: env.h, sig: env.sig, sizes: env.chunks.map((c) => c.length) }));
          for (const c of env.chunks) {
            for (let o = 0; o < c.length; o += SLICE) {
              await waitLow(ch);
              ch.send(c.slice(o, Math.min(c.length, o + SLICE)) as Uint8Array<ArrayBuffer>);
            }
          }
        } catch {
          done({ status: "failed", reason: "channel" });
        }
      };
      ch.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const m = JSON.parse(ev.data) as { t: string; status: string; reason?: string };
          if (m.t === "ack") done(m.status === "rejected" ? { status: "rejected", reason: m.reason || "rejected" } : { status: m.status as "new" });
        } catch {
          /* ignore */
        }
      };
      ch.onclose = () => done({ status: "failed", reason: "closed" });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signal?.send({ kind: "offer", sdp: offer.sdp ?? "" });
    };
    opts.onState?.("connecting");
    signal = new WallSignalClient(
      { wallId: out.inbox, role: "peer", peerId: randomPeerId() },
      {
        onJoined: (info) => {
          if (info.hostOnline) void begin();
          else opts.onState?.("waiting");
        },
        onHostOnline: () => void begin(),
        onHostOffline: () => !begun && opts.onState?.("waiting"),
        onSignal: async (p) => {
          if (!pc) return;
          if (p.kind === "answer" && pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
            for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
          } else if (p.kind === "ice") await addCandidate(pc, p.candidate, pendingIce);
        },
        onClosed: () => done({ status: "offline", reason: "closed" }),
        onError: (e) => done({ status: "failed", reason: e }),
      },
    );
    signal.connect().catch((e) => done({ status: "failed", reason: String((e as Error).message) }));
  });
}
