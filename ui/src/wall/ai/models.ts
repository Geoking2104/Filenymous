/**
 * On-device models for the wall host tab. Everything is served from this site
 * (/app/models/, uploaded by the ovh-models workflow): no CDN, no Hugging Face
 * Hub request at runtime. Sizes are what the browser downloads once (then
 * cached by the browser).
 */
// The ONNX Runtime wasm is bundled by Vite (hashed under /app/assets/), so it is served from this site too.
import ortWasmUrl from "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";

export const MODEL_BASE = `${import.meta.env.BASE_URL}models/`;

export const EMBED_MODEL = { id: "Xenova/all-MiniLM-L6-v2", dtype: "q8", approxMB: 23 } as const;
export const WHISPER_MODEL = { id: "Xenova/whisper-tiny", dtype: "q8", approxMB: 41 } as const;
/** ONNX Runtime WebAssembly (shared by both models, downloaded once). */
export const ORT_APPROX_MB = 21;

type TF = typeof import("@huggingface/transformers");
let tf: Promise<TF> | null = null;

/** Lazily imports transformers.js and locks it to local files only. */
export function loadTransformers(): Promise<TF> {
  return (tf ??= import("@huggingface/transformers").then((m) => {
    m.env.allowRemoteModels = false;
    m.env.allowLocalModels = true;
    m.env.localModelPath = MODEL_BASE;
    m.env.useBrowserCache = true;
    const wasm = m.env.backends.onnx.wasm;
    if (wasm) {
      // transformers.js defaults this to cdn.jsdelivr.net at import time: override before any session.
      wasm.wasmPaths = { wasm: new URL(ortWasmUrl, location.href).href };
      wasm.proxy = false;
      if (!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) wasm.numThreads = 1;
    }
    return m;
  }));
}
