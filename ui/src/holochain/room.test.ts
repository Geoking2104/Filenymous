import { afterEach, describe, expect, it } from "vitest";
import { resetClientForTests, setClientForTests } from "./client";
import { roomZome } from "./room";

describe("room zome wrapper", () => {
  afterEach(() => resetClientForTests());

  it("calls room zome functions through the active runtime", async () => {
    const calls: Array<{ zomeName: string; fnName: string; payload: unknown }> = [];
    setClientForTests({
      mode: "holo-web",
      canWrite: true,
      canReadDht: true,
      callZome: async <T,>(zomeName: string, fnName: string, payload: unknown) => {
        calls.push({ zomeName, fnName, payload });
        return { ok: true } as T;
      },
      webBridgeGet: async <T,>() => null as T,
      getMyPubKey: async () => new Uint8Array([1]),
      onSignal: () => undefined,
    });

    await roomZome.createRoom({
      room_id: "room-alpha",
      expires_at: 9_999_999_999,
      access_policy: "invitation_only",
      room_label_ciphertext: "",
    });

    expect(calls[0]).toEqual({
      zomeName: "room",
      fnName: "create_room",
      payload: {
        room_id: "room-alpha",
        expires_at: 9_999_999_999,
        access_policy: "invitation_only",
        room_label_ciphertext: "",
      },
    });
  });

  it("wraps snapshot and status calls", async () => {
    const calls: Array<{ zomeName: string; fnName: string; payload: unknown }> = [];
    setClientForTests({
      mode: "websocket",
      canWrite: true,
      canReadDht: true,
      callZome: async <T,>(zomeName: string, fnName: string, payload: unknown) => {
        calls.push({ zomeName, fnName, payload });
        return [] as T;
      },
      webBridgeGet: async <T,>() => null as T,
      getMyPubKey: async () => new Uint8Array([1]),
      onSignal: () => undefined,
    });

    await roomZome.getRoomSnapshot("room-alpha");
    await roomZome.updateTransferRequestStatus({
      transfer_id: "transfer-a",
      room_id: "room-alpha",
      status: "accepted",
    });

    expect(calls).toEqual([
      { zomeName: "room", fnName: "get_room_snapshot", payload: "room-alpha" },
      {
        zomeName: "room",
        fnName: "update_transfer_request_status",
        payload: { transfer_id: "transfer-a", room_id: "room-alpha", status: "accepted" },
      },
    ]);
  });
});
