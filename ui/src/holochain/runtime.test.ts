import { describe, expect, it } from "vitest";
import { modeCapabilities } from "./runtime";
import { createHoloWebRuntime, createRuntimeDetector } from "./client";

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

describe("createRuntimeDetector", () => {
  it("selects HWC before local websocket", async () => {
    const detector = createRuntimeDetector({
      createHoloWebClient: async () => ({ mode: "holo-web" as const }),
      createWebsocketClient: async () => ({ mode: "websocket" as const }),
      createWebBridgeClient: async () => ({ mode: "web-bridge" as const }),
      createLocalOnlyClient: () => ({ mode: "local-only" as const }),
    });

    const client = await detector();

    expect(client.mode).toBe("holo-web");
  });

  it("falls back to websocket when HWC fails", async () => {
    const detector = createRuntimeDetector({
      createHoloWebClient: async () => {
        throw new Error("missing HWC");
      },
      createWebsocketClient: async () => ({ mode: "websocket" as const }),
      createWebBridgeClient: async () => ({ mode: "web-bridge" as const }),
      createLocalOnlyClient: () => ({ mode: "local-only" as const }),
    });

    const client = await detector();

    expect(client.mode).toBe("websocket");
  });

  it("falls back to local-only when all network runtimes fail", async () => {
    const detector = createRuntimeDetector({
      createHoloWebClient: async () => {
        throw new Error("missing HWC");
      },
      createWebsocketClient: async () => {
        throw new Error("missing websocket");
      },
      createWebBridgeClient: async () => {
        throw new Error("missing bridge");
      },
      createLocalOnlyClient: () => ({ mode: "local-only" as const }),
    });

    const client = await detector();

    expect(client.mode).toBe("local-only");
  });
});

describe("createHoloWebRuntime", () => {
  it("wraps a HWC-compatible client as holo-web runtime", async () => {
    const calls: unknown[] = [];
    const runtime = await createHoloWebRuntime(async () => ({
      myPubKey: new Uint8Array([1, 2, 3]),
      callZome: async (request: unknown) => {
        calls.push(request);
        return "ok";
      },
      on: () => undefined,
    }));

    const result = await runtime.callZome("identity", "claim_contact", { contact_hash: "abc" });

    expect(runtime.mode).toBe("holo-web");
    expect(runtime.canWrite).toBe(true);
    expect(result).toBe("ok");
    expect(calls).toHaveLength(1);
  });
});
