import { describe, expect, it } from "vitest";
import { modeCapabilities } from "./runtime";

describe("modeCapabilities", () => {
  it("allows zome writes only for holo-web and websocket modes", () => {
    expect(modeCapabilities("holo-web").canWrite).toBe(true);
    expect(modeCapabilities("websocket").canWrite).toBe(true);
    expect(modeCapabilities("web-bridge").canWrite).toBe(false);
    expect(modeCapabilities("local-only").canWrite).toBe(false);
  });

  it("allows DHT reads for holo-web, websocket, and web-bridge", () => {
    expect(modeCapabilities("holo-web").canReadDht).toBe(true);
    expect(modeCapabilities("websocket").canReadDht).toBe(true);
    expect(modeCapabilities("web-bridge").canReadDht).toBe(true);
    expect(modeCapabilities("local-only").canReadDht).toBe(false);
  });
});
