import { WHISPER_MODEL, loadTransformers } from "./models";

const ctx = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null };

type Asr = (audio: Float32Array, o: object) => Promise<{ text: string } | { text: string }[]>;
let asr: Promise<Asr> | null = null;

const ready = () =>
  (asr ??= loadTransformers().then(async (m) => {
    const p = await m.pipeline("automatic-speech-recognition", WHISPER_MODEL.id, {
      dtype: { encoder_model: WHISPER_MODEL.dtype, decoder_model_merged: WHISPER_MODEL.dtype },
      device: "wasm",
    });
    return p as unknown as Asr;
  }));

type Req = { id: number; warm: true } | { id: number; audio: Float32Array; en: boolean };

ctx.onmessage = async (e: MessageEvent<Req>) => {
  const { id } = e.data;
  try {
    const run = await ready();
    if ("warm" in e.data) return ctx.postMessage({ id, ok: true });
    // Whisper's only translation target is English ("translate"); otherwise it
    // transcribes in the spoken language (auto-detected).
    const out = await run(e.data.audio, { task: e.data.en ? "translate" : "transcribe", return_timestamps: false });
    const text = Array.isArray(out) ? out.map((x) => x.text).join(" ") : out.text;
    ctx.postMessage({ id, ok: true, text });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String((err as Error)?.message || err) });
  }
};
