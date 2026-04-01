import type { ActionHash } from "@holochain/client";
import { callZome } from "./client";
import type {
  StoreChunkInput,
  FinalizeStorageInput,
  ChunkManifest,
  GetChunksOutput,
} from "./types";

export const storageZome = {
  storeChunk(input: StoreChunkInput): Promise<ActionHash> {
    return callZome("storage", "store_chunk", input);
  },

  finalizeStorage(input: FinalizeStorageInput): Promise<ActionHash> {
    return callZome("storage", "finalize_storage", input);
  },

  getChunkManifest(transfer_id: string): Promise<ChunkManifest | null> {
    return callZome("storage", "get_chunk_manifest", transfer_id);
  },

  getChunks(transfer_id: string): Promise<GetChunksOutput> {
    return callZome("storage", "get_chunks", transfer_id);
  },

  deleteChunks(transfer_id: string): Promise<ActionHash[]> {
    return callZome("storage", "delete_chunks", transfer_id);
  },
};
