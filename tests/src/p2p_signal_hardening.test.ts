import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const serverPath = resolve(__dirname, "..", "..", "p2p-signal/server.js");

describe("P2P signal hardening", () => {
  it("limits signal payloads to WebRTC negotiation types", () => {
    const server = readFileSync(serverPath, "utf8");

    expect(server).toContain("validateSignalPayload");
    expect(server).toContain("unsupported-signal-payload");
    expect(server).toContain("offer");
    expect(server).toContain("answer");
    expect(server).toContain("ice");
    expect(server).toContain("hasOnlyKeys");
    expect(server).not.toContain("fileBytes");
  });

  it("uses room TTL and rate limiting", () => {
    const server = readFileSync(serverPath, "utf8");

    expect(server).toContain("ROOM_TTL_MS");
    expect(server).toContain("RATE_LIMIT_WINDOW_MS");
    expect(server).toContain("RATE_LIMIT_MAX_MESSAGES");
    expect(server).toContain("rate-limited");
  });

  it("requires three random letters in addition to the six digit room code", () => {
    const server = readFileSync(serverPath, "utf8");

    expect(server).toContain("\\d{3}-\\d{3}-[A-Z]{3}");
    expect(server).not.toContain("^\\d{3}-\\d{3}$");
  });
});
