// Self-hosts Excalidraw's fonts (otherwise it would fetch them from a CDN).
// Copied at build time from node_modules into public/excalidraw-assets/fonts (git-ignored).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const dst = resolve(here, "../public/excalidraw-assets/fonts");
if (!existsSync(src)) {
  console.error("excalidraw fonts not found:", src);
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
// Xiaolai (CJK handwriting fallback) is ~13 MB of shards: not shipped. CJK text on the
// whiteboard then falls back to a local system font; nothing is fetched from a CDN.
cpSync(src, dst, { recursive: true, filter: (p) => !/[\\/]Xiaolai([\\/]|$)/.test(p) });
console.log("excalidraw fonts ->", dst);
