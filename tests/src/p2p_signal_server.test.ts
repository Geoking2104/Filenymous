import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..", "..");
const serverPath = resolve(root, "p2p-signal/server.js");

describe("P2P signaling server", () => {
  it("provides an in-memory WebSocket relay for phone-code rooms", () => {
    expect(existsSync(serverPath)).toBe(true);
    const server = readFileSync(serverPath, "utf8");

    expect(server).toContain("WebSocketServer");
    expect(server).toContain("rooms = new Map()");
    expect(server).toContain("validatePhoneCode");
    expect(server).toContain("peer-joined");
    expect(server).toContain("signal");
    expect(server).toContain("sender");
    expect(server).toContain("receiver");
  });

  it("does not persist transferred file payloads on disk", () => {
    expect(existsSync(serverPath)).toBe(true);
    const server = readFileSync(serverPath, "utf8");

    expect(server).not.toContain("writeFile");
    expect(server).not.toContain("createWriteStream");
    expect(server).not.toContain("appendFile");
  });
});
