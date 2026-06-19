/**
 * Wrapper pour le zome file_storage (holochain-open-dev/file-storage).
 *
 * Le zome stocke les chunks chiffrés sur la DHT publique.
 * Les chunks sont accessibles via Holo Web Bridge (HTTP GET) sans conducteur.
 *
 * Flow d'upload :
 *   1. Chiffrer le fichier chunk par chunk (AES-256-GCM) côté navigateur
 *   2. fileStorageZome.createFile({ name, chunks }) → EntryHash (file_hash)
 *   3. Stocker le file_hash dans le ParcelManifest
 *
 * Flow de download (mode WebSocket) :
 *   fileStorageZome.getFile(file_hash) → { name, chunks: Uint8Array[] }
 *
 * Flow de download (mode Web Bridge, sans conducteur) :
 *   webBridgeGetFile(file_hash_b64) → { name, chunks: Uint8Array[] }
 */

import type { EntryHash } from "@holochain/client";
import { callZome, webBridgeGet } from "./client";
import type { FileMetadata, CreateFileInput } from "./types";

export const fileStorageZome = {
  /**
   * Crée une entrée fichier sur le DHT.
   * @param name   Nom du fichier (metadata, affiché au destinataire)
   * @param chunks Chunks chiffrés (AES-256-GCM) sous forme de Uint8Array[]
   * @returns EntryHash du FileMetadata (sert de file_hash dans ParcelManifest)
   */
  async createFile(name: string, chunks: Uint8Array[]): Promise<EntryHash> {
    const input: CreateFileInput = {
      name,
      chunks: chunks.map((c) => Array.from(c)),
    };
    return callZome<EntryHash>("file_storage", "create_file", input);
  },

  /**
   * Récupère les métadonnées d'un fichier.
   */
  async getFileMetadata(fileHash: EntryHash): Promise<FileMetadata | null> {
    return callZome<FileMetadata | null>("file_storage", "get_file_metadata", fileHash);
  },

  /**
   * Récupère un fichier complet (métadonnées + chunks) via WebSocket.
   * @returns Chunks chiffrés dans l'ordre, ou null si introuvable.
   */
  async getFile(fileHash: EntryHash): Promise<{ name: string; chunks: Uint8Array[] } | null> {
    const result = await callZome<{ name: string; chunks: number[][] } | null>(
      "file_storage",
      "get_file",
      fileHash,
    );
    if (!result) return null;
    return {
      name:   result.name,
      chunks: result.chunks.map((c) => new Uint8Array(c)),
    };
  },
};

/**
 * Télécharge un fichier via Holo Web Bridge (mode sans conducteur).
 * Utilisé quand le destinataire n'a pas Holochain installé.
 *
 * @param fileHashB64 EntryHash du fichier, encodé en base64url
 */
export async function webBridgeGetFile(
  fileHashB64: string,
): Promise<{ name: string; chunks: Uint8Array[] } | null> {
  try {
    const result = await webBridgeGet<{ name: string; chunks: number[][] }>(
      `zome/file_storage/get_file/${fileHashB64}`,
    );
    return {
      name:   result.name,
      chunks: result.chunks.map((c) => new Uint8Array(c)),
    };
  } catch {
    return null;
  }
}
