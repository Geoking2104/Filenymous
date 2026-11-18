/**
 * Rendering side of the Document tab (pdf.js, Apache-2.0), loaded lazily with
 * the panel. Parsing runs in a dedicated module worker bundled by Vite as a
 * plain .js asset (no .mjs MIME type needed on the host). The legacy build
 * keeps older Safari / Firefox ESR working.
 *
 * Hardening: no eval, no XFA, no scripting (we never load pdf.js' viewer or
 * its sandbox), and the bytes are copied because pdf.js transfers them.
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import PdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker";

export type { PDFDocumentProxy };

let worker: Worker | null = null;
function ensureWorker() {
  if (worker) return;
  worker = new PdfWorker();
  pdfjs.GlobalWorkerOptions.workerPort = worker;
}

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  ensureWorker();
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    // Fonts the file does not embed fall back to system fonts (no network fetch).
    useSystemFonts: true,
  });
  return task.promise;
}

export interface RenderOpts {
  /** CSS pixels per PDF point (ignored when `fitWidth` is set). */
  scale: number;
  /** Fit the rotated page into this many CSS pixels of width. */
  fitWidth?: number;
  /** Extra clockwise rotation on top of the page's own /Rotate. */
  rotate?: number;
}

/**
 * Render page `index` (zero-based) into `canvas`. Returns the render task so
 * callers can cancel it, and the CSS size of the drawn page.
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  index: number,
  canvas: HTMLCanvasElement,
  opts: RenderOpts,
): Promise<{ task: RenderTask; width: number; height: number; scale: number }> {
  const page = await doc.getPage(index + 1);
  const rotation = (((page.rotate + (opts.rotate ?? 0)) % 360) + 360) % 360;
  const scale = opts.fitWidth ? opts.fitWidth / page.getViewport({ scale: 1, rotation }).width : opts.scale;
  const viewport = page.getViewport({ scale, rotation });
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const task = page.render({
    canvasContext: ctx,
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    // Draw form widgets and annotations from their appearance streams.
    annotationMode: pdfjs.AnnotationMode.ENABLE,
  });
  return { task, width: viewport.width, height: viewport.height, scale };
}

/** Unrotated page size in points and its own rotation. */
export async function pageGeometry(doc: PDFDocumentProxy, index: number) {
  const page = await doc.getPage(index + 1);
  const [x0, y0, x1, y1] = page.view;
  return { width: x1 - x0, height: y1 - y0, rotation: page.rotate };
}

export function isPasswordError(e: unknown): boolean {
  return (e as { name?: string })?.name === "PasswordException";
}
