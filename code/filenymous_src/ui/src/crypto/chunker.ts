/**
 * Split a File/Blob into fixed-size plaintext chunks, then encrypt each one.
 * Reassemble encrypted chunks back into a Blob.
 */

import { encryptChunk, decryptChunk, sha256hex } from "./aes";

export const CHUNK_SIZE = 256 * 1024; // 256 KB

export interface EncryptedChunk {
  index: number;
  total: number;
  data: Uint8Array;      // nonce || ciphertext || tag
  checksum: string;      // SHA-256 hex of data
}

/** Callbacks for progress reporting */
export interface ChunkProgress {
  onChunk?: (index: number, total: number) => void;
}

/**
 * Read a File, split into CHUNK_SIZE slices, encrypt each slice.
 * Yields EncryptedChunk objects in order.
 */
export async function* encryptFile(
  file: File,
  key: CryptoKey,
  opts: ChunkProgress = {}
): AsyncGenerator<EncryptedChunk> {
  const total = Math.ceil(file.size / CHUNK_SIZE);
  for (let i = 0; i < total; i++) {
    const slice    = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const buf      = new Uint8Array(await slice.arrayBuffer());
    const data     = await encryptChunk(key, buf);
    const checksum = await sha256hex(data);
    opts.onChunk?.(i, total);
    yield { index: i, total, data, checksum };
  }
}

/**
 * Given an ordered list of encrypted chunks, decrypt and reassemble as a Blob.
 */
export async function decryptChunks(
  chunks: Uint8Array[],
  key: CryptoKey,
  mimeType = "application/octet-stream",
  opts: ChunkProgress = {}
): Promise<Blob> {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const plain = await decryptChunk(key, chunks[i]);
    parts.push(plain);
    opts.onChunk?.(i, chunks.length);
  }
  return new Blob(parts, { type: mimeType });
}

/** Trigger a browser file download from a Blob */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement("a"), {
    href:     url,
    download: filename,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
