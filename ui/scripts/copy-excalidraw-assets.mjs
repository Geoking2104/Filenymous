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
cpSync(src, dst, { recursive: true });
console.log("excalidraw fonts ->", dst);
