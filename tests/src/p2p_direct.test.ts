import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..", "..");

describe("P2P direct web mode", () => {
  const html = readFileSync(resolve(root, "docs/demo/index.html"), "utf8");

  it("exposes direct WebRTC transfer controls for files above the inline limit", () => {
    expect(html).toContain("P2P direct");
    expect(html).toContain("Code telephonique");
    expect(html).toContain("p2pSignalUrl");
    expect(html).toContain("createPhoneCode");
    expect(html).toContain("startP2PSend");
    expect(html).toContain("joinP2PReceive");
    expect(html).toContain("RTCPeerConnection");
    expect(html).toContain("RTCDataChannel");
  });

  it("routes oversized anonymous web files to the direct P2P flow instead of blocking send", () => {
    expect(html).toContain("S.file.size > CFG.webInlineMaxBytes");
    expect(html).toContain("return startP2PSend()");
    expect(html).not.toContain("Mode Web anonyme limite a");
  });
});
