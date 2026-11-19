import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../public");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.webmanifest"), "utf8")) as {
  name: string;
  start_url: string;
  display: string;
  icons: Array<{ src: string }>;
  shortcuts: Array<{ name: string; url: string; icons?: Array<{ src: string; sizes: string }> }>;
  file_handlers: Array<{ action: string; accept: Record<string, string[]> }>;
};

describe("PWA manifest", () => {
  it("is valid JSON with the required install fields and existing icons", () => {
    expect(manifest.name).toBe("Filenymous");
    expect(manifest.start_url).toBe("./");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) expect(existsSync(join(dir, icon.src)), icon.src).toBe(true);
  });

  it("exposes Document shortcuts to a blank editor and to the open-file screen", () => {
    const byUrl = Object.fromEntries(manifest.shortcuts.map((s) => [s.url, s]));
    expect(byUrl["./#document-new"]?.name).toBe("Nouveau document");
    expect(byUrl["./#document"]?.name).toBe("Ouvrir un fichier");
    for (const s of manifest.shortcuts) {
      for (const icon of s.icons ?? []) expect(existsSync(join(dir, icon.src)), icon.src).toBe(true);
    }
  });

  it("declares optional Chromium file handlers for PDF, Markdown and text", () => {
    const h = manifest.file_handlers[0];
    expect(h.action).toBe("./#document");
    expect(h.accept["application/pdf"]).toContain(".pdf");
    expect(h.accept["text/markdown"]).toContain(".md");
    expect(h.accept["text/plain"]).toContain(".txt");
  });
});
