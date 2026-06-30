import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const demoPath = resolve(__dirname, "..", "..", "docs/demo/index.html");

describe("static room demo", () => {
  it("presents Magic Link-first standalone transfer copy", () => {
    const html = readFileSync(demoPath, "utf8");

    expect(html).toContain("Create Magic Link");
    expect(html).toContain("Add files or folder");
    expect(html).toContain("Standalone mode is available without a conductor");
    expect(html).toContain("Holo Web Conductor");
  });

  it("does not claim full Holochain capability in standalone mode", () => {
    const html = readFileSync(demoPath, "utf8");

    expect(html).toContain("Full Holochain features require Holo Web Conductor");
    expect(html).toContain("No Holochain conductor is required to send or receive");
  });
});
