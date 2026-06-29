import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "../../docs/demo/index.html"), "utf8");
const packagedHtml = readFileSync(path.join(__dirname, "../../filenymous-app.html"), "utf8");

function stripScriptsAndStyles(source: string): string {
  return source
    .replace(/<script(?:[^>]*)>[\s\S]*?<\/script>/g, "")
    .replace(/<style(?:[^>]*)>[\s\S]*?<\/style>/g, "");
}

function panel(source: string, id: string): string {
  const start = source.indexOf(`<section id="${id}"`);
  if (start < 0) return "";
  const next = source.indexOf("<section id=", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const visibleHtml = stripScriptsAndStyles(html);
const visiblePackagedHtml = stripScriptsAndStyles(packagedHtml);
const primaryHome = stripScriptsAndStyles(panel(html, "panel-room"));

describe("Magic UX public transfer workspace", () => {
  it("makes Magic Link the primary public transfer action", () => {
    for (const phrase of [
      "Create Magic Link",
      "Add files or folder",
      "Share by link, code, or QR",
      "Keep this page open during direct transfer",
    ]) {
      expect(primaryHome).toContain(phrase);
    }
  });

  it("keeps technical network jargon out of the primary home workspace", () => {
    for (const phrase of ["Iroh", "Holochain", "Holo Web Conductor", "WebRTC", "conductor"]) {
      expect(primaryHome).not.toContain(phrase);
    }
  });

  it("ships folder and multi-file controls with accessible fallbacks", () => {
    expect(html).toContain('id="home-folder-input"');
    expect(html).toContain("webkitdirectory");
    expect(html).toContain('id="home-file-input"');
    expect(html).toContain("multiple");
    expect(visibleHtml).toContain("Folder support depends on your browser");
    expect(packagedHtml).toContain('id="home-folder-input"');
    expect(packagedHtml).toContain("webkitdirectory");
    expect(packagedHtml).toContain('id="home-file-input"');
    expect(packagedHtml).toContain("multiple");
    expect(visiblePackagedHtml).toContain("Folder support depends on your browser");
  });

  it("defines a shared transfer state model and share artifact renderer", () => {
    for (const token of [
      "TRANSFER_STATES",
      "setTransferState",
      "createShareArtifact",
      "renderShareArtifact",
      "prepareSelectedPayload",
      "estimateTransferTime",
    ]) {
      expect(html).toContain(token);
      expect(packagedHtml).toContain(token);
    }
  });

  it("shows progress, speed, estimate, and download-location guidance", () => {
    for (const id of [
      'id="magic-progress"',
      'id="magic-progress-fill"',
      'id="magic-progress-label"',
      'id="magic-progress-estimate"',
      'id="magic-download-location"',
    ]) {
      expect(html).toContain(id);
      expect(packagedHtml).toContain(id);
    }
    expect(visibleHtml).toContain("Downloads folder");
  });
});
