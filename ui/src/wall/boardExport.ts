/** Whiteboard export for the host (lazy: loads Excalidraw only when used). Local download only. */
import type { BoardElement } from "./collab";

export async function boardToExcalidrawFile(els: BoardElement[]): Promise<Blob> {
  setLocalExcalidrawAssets();
  const { serializeAsJSON } = await import("@excalidraw/excalidraw");
  const live = els.filter((e) => !e.isDeleted);
  return new Blob([serializeAsJSON(live as never, { viewBackgroundColor: "#ffffff" }, {}, "local")], { type: "application/json" });
}

export async function boardToPng(els: BoardElement[]): Promise<Blob> {
  setLocalExcalidrawAssets();
  const { exportToBlob } = await import("@excalidraw/excalidraw");
  const live = els.filter((e) => !e.isDeleted);
  return exportToBlob({ elements: live as never, files: null, mimeType: "image/png", appState: { exportBackground: true, viewBackgroundColor: "#ffffff" } });
}

/** Points Excalidraw at the fonts served by this site (never a CDN). Call before loading it. */
export function setLocalExcalidrawAssets(): void {
  (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL("excalidraw-assets/", document.baseURI).href;
}
