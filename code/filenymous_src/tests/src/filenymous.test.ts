/**
 * Filenymous M1 — Tryorama Integration Tests
 *
 * Scenarios:
 *  1. Identity: Claim a contact, resolve it, revoke it
 *  2. Transfer: Create a manifest, retrieve by transfer_id, get sender's list
 *  3. Storage: Store chunks, finalise, retrieve ordered, delete
 *  4. Full E2E (2 agents): Alice sends, Bob receives via contact resolution
 */

import { assert, expect, test, describe, beforeAll, afterAll } from "vitest";
import { Scenario, Player, dhtSync, runScenario } from "@holochain/tryorama";
import { ActionHash, AgentPubKey, AppCallZomeRequest } from "@holochain/client";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HAPP_PATH = path.join(__dirname, "../../workdir/filenymous.happ");

// ─── Helpers ───────────────────────────────────────────────────────────────

function sha256hex(input: string): string {
  // Deterministic fake hash for tests (real app uses SubtleCrypto)
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash).toString(16).padStart(8, "0").repeat(8);
}

function makeTransferId(): string {
  return `test-transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeEncryptedChunk(index: number): Uint8Array {
  // 12-byte nonce + 100 bytes fake ciphertext + 16-byte tag = 128 bytes
  const buf = new Uint8Array(128);
  buf[0] = index;
  buf.fill(0xab, 12, 112);
  return buf;
}

async function zome<T>(
  player: Player,
  zome_name: string,
  fn_name: string,
  payload: unknown = null
): Promise<T> {
  return player.appAgentWs.callZome({
    cap_secret: null,
    role_name: "filenymous",
    zome_name,
    fn_name,
    payload,
  } as AppCallZomeRequest) as Promise<T>;
}

// ─── Test suites ───────────────────────────────────────────────────────────

describe("Identity zome", () => {
  test("claim, resolve and revoke a contact", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const contactHash = sha256hex("alice@example.com");

      // 1. Claim
      const actionHash: ActionHash = await zome(alice, "identity", "claim_contact", {
        contact_hash: contactHash,
      });
      assert.ok(actionHash, "claim_contact should return an ActionHash");

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      // 2. Resolve
      const resolved: AgentPubKey | null = await zome(
        alice,
        "identity",
        "get_agent_for_contact",
        contactHash
      );
      assert.ok(resolved, "should resolve contact to an AgentPubKey");

      // 3. Revoke
      const revokedHash: ActionHash = await zome(
        alice,
        "identity",
        "revoke_contact_claim",
        contactHash
      );
      assert.ok(revokedHash, "revoke should return an ActionHash");
    });
  });
});

describe("Transfer zome", () => {
  test("create a transfer and retrieve it by transfer_id", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const transferId = makeTransferId();
      const recipientHash = sha256hex("bob@example.com");

      const actionHash: ActionHash = await zome(alice, "transfer", "create_transfer", {
        transfer_id: transferId,
        recipient_contact_hash: recipientHash,
        file_name: "document.pdf",
        file_size: 1024 * 1024,
        chunk_count: 4,
        encrypted_key_blob: "base64encryptedkeyblob==",
        expiry_us: 0,
        max_downloads: 1,
      });

      assert.ok(actionHash, "create_transfer should return an ActionHash");

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      const result: { manifest: Record<string, unknown>; action_hash: ActionHash } | null =
        await zome(alice, "transfer", "get_transfer", transferId);

      assert.ok(result, "get_transfer should return a result");
      expect(result!.manifest.transfer_id).toBe(transferId);
      expect(result!.manifest.file_name).toBe("document.pdf");
      expect(result!.manifest.status).toBe("pending");
    });
  });

  test("get_my_sent_transfers returns all outgoing transfers", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const recipientHash = sha256hex("bob@example.com");

      for (let i = 0; i < 3; i++) {
        await zome(alice, "transfer", "create_transfer", {
          transfer_id: makeTransferId(),
          recipient_contact_hash: recipientHash,
          file_name: `file-${i}.txt`,
          file_size: 100,
          chunk_count: 1,
          encrypted_key_blob: "key",
          expiry_us: 0,
          max_downloads: 0,
        });
      }

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      const transfers: unknown[] = await zome(alice, "transfer", "get_my_sent_transfers", null);
      expect(transfers.length).toBeGreaterThanOrEqual(3);
    });
  });

  test("revoke a transfer", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const transferId = makeTransferId();

      await zome(alice, "transfer", "create_transfer", {
        transfer_id: transferId,
        recipient_contact_hash: sha256hex("bob@example.com"),
        file_name: "secret.zip",
        file_size: 500,
        chunk_count: 1,
        encrypted_key_blob: "key",
        expiry_us: 0,
        max_downloads: 1,
      });

      const revokeHash: ActionHash = await zome(
        alice,
        "transfer",
        "revoke_transfer",
        transferId
      );
      assert.ok(revokeHash, "revoke_transfer should return an ActionHash");
    });
  });
});

describe("Storage zome", () => {
  test("store chunks, finalise, retrieve ordered, delete", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const transferId = makeTransferId();
      const totalChunks = 3;
      const actionHashes: ActionHash[] = [];

      // Store chunks in reverse order to test ordering
      for (let i = totalChunks - 1; i >= 0; i--) {
        const h: ActionHash = await zome(alice, "storage", "store_chunk", {
          transfer_id: transferId,
          chunk_index: i,
          total_chunks: totalChunks,
          encrypted_data: Array.from(makeEncryptedChunk(i)),
          checksum: sha256hex(`chunk-${i}`),
        });
        actionHashes.unshift(h); // keep in order 0..N
      }

      // Finalise
      const manifestHash: ActionHash = await zome(alice, "storage", "finalize_storage", {
        transfer_id: transferId,
        total_chunks: totalChunks,
        chunk_action_hashes: actionHashes,
        file_size_bytes: 128 * totalChunks,
      });
      assert.ok(manifestHash, "finalize_storage should return an ActionHash");

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      // Get chunk manifest
      const manifest: { transfer_id: string; total_chunks: number } | null = await zome(
        alice,
        "storage",
        "get_chunk_manifest",
        transferId
      );
      assert.ok(manifest, "get_chunk_manifest should return a result");
      expect(manifest!.total_chunks).toBe(totalChunks);

      // Get chunks ordered
      const output: { chunks: Array<{ chunk: { chunk_index: number } }> } = await zome(
        alice,
        "storage",
        "get_chunks",
        transferId
      );
      expect(output.chunks.length).toBe(totalChunks);
      expect(output.chunks[0].chunk.chunk_index).toBe(0);
      expect(output.chunks[1].chunk.chunk_index).toBe(1);
      expect(output.chunks[2].chunk.chunk_index).toBe(2);

      // Delete chunks
      const deleted: ActionHash[] = await zome(
        alice,
        "storage",
        "delete_chunks",
        transferId
      );
      // 3 chunks + 1 manifest = 4 deletions
      expect(deleted.length).toBe(totalChunks + 1);
    });
  });
});

describe("End-to-end: Alice sends a file to Bob", () => {
  test("full P2P transfer flow between two agents", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      const bob = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();
      await bob.conductor.startUp();

      await scenario.shareAllAgents();

      const transferId = makeTransferId();
      const bobContactHash = sha256hex("bob@example.com");
      const totalChunks = 2;

      // Step 1: Bob claims his contact hash
      const bobClaimHash: ActionHash = await zome(bob, "identity", "claim_contact", {
        contact_hash: bobContactHash,
      });
      assert.ok(bobClaimHash);

      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

      // Step 2: Alice resolves Bob's contact to his AgentPubKey
      const bobPubKey: AgentPubKey | null = await zome(
        alice,
        "identity",
        "get_agent_for_contact",
        bobContactHash
      );
      assert.ok(bobPubKey, "Alice should resolve Bob's contact to his pubkey");

      // Step 3: Alice creates the transfer manifest
      await zome(alice, "transfer", "create_transfer", {
        transfer_id: transferId,
        recipient_contact_hash: bobContactHash,
        file_name: "hello.txt",
        file_size: 256,
        chunk_count: totalChunks,
        // In production: AES key encrypted with bobPubKey via ECIES
        encrypted_key_blob: `ecies_encrypted_for_${Buffer.from(bobPubKey).toString("hex").slice(0, 8)}`,
        expiry_us: 0,
        max_downloads: 1,
      });

      // Step 4: Alice stores the encrypted chunks
      const hashes: ActionHash[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const h: ActionHash = await zome(alice, "storage", "store_chunk", {
          transfer_id: transferId,
          chunk_index: i,
          total_chunks: totalChunks,
          encrypted_data: Array.from(makeEncryptedChunk(i)),
          checksum: sha256hex(`chunk-${i}`),
        });
        hashes.push(h);
      }

      // Step 5: Alice finalises storage
      await zome(alice, "storage", "finalize_storage", {
        transfer_id: transferId,
        total_chunks: totalChunks,
        chunk_action_hashes: hashes,
        file_size_bytes: 256,
      });

      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

      // Step 6: Bob retrieves the transfer manifest
      const transferResult: { manifest: Record<string, unknown> } | null = await zome(
        bob,
        "transfer",
        "get_transfer",
        transferId
      );
      assert.ok(transferResult, "Bob should find the transfer manifest");
      expect(transferResult!.manifest.file_name).toBe("hello.txt");
      expect(transferResult!.manifest.status).toBe("pending");

      // Step 7: Bob retrieves the chunks
      const chunksOutput: { chunks: unknown[] } = await zome(
        bob,
        "storage",
        "get_chunks",
        transferId
      );
      expect(chunksOutput.chunks.length).toBe(totalChunks);

      // Step 8: Bob records the download
      const downloadHash: ActionHash = await zome(bob, "transfer", "record_download", {
        transfer_id: transferId,
        download_count: 1,
      });
      assert.ok(downloadHash, "record_download should succeed");

      // Step 9: Bob verifies his incoming transfers by contact hash
      const incoming: unknown[] = await zome(
        bob,
        "transfer",
        "get_transfers_for_contact",
        bobContactHash
      );
      expect(incoming.length).toBeGreaterThanOrEqual(1);
    });
  });
});
