/**
 * Filenymous v2 — Tests d'intégration Tryorama
 *
 * Zomes testés :
 *   - identity    : claim_contact, get_agent_for_contact, publish_x25519_key, get_x25519_key
 *   - file_storage: create_file, get_file_metadata, get_file
 *   - parcel      : create_parcel, get_parcel, get_my_sent_parcels,
 *                   get_pending_parcels_for_contact, confirm_download, revoke_parcel
 *
 * Zomes NON testés ici (externes OSS) :
 *   - delivery (ddd-mtl/delivery-zome) : testé par son propre test suite upstream
 *
 * Scénarios :
 *   1. Identité : claim / resolve / revoke contact + X25519 key lifecycle
 *   2. File storage : upload chunks, récupération, intégrité
 *   3. Parcel : création, lecture, révocation, download count
 *   4. E2E : Alice envoie un fichier à Bob (mode agent DHT)
 *   5. E2E : Alice envoie via lien one-time (destinataire non enregistré)
 */

import { assert, expect, test, describe } from "vitest";
import { Scenario, Player, dhtSync, runScenario } from "@holochain/tryorama";
import { ActionHash, AgentPubKey, EntryHash, AppCallZomeRequest } from "@holochain/client";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HAPP_PATH = path.join(__dirname, "../../workdir/filenymous.happ");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256hex(input: string): string {
  // Hash déterministe simplifié pour les tests (la vraie app utilise SubtleCrypto)
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(h).toString(16).padStart(8,"0").repeat(8);
}

function fakeChunk(seed: number, size = 300): number[] {
  // Chunk chiffré simulé : 12 octets nonce + data + 16 octets tag
  return Array.from({ length: size }, (_, i) => (seed + i) & 0xff);
}

async function zome<T>(player: Player, zome_name: string, fn_name: string, payload: unknown = null): Promise<T> {
  return player.appAgentWs.callZome({
    cap_secret: null, role_name: "filenymous", zome_name, fn_name, payload,
  } as AppCallZomeRequest) as Promise<T>;
}

// ─── 1. Identité ─────────────────────────────────────────────────────────────

describe("identity zome", () => {
  test("claim, résoudre et révoquer un contact", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const contactHash = sha256hex("alice@example.com");

      const claimAh: ActionHash = await zome(alice, "identity", "claim_contact", { contact_hash: contactHash });
      assert.ok(claimAh, "claim_contact doit retourner un ActionHash");

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      const resolved: AgentPubKey | null = await zome(alice, "identity", "get_agent_for_contact", contactHash);
      assert.ok(resolved, "get_agent_for_contact doit retourner une AgentPubKey");

      const revokedAh: ActionHash = await zome(alice, "identity", "revoke_contact_claim", contactHash);
      assert.ok(revokedAh, "revoke_contact_claim doit retourner un ActionHash");
    });
  });

  test("publier et récupérer une clé X25519", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      // Clé X25519 simulée (32 bytes → base64)
      const fakeKeyBytes = new Uint8Array(32).fill(0xab);
      const keyB64       = Buffer.from(fakeKeyBytes).toString("base64");

      const publishAh: ActionHash = await zome(alice, "identity", "publish_x25519_key", { x25519_pubkey_b64: keyB64 });
      assert.ok(publishAh);

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      const agent: AgentPubKey = await alice.appAgentWs.myPubKey();
      const retrieved: string | null = await zome(alice, "identity", "get_x25519_key", agent);
      assert.ok(retrieved, "Clé X25519 doit être récupérable");
      expect(retrieved).toBe(keyB64);
    });
  });
});

// ─── 2. File storage ─────────────────────────────────────────────────────────

describe("file_storage zome", () => {
  test("créer un fichier et récupérer ses métadonnées", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const chunks = [fakeChunk(1), fakeChunk(2), fakeChunk(3)];

      const fileEh: EntryHash = await zome(alice, "file_storage", "create_file", {
        name:   "document.pdf",
        chunks,
      });
      assert.ok(fileEh, "create_file doit retourner un EntryHash");

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      const meta = await zome<{ name: string; size: number; chunk_hashes: EntryHash[] } | null>(
        alice, "file_storage", "get_file_metadata", fileEh,
      );
      assert.ok(meta, "get_file_metadata doit retourner les métadonnées");
      expect(meta!.name).toBe("document.pdf");
      expect(meta!.chunk_hashes.length).toBe(3);
    });
  });

  test("récupérer un fichier complet", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const chunk1 = fakeChunk(10, 256);
      const chunk2 = fakeChunk(20, 128);

      const fileEh: EntryHash = await zome(alice, "file_storage", "create_file", {
        name:   "archive.zip",
        chunks: [chunk1, chunk2],
      });

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      const file = await zome<{ name: string; chunks: number[][] } | null>(
        alice, "file_storage", "get_file", fileEh,
      );
      assert.ok(file, "get_file doit retourner le fichier");
      expect(file!.name).toBe("archive.zip");
      expect(file!.chunks.length).toBe(2);
      expect(file!.chunks[0]).toEqual(chunk1);
      expect(file!.chunks[1]).toEqual(chunk2);
    });
  });
});

// ─── 3. Parcel ────────────────────────────────────────────────────────────────

describe("parcel zome", () => {
  test("créer un parcel et le récupérer par EntryHash", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      // D'abord créer un fichier
      const fileEh: EntryHash = await zome(alice, "file_storage", "create_file", {
        name: "test.txt", chunks: [fakeChunk(1)],
      });

      const parcelOut = await zome<{
        parcel_eh: EntryHash; action_hash: ActionHash;
        manifest: { file_name: string; chunk_count: number };
        download_count: number; is_revoked: boolean;
      }>(alice, "parcel", "create_parcel", {
        file_hash:              fileEh,
        file_name:              "test.txt",
        file_size:              300,
        chunk_count:            1,
        recipient_contact_hash: sha256hex("bob@example.com"),
        encrypted_key_blob:     "ecies_blob_base64==",
        expiry_us:              0,
        max_downloads:          1,
      });

      assert.ok(parcelOut.parcel_eh, "create_parcel doit retourner un parcel_eh");
      expect(parcelOut.manifest.file_name).toBe("test.txt");
      expect(parcelOut.download_count).toBe(0);
      expect(parcelOut.is_revoked).toBe(false);

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      const fetched = await zome<{ manifest: { file_name: string } } | null>(
        alice, "parcel", "get_parcel", parcelOut.parcel_eh,
      );
      assert.ok(fetched);
      expect(fetched!.manifest.file_name).toBe("test.txt");
    });
  });

  test("get_my_sent_parcels retourne les envois de l'agent", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const fileEh: EntryHash = await zome(alice, "file_storage", "create_file", {
        name: "f.txt", chunks: [fakeChunk(1)],
      });

      for (let i = 0; i < 3; i++) {
        await zome(alice, "parcel", "create_parcel", {
          file_hash: fileEh, file_name: `file-${i}.txt`, file_size: 100, chunk_count: 1,
          recipient_contact_hash: sha256hex(`recipient${i}@test.com`),
          encrypted_key_blob: "", expiry_us: 0, max_downloads: 0,
        });
      }

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      const sent: unknown[] = await zome(alice, "parcel", "get_my_sent_parcels", null);
      expect(sent.length).toBeGreaterThanOrEqual(3);
    });
  });

  test("révoquer un parcel", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const fileEh: EntryHash = await zome(alice, "file_storage", "create_file", {
        name: "secret.zip", chunks: [fakeChunk(99)],
      });
      const parcelOut = await zome<{ parcel_eh: EntryHash; action_hash: ActionHash }>(
        alice, "parcel", "create_parcel", {
          file_hash: fileEh, file_name: "secret.zip", file_size: 300, chunk_count: 1,
          recipient_contact_hash: sha256hex("bob@example.com"),
          encrypted_key_blob: "", expiry_us: 0, max_downloads: 1,
        });

      const revokeAh: ActionHash = await zome(alice, "parcel", "revoke_parcel", parcelOut.parcel_eh);
      assert.ok(revokeAh, "revoke_parcel doit retourner un ActionHash");

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      const fetched = await zome<{ is_revoked: boolean } | null>(
        alice, "parcel", "get_parcel", parcelOut.parcel_eh,
      );
      assert.ok(fetched);
      expect(fetched!.is_revoked).toBe(true);
    });
  });

  test("confirm_download incrémente le compteur", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const fileEh: EntryHash = await zome(alice, "file_storage", "create_file", {
        name: "file.pdf", chunks: [fakeChunk(5)],
      });
      const parcelOut = await zome<{ parcel_eh: EntryHash }>(alice, "parcel", "create_parcel", {
        file_hash: fileEh, file_name: "file.pdf", file_size: 300, chunk_count: 1,
        recipient_contact_hash: sha256hex("bob@example.com"),
        encrypted_key_blob: "", expiry_us: 0, max_downloads: 3,
      });

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      await zome(alice, "parcel", "confirm_download", parcelOut.parcel_eh);

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      const fetched = await zome<{ download_count: number }>(
        alice, "parcel", "get_parcel", parcelOut.parcel_eh,
      );
      expect(fetched.download_count).toBe(1);
    });
  });
});

// ─── 4. E2E mode agent ────────────────────────────────────────────────────────

describe("E2E — Alice envoie un fichier à Bob (mode agent DHT)", () => {
  test("flux complet : upload → livraison → téléchargement ECIES", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      const bob   = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();
      await bob.conductor.startUp();
      await scenario.shareAllAgents();

      const bobContact = sha256hex("bob@example.com");
      const fakeEciesBlob = Buffer.from(new Uint8Array(92).fill(0xcc)).toString("base64");

      // 1. Bob publie son ContactClaim
      await zome(bob, "identity", "claim_contact", { contact_hash: bobContact });

      // 2. Bob publie sa clé X25519 (simulée)
      const bobKeyB64 = Buffer.from(new Uint8Array(32).fill(0xbb)).toString("base64");
      await zome(bob, "identity", "publish_x25519_key", { x25519_pubkey_b64: bobKeyB64 });

      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

      // 3. Alice résout Bob sur le DHT
      const bobAgent: AgentPubKey | null = await zome(alice, "identity", "get_agent_for_contact", bobContact);
      assert.ok(bobAgent, "Alice doit trouver l'agent de Bob");

      // 4. Alice récupère la clé X25519 de Bob
      const retrievedKey: string | null = await zome(alice, "identity", "get_x25519_key", bobAgent);
      assert.ok(retrievedKey, "Alice doit trouver la clé X25519 de Bob");
      expect(retrievedKey).toBe(bobKeyB64);

      // 5. Alice crée le fichier sur la DHT
      const fileEh: EntryHash = await zome(alice, "file_storage", "create_file", {
        name: "rapport.pdf", chunks: [fakeChunk(1), fakeChunk(2)],
      });

      // 6. Alice crée le parcel (avec blob ECIES simulé)
      const parcelOut = await zome<{ parcel_eh: EntryHash }>(alice, "parcel", "create_parcel", {
        file_hash:              fileEh,
        file_name:              "rapport.pdf",
        file_size:              600,
        chunk_count:            2,
        recipient_contact_hash: bobContact,
        encrypted_key_blob:     fakeEciesBlob,
        expiry_us:              0,
        max_downloads:          1,
      });
      assert.ok(parcelOut.parcel_eh);

      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

      // 7. Bob récupère ses parcels en attente
      const pending = await zome<{ manifest: { file_name: string } }[]>(
        bob, "parcel", "get_pending_parcels_for_contact", bobContact,
      );
      expect(pending.length).toBeGreaterThanOrEqual(1);
      expect(pending[0].manifest.file_name).toBe("rapport.pdf");

      // 8. Bob récupère le fichier
      const file = await zome<{ name: string; chunks: number[][] } | null>(
        bob, "file_storage", "get_file", fileEh,
      );
      assert.ok(file);
      expect(file!.chunks.length).toBe(2);

      // 9. Bob confirme le téléchargement
      const dlAh: ActionHash = await zome(bob, "parcel", "confirm_download", parcelOut.parcel_eh);
      assert.ok(dlAh);
    });
  });
});

// ─── 5. E2E mode lien one-time ────────────────────────────────────────────────

describe("E2E — Livraison via lien (destinataire non enregistré)", () => {
  test("parcel accessible sans ContactClaim du destinataire", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const anonymousContactHash = sha256hex("anonymous@noreply.example");

      // Alice crée le fichier
      const fileEh: EntryHash = await zome(alice, "file_storage", "create_file", {
        name: "surprise.zip", chunks: [fakeChunk(42)],
      });

      // Alice crée le parcel sans blob ECIES (clé dans le lien)
      const parcelOut = await zome<{ parcel_eh: EntryHash; manifest: Record<string, unknown> }>(
        alice, "parcel", "create_parcel", {
          file_hash:              fileEh,
          file_name:              "surprise.zip",
          file_size:              300,
          chunk_count:            1,
          recipient_contact_hash: anonymousContactHash,
          encrypted_key_blob:     "",  // vide : clé transmise dans le fragment # de l'URL
          expiry_us:              0,
          max_downloads:          0,
        },
      );

      assert.ok(parcelOut.parcel_eh, "Parcel anonyme doit être créé");
      expect(parcelOut.manifest.encrypted_key_blob).toBe("");

      await dhtSync([alice], alice.cells[0].cell_id[0]);

      // Vérifier que le parcel est récupérable par son EntryHash
      // (simule ce que fait le Web Bridge)
      const fetched = await zome<{ manifest: { file_name: string } } | null>(
        alice, "parcel", "get_parcel", parcelOut.parcel_eh,
      );
      assert.ok(fetched);
      expect(fetched!.manifest.file_name).toBe("surprise.zip");
    });
  });
});
