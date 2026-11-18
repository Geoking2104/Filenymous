import { describe, expect, it } from "vitest";
import { handOff, isPdfFile, peekHandoff, takeHandoff } from "./handoff";

describe("document ↔ safe hand-off", () => {
  it("delivers a file once to its target only", () => {
    const f = new File(["%PDF-1.7"], "a.pdf", { type: "application/pdf" });
    handOff("safe", f);
    expect(takeHandoff("document")).toBeNull();
    expect(peekHandoff("safe")).toBe(f);
    expect(takeHandoff("safe")).toBe(f);
    expect(takeHandoff("safe")).toBeNull();
  });
  it("recognises PDFs by type or extension", () => {
    expect(isPdfFile({ name: "x.PDF" })).toBe(true);
    expect(isPdfFile({ name: "x", type: "application/pdf" })).toBe(true);
    expect(isPdfFile({ name: "x.png", type: "image/png" })).toBe(false);
  });
});
