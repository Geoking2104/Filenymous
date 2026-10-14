// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  P2P_CHUNK_SIZE,
  buildShareLink,
  chunkCount,
  createSecret,
  createShareCode,
  deriveFileKey,
  isP2PHash,
  normalizeShareCode,
  openChunk,
  parseControl,
  parseShareInput,
  safeFileName,
  sealChunk,
  unwrapSecret,
  wrapSecret,
} from "./protocol";

describe("p2p share codes & links", () => {
  it("creates codes accepted by the signaling relay", () => {
    for (let i = 0; i < 50; i++) expect(createShareCode()).toMatch(/^\d{3}-\d{3}-[A-Z]{3}$/);
  });

  it("normalizes typed codes", () => {
    expect(normalizeShareCode(" 123 456 abc ")).toBe("123-456-ABC");
    expect(normalizeShareCode("12-3456-AB")).toBeNull();
  });

  it("round-trips a share link with its secret in the fragment", () => {
    const secret = createSecret();
    const link = buildShareLink("https://filenymous.eu/app/?x=1#old", "123-456-ABC", secret);
    expect(link).toBe(`https://filenymous.eu/app/?x=1#p2p:123-456-ABC/${secret}`);
    expect(parseShareInput(link)).toEqual({ code: "123-456-ABC", secret });
    expect(parseShareInput("#p2p:123-456-ABC")).toEqual({ code: "123-456-ABC" });
    expect(parseShareInput("123456abc")).toEqual({ code: "123-456-ABC" });
    expect(isP2PHash(`#p2p:123-456-ABC/${secret}`)).toBe(true);
    expect(isP2PHash("#sl=abc")).toBe(false);
    expect(parseShareInput("#sl=AAAA")).toBeNull();
  });
});

describe("p2p chunk crypto", () => {
  it("seals and opens chunks; rejects tampering and reordering", async () => {
    const key = await deriveFileKey(createSecret());
    const plain = crypto.getRandomValues(new Uint8Array(1000));
    const frame = await sealChunk(key, 2, 7, plain);
    const opened = await openChunk(key, frame);
    expect(opened.fileIndex).toBe(2);
    expect(opened.chunkIndex).toBe(7);
    expect(Array.from(opened.plain)).toEqual(Array.from(plain));

    const tampered = new Uint8Array(frame.slice(0));
    tampered[20] ^= 1;
    await expect(openChunk(key, tampered.buffer)).rejects.toBeTruthy();

    const moved = new Uint8Array(frame.slice(0));
    new DataView(moved.buffer).setUint32(4, 8); // claim another position
    await expect(openChunk(key, moved.buffer)).rejects.toBeTruthy();

    const otherKey = await deriveFileKey(createSecret());
    await expect(openChunk(otherKey, frame)).rejects.toBeTruthy();
  });

  it("wraps the secret with the code for typed-code receivers", async () => {
    const secret = createSecret();
    const wrapped = await wrapSecret("123-456-ABC", secret);
    expect(await unwrapSecret("123-456-ABC", wrapped)).toBe(secret);
    await expect(unwrapSecret("123-456-ABD", wrapped)).rejects.toBeTruthy();
  });

  it("counts chunks", () => {
    expect(chunkCount(0)).toBe(0);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(P2P_CHUNK_SIZE)).toBe(1);
    expect(chunkCount(P2P_CHUNK_SIZE + 1)).toBe(2);
  });
});

describe("p2p control messages", () => {
  it("validates manifests and sanitizes names", () => {
    expect(parseControl("nope")).toBeNull();
    expect(parseControl(JSON.stringify({ type: "manifest", v: 2, files: [], chunkSize: 1, wrappedSecret: "a" }))).toBeNull();
    expect(
      parseControl(JSON.stringify({ type: "manifest", v: 2, files: [{ name: "a", size: 1, mime: "x" }], chunkSize: 1, wrappedSecret: "a.b" })),
    ).not.toBeNull();
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileName("\u0000")).toBe("file");
  });
});
