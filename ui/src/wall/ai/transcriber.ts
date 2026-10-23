/**
 * Live captions in the host tab: taps the audio of the live streams the host
 * already has (own capture or forwarded from a publisher), cuts it into ~8 s
 * chunks and runs Whisper tiny (q8, self-hosted) in a worker. Nothing is sent
 * anywhere by this module: the host posts the text to the wall (postCaption),
 * where it is sealed and delivered like any message.
 */
import { CHUNK_S, SAMPLE_RATE, SILENCE_RMS, cleanCaption, rms } from "./captions";

type Tap = { ctx: AudioContext; node: ScriptProcessorNode; src: MediaStreamAudioSourceNode; buf: Float32Array[]; len: number };

export class Transcriber {
  private worker: Worker | null = null;
  private seq = 0;
  private wait = new Map<number, { ok: (t: string) => void; ko: (e: Error) => void }>();
  private taps = new Map<string, Tap>();
  private queue: { sid: string; audio: Float32Array }[] = [];
  private busy = false;
  en = false;

  constructor(private onText: (sid: string, text: string) => void) {}

  private call(msg: object): Promise<string> {
    if (!this.worker) {
      this.worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; text?: string; error?: string }>) => {
        const w = this.wait.get(e.data.id);
        if (!w) return;
        this.wait.delete(e.data.id);
        if (e.data.ok) w.ok(e.data.text ?? "");
        else w.ko(new Error(e.data.error || "transcription failed"));
      };
      this.worker.onerror = () => {
        for (const w of this.wait.values()) w.ko(new Error("speech worker crashed"));
        this.wait.clear();
      };
    }
    const id = ++this.seq;
    return new Promise((ok, ko) => {
      this.wait.set(id, { ok, ko });
      this.worker!.postMessage({ id, ...msg });
    });
  }

  warm(): Promise<string> {
    return this.call({ warm: true });
  }

  /** Follows the current set of live streams (call on every change). */
  sync(media: Record<string, MediaStream>) {
    for (const [sid, tap] of this.taps) if (!media[sid]?.getAudioTracks().some((t) => t.readyState === "live")) this.untap(sid, tap);
    for (const [sid, stream] of Object.entries(media)) {
      if (this.taps.has(sid) || !stream.getAudioTracks().length) continue;
      this.tap(sid, stream);
    }
  }

  private tap(sid: string, stream: MediaStream) {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const tap: Tap = { ctx, node, src, buf: [], len: 0 };
    node.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      tap.buf.push(new Float32Array(ch));
      tap.len += ch.length;
      if (tap.len >= CHUNK_S * SAMPLE_RATE) {
        const audio = new Float32Array(tap.len);
        let o = 0;
        for (const b of tap.buf) audio.set(b, (o += b.length) - b.length);
        tap.buf = [];
        tap.len = 0;
        this.push(sid, audio);
      }
    };
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    this.taps.set(sid, tap);
  }

  private untap(sid: string, tap: Tap) {
    tap.node.onaudioprocess = null;
    tap.src.disconnect();
    tap.node.disconnect();
    void tap.ctx.close();
    this.taps.delete(sid);
  }

  private push(sid: string, audio: Float32Array) {
    if (rms(audio) < SILENCE_RMS) return;
    this.queue.push({ sid, audio });
    // Never fall behind live: keep at most the 2 most recent chunks waiting.
    while (this.queue.length > 2) this.queue.shift();
    void this.pump();
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        const text = cleanCaption(await this.call({ audio: job.audio, en: this.en }).catch(() => ""));
        if (text) this.onText(job.sid, text);
      }
    } finally {
      this.busy = false;
    }
  }

  dispose() {
    for (const [sid, tap] of this.taps) this.untap(sid, tap);
    this.queue = [];
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.wait.values()) w.ko(new Error("disposed"));
    this.wait.clear();
  }
}
