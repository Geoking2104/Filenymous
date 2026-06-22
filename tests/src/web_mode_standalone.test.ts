import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "../../docs/demo/index.html"), "utf8");

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
});
