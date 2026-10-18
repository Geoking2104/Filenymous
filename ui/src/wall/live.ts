/**
 * Live screen / camera / mic sharing on a Sharewall.
 *
 * Star topology, like the rest of the wall: the publisher sends its tracks to
 * the host over a dedicated media RTCPeerConnection ("up:<sid>"), and the host
 * forwards the received tracks to each viewer over one more connection per
 * viewer ("down:<sid>"). The SDP offers/answers and ICE candidates of these
 * connections travel inside the sealed (E2EE) DataChannel, so the relay never
 * sees them. Media is encrypted by WebRTC (DTLS-SRTP) on each hop; the host,
 * like for files, is the trusted hub and handles the decrypted media.
 *
 * The sending side of a link is always the offerer, and a link carries one
 * publication only, so there is no renegotiation or offer glare.
 */
import { iceServers } from "../p2p/config";
import { iceCandidateInit } from "../p2p/signal";
import type { RtcMessage } from "./model";

export const LIVE_WAIT_TRACKS_MS = 15_000;

export class MediaLink {
  readonly pc: RTCPeerConnection;
  private pending: RTCIceCandidateInit[] = [];
  private closed = false;

  private constructor(
    readonly link: string,
    pc: RTCPeerConnection,
    private readonly send: (m: RtcMessage) => void,
    onTrack?: (track: MediaStreamTrack, stream: MediaStream | undefined) => void,
    onFail?: () => void,
  ) {
    this.pc = pc;
    pc.onicecandidate = (ev) => {
      if (ev.candidate && !this.closed) this.send({ t: "rtc", link, kind: "ice", candidate: iceCandidateInit(ev.candidate) });
    };
    if (onTrack) pc.ontrack = (ev) => onTrack(ev.track, ev.streams[0]);
    pc.onconnectionstatechange = () => {
      if (!this.closed && (pc.connectionState === "failed" || pc.connectionState === "closed")) onFail?.();
    };
  }

  static async create(
    link: string,
    send: (m: RtcMessage) => void,
    handlers: { onTrack?: (track: MediaStreamTrack, stream: MediaStream | undefined) => void; onFail?: () => void } = {},
  ): Promise<MediaLink> {
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    return new MediaLink(link, pc, send, handlers.onTrack, handlers.onFail);
  }

  /** Sending side: add the tracks and offer. */
  async offer(tracks: MediaStreamTrack[], stream: MediaStream): Promise<void> {
    for (const t of tracks) this.pc.addTrack(t, stream);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (!this.closed) this.send({ t: "rtc", link: this.link, kind: "offer", sdp: offer.sdp ?? "" });
  }

  async onRtc(msg: RtcMessage): Promise<void> {
    if (this.closed) return;
    const pc = this.pc;
    if (msg.kind === "offer" && msg.sdp) {
      if (pc.signalingState !== "stable") return;
      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      await this.flush();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send({ t: "rtc", link: this.link, kind: "answer", sdp: answer.sdp ?? "" });
    } else if (msg.kind === "answer" && msg.sdp) {
      if (pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      await this.flush();
    } else if (msg.kind === "ice" && msg.candidate) {
      if (!pc.remoteDescription) this.pending.push(msg.candidate);
      else await pc.addIceCandidate(msg.candidate).catch(() => undefined);
    }
  }

  private async flush() {
    for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c).catch(() => undefined);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.pc.close(); } catch { /* ignore */ }
  }
}

/** Whether this runtime can carry live media (browsers; not the Node CLI). */
export function mediaSupported(): boolean {
  return typeof MediaStream !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices;
}

/** Asks the browser for a screen or camera stream (+ mic). Throws on refusal. */
export async function captureMedia(kind: "screen" | "camera", withAudio: boolean): Promise<MediaStream> {
  const md = navigator.mediaDevices;
  if (kind === "screen") {
    const screen = await md.getDisplayMedia({ video: true, audio: false });
    if (!withAudio) return screen;
    try {
      const mic = await md.getUserMedia({ audio: true });
      return new MediaStream([...screen.getVideoTracks(), ...mic.getAudioTracks()]);
    } catch {
      return screen;
    }
  }
  return md.getUserMedia({ video: true, audio: withAudio });
}

export function stopStream(s: MediaStream | null | undefined) {
  s?.getTracks().forEach((t) => t.stop());
}
