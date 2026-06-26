import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "../../docs/demo/index.html"), "utf8");
const packagedHtml = readFileSync(path.join(__dirname, "../../filenymous-app.html"), "utf8");

describe("standalone web transfer mode", () => {
  it("does not block sends when no Holochain conductor is available", () => {
    expect(html).not.toContain("Mode lecture seule");
    expect(html).not.toContain("envoi non disponible sans conducteur Holochain");
    expect(html).not.toContain("Mode bridge (lecture seule HTTP) : envoi impossible");
  });

  it("ships a browser-only encrypted transfer fallback", () => {
    expect(html).toContain("createWebParcelLink");
    expect(html).toContain("parseWebParcelLink");
    expect(html).toContain("web-inline");
  });

  it("keeps the packaged release HTML send flow writable without a local conductor", () => {
    expect(packagedHtml).not.toContain("Mode bridge (lecture seule HTTP) : envoi impossible");
    expect(packagedHtml).not.toContain("Holo Web Conductor non connecté");
    expect(packagedHtml).toContain("createWebParcelLink");
    expect(packagedHtml).toContain("S.mode === 'bridge'");
    expect(packagedHtml).toContain("link-result");
  });
});
