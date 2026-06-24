import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const demoPath = resolve(__dirname, "..", "..", "docs/demo/index.html");

describe("static room demo", () => {
  it("presents room-first standalone transfer copy", () => {
    const html = readFileSync(demoPath, "utf8");

    expect(html).toContain("Salon de transfert");
    expect(html).toContain("Pairs presents");
    expect(html).toContain("mode autonome");
    expect(html).toContain("Holo Web Conductor");
  });

  it("does not claim full Holochain capability in standalone mode", () => {
    const html = readFileSync(demoPath, "utf8");

    expect(html).toContain("fonctions Holochain completes");
    expect(html).toContain("necessitent Holo Web Conductor");
  });
});
