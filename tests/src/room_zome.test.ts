import { assert, describe, expect, test } from "vitest";
import { ActionHash, AppCallZomeRequest } from "@holochain/client";
import { dhtSync, Player, runScenario, Scenario } from "@holochain/tryorama";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HAPP_PATH = path.join(__dirname, "../../workdir/filenymous.happ");

async function zome<T>(player: Player, zomeName: string, fnName: string, payload: unknown = null): Promise<T> {
  return player.appAgentWs.callZome({
    cap_secret: null,
    role_name: "filenymous",
    zome_name: zomeName,
    fn_name: fnName,
    payload,
  } as AppCallZomeRequest) as Promise<T>;
}

describe("room zome", () => {
  test("creates a room and publishes presence", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const room = await zome<{ room_id: string }>(alice, "room", "create_room", {
        room_id: "room-alpha",
        expires_at: 9_999_999_999_999,
        access_policy: "invitation_only",
        room_label_ciphertext: "",
      });
      expect(room.room_id).toBe("room-alpha");

      const presenceAh: ActionHash = await zome(alice, "room", "publish_presence", {
        room_id: "room-alpha",
        status: "online",
        avatar_seed_commitment: "avatar-a",
        expires_at: 9_999_999_999_999,
      });
      assert.ok(presenceAh);

      await dhtSync([alice], alice.cells[0].cell_id[0]);
      const snapshot = await zome<{ presences: unknown[] }>(alice, "room", "get_room_snapshot", "room-alpha");
      expect(snapshot.presences.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("stores encrypted room messages and transfer requests", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      const bob = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();
      await bob.conductor.startUp();
      await scenario.shareAllAgents();

      await zome(alice, "room", "create_room", {
        room_id: "room-beta",
        expires_at: 9_999_999_999_999,
        access_policy: "invitation_only",
        room_label_ciphertext: "",
      });
      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

      const messageAh: ActionHash = await zome(alice, "room", "send_room_message", {
        room_id: "room-beta",
        ciphertext: "ciphertext-b64",
        nonce: "nonce-b64",
        key_id: "room-key-1",
        previous_message_hash: null,
      });
      assert.ok(messageAh);

      const bobKey = await bob.appAgentWs.myPubKey();
      const request = await zome<{ request: { transfer_id: string }; status: string }>(
        alice,
        "room",
        "create_transfer_request",
        {
          transfer_id: "transfer-1",
          room_id: "room-beta",
          receiver: bobKey,
          file_name_ciphertext: "encrypted-name",
          file_size: 42,
          file_type_ciphertext: "",
          manifest_hash: "a".repeat(64),
          integrity_hash: "b".repeat(64),
          expires_at: 9_999_999_999_999,
        },
      );
      expect(request.request.transfer_id).toBe("transfer-1");

      await zome(bob, "room", "update_transfer_request_status", {
        transfer_id: "transfer-1",
        room_id: "room-beta",
        status: "accepted",
      });

      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
      const snapshot = await zome<{ messages: unknown[]; transfer_requests: Array<{ status: string }> }>(
        bob,
        "room",
        "get_room_snapshot",
        "room-beta",
      );
      expect(snapshot.messages.length).toBeGreaterThanOrEqual(1);
      expect(snapshot.transfer_requests[0].status).toBe("accepted");
    });
  });

  test("rejects transfer status updates from non participants", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      const bob = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      const mallory = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();
      await bob.conductor.startUp();
      await mallory.conductor.startUp();
      await scenario.shareAllAgents();

      await zome(alice, "room", "create_room", {
        room_id: "room-gamma",
        expires_at: 9_999_999_999_999,
        access_policy: "invitation_only",
        room_label_ciphertext: "",
      });
      const bobKey = await bob.appAgentWs.myPubKey();
      await zome(alice, "room", "create_transfer_request", {
        transfer_id: "transfer-2",
        room_id: "room-gamma",
        receiver: bobKey,
        file_name_ciphertext: "encrypted-name",
        file_size: 42,
        file_type_ciphertext: "",
        manifest_hash: "c".repeat(64),
        integrity_hash: "d".repeat(64),
        expires_at: 9_999_999_999_999,
      });
      await dhtSync([alice, bob, mallory], alice.cells[0].cell_id[0]);

      await expect(
        zome(mallory, "room", "update_transfer_request_status", {
          transfer_id: "transfer-2",
          room_id: "room-gamma",
          status: "accepted",
        }),
      ).rejects.toThrow();
    });
  });
});
