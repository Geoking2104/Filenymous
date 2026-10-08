// @vitest-environment node
/**
 * Opt-in large-file round-trip test (spec checklist: "Tester le découpage /
 * assemblage de fichiers > 100 Mo").
 *
 * Skipped by default — run explicitly with:
 *   cd ui && FILENYMOUS_BIG_TESTS=1 npx vitest run src/crypto/chunker.big.test.ts
 */

import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { CHUNK_SIZE, decryptChunks, encryptFile } from "./chunker";
import { generateAesKey } from "./aes";

vi.stubGlobal("crypto", webcrypto);

const run = process.env.FILENYMOUS_BIG_TESTS === "1";

describe.skipIf(!run)("chunker large-file round trip", () => {
  it("encrypts and reassembles a >100 MB file, chunk for chunk", async () => {
    const total = 120 * 1024 * 1024; // 120 MB
    const chunkCount = Math.ceil(total / CHUNK_SIZE);

    // Build the test file in CHUNK_SIZE-blocks so memory stays bounded.
    const parts: BlobPart[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const size = Math.min(CHUNK_SIZE, total - i * CHUNK_SIZE);
      parts.push(new Uint8Array(size).fill(i % 251));
    }
    const file = new File(parts, "big.bin", { type: "application/octet-stream" });

    const key = await generateAesKey();
    const chunks: Uint8Array[] = [];
    let seen = 0;
    for await (const c of encryptFile(file, key)) {
      chunks.push(c.data);
      seen++;
    }
    expect(seen).toBe(chunkCount);
    expect(chunks.length).toBe(chunkCount);

    const blob = await decryptChunks(chunks, key);
    expect(blob.size).toBe(total);

    // Spot-check boundaries: first bytes, a middle chunk, last bytes.
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    expect(Array.from(head)).toEqual(Array(8).fill(0));
    const midIndex = Math.floor(chunkCount / 2);
    const midOffset = midIndex * CHUNK_SIZE;
    const mid = new Uint8Array(await blob.slice(midOffset, midOffset + 8).arrayBuffer());
    expect(Array.from(mid)).toEqual(Array(8).fill(midIndex % 251));
    const tail = new Uint8Array(await blob.slice(total - 8).arrayBuffer());
    expect(Array.from(tail)).toEqual(Array(8).fill((chunkCount - 1) % 251));
  }, 300000);
});
