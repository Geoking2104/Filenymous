import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const demoPath = resolve(__dirname, "..", "..", "docs/demo/index.html");

describe("static room demo", () => {
  it("presents Magic Link-first standalone transfer copy", () => {
    const html = readFileSync(demoPath, "utf8");

    expect(html).toContain("Create Magic Link");
    expect(html).toContain("Add files or folder");
    expect(html).toContain('id="tab-rooms"');
    expect(html).toContain('id="panel-rooms"');
    expect(html).toContain("Standalone mode is available without a conductor");
    expect(html).toContain("Holo Web Conductor");
  });

  it("does not claim full Holochain capability in standalone mode", () => {
    const html = readFileSync(demoPath, "utf8");

    expect(html).toContain("Full Holochain features require Holo Web Conductor");
    expect(html).toContain("No Holochain conductor is required to send or receive");
  });

  it("adds a public Mode ROOM surface without requiring a native conductor", () => {
    const html = readFileSync(demoPath, "utf8");

    expect(html).toContain("Create a private room for a group");
    expect(html).toContain("One temporary room, one invite link, many files");
    expect(html).toContain("createPublicRoom");
    expect(html).toContain("copyPublicRoomLink");
    expect(html).toContain("addPublicRoomFiles");
    expect(html).toContain("sendPublicRoomMessage");
    expect(html).toContain('id="public-room-file-input"');
    expect(html).toContain('aria-label="Room invite link"');
  });
});
