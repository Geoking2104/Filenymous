/**
 * Thin wrappers around the two MIT-licensed WASM packages we depend on for
 * the optical transfer feature. Both are lazy-initialized so their WASM
 * payloads are only fetched once the user actually opens the optical
 * transfer panel — the main app bundle stays untouched.
 */
import { activeProfile, RENDER_SCALE } from "./turbo60";

// ── Rendering (sender side) ────────────────────────────────────────────

const ECC_NUMBER = { L: 0, M: 1, Q: 2, H: 3 } as const;

let rendererInitPromise: Promise<unknown> | undefined;
let renderer: { render_rgba: (bytes: Uint8Array, version: number, ecc: number, scale: number) => number; rgba_ptr: () => number } | undefined;
let rendererMemory: WebAssembly.Memory | undefined;

async function ensureRenderer() {
  if (!rendererInitPromise) {
    rendererInitPromise = import("@raptorqr/fast-qr-wasm").then(async (mod) => {
      const wasm = await mod.default();
      renderer = new mod.QrRenderer();
      rendererMemory = wasm.memory;
    });
  }
  await rendererInitPromise;
}

/** Render one frame's raw bytes to an ImageData ready to draw on a <canvas>. */
export async function renderOpticalFrame(bytes: Uint8Array): Promise<ImageData> {
  await ensureRenderer();
  if (!renderer || !rendererMemory) throw new Error("QR renderer failed to initialize.");
  const profile = activeProfile();
  const side = renderer.render_rgba(bytes, profile.qrVersion, ECC_NUMBER[profile.eccLevel], RENDER_SCALE);
  const length = side * side * 4;
  const view = new Uint8ClampedArray(rendererMemory.buffer, renderer.rgba_ptr(), length);
  return new ImageData(view.slice(), side, side);
}

// ── Scanning (receiver side) ───────────────────────────────────────────

let scannerReadyPromise: Promise<unknown> | undefined;
let readBarcodesFn:
  | ((image: ImageData, opts: Record<string, unknown>) => Promise<Array<{ isValid: boolean; symbology: string; bytes: Uint8Array }>>)
  | undefined;

async function ensureScanner() {
  if (!scannerReadyPromise) {
    scannerReadyPromise = import("zxing-wasm/reader").then(async (mod) => {
      await mod.prepareZXingModule({ fireImmediately: true });
      readBarcodesFn = mod.readBarcodes as typeof readBarcodesFn extends undefined ? never : typeof readBarcodesFn;
    });
  }
  await scannerReadyPromise;
}

/**
 * Scan a captured camera frame for up to `maxSymbols` QR codes (Turbo 60
 * shows 2 simultaneously, one per lane, side by side).
 */
export async function scanOpticalFrames(image: ImageData, maxSymbols = 2): Promise<Uint8Array[]> {
  await ensureScanner();
  if (!readBarcodesFn) throw new Error("QR scanner failed to initialize.");
  const results = await readBarcodesFn(image, {
    formats: ["QRCode"],
    tryHarder: true,
    maxNumberOfSymbols: maxSymbols,
    textMode: "Plain",
  });
  return results
    .filter((r) => r.isValid && r.symbology === "QRCode" && r.bytes.length > 0)
    .map((r) => new Uint8Array(r.bytes));
}

export async function preloadOpticalTransferAssets(): Promise<void> {
  await Promise.all([ensureRenderer(), ensureScanner()]);
}
