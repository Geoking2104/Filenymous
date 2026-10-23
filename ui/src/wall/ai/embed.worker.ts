import { EMBED_MODEL, loadTransformers } from "./models";

const ctx = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };

type Req = { id: number; texts: string[] };
let extractor: Promise<(t: string[], o: object) => Promise<{ data: Float32Array; dims: number[] }>> | null = null;

const ready = () =>
  (extractor ??= loadTransformers().then(async (m) => {
    const p = await m.pipeline("feature-extraction", EMBED_MODEL.id, { dtype: EMBED_MODEL.dtype, device: "wasm" });
    return p as unknown as (t: string[], o: object) => Promise<{ data: Float32Array; dims: number[] }>;
  }));

ctx.onmessage = async (e: MessageEvent<Req | { id: number; warm: true }>) => {
  const { id } = e.data;
  try {
    const run = await ready();
    if ("warm" in e.data) return ctx.postMessage({ id, ok: true });
    const out = await run(e.data.texts, { pooling: "mean", normalize: true });
    const dim = out.dims[out.dims.length - 1]!;
    ctx.postMessage({ id, ok: true, dim, data: out.data }, [out.data.buffer]);
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String((err as Error)?.message || err) });
  }
};
