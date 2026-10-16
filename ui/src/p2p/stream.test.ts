// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_RANGE_CHUNKS, P2P_CHUNK_SIZE, createSecret, deriveFileKey, parseControl, sealChunk, type P2PControl } from "./protocol";
import { canPlayInBrowser, chunksForRange, mediaKind, mediaMime, parseRange } from "./media";
import { StreamReader, missingRuns } from "./stream";

describe("media helpers", () => {
  it("guesses media types from extensions when the sender sent none", () => {
    expect(mediaMime("clip.MP4", "")).toBe("video/mp4");
    expect(mediaMime("a.webm", "application/octet-stream")).toBe("video/webm");
    expect(mediaKind("song.mp3", "")).toBe("audio");
    expect(mediaKind("notes.pdf", "application/pdf")).toBeNull();
  });
  it("asks the browser whether it can play", () => {
    const probe = (m: string) => (m === "video/webm" || m === "audio/wav" ? "maybe" : "");
    expect(canPlayInBrowser("a.webm", "", probe)).toBe(true);
    expect(canPlayInBrowser("a.wav", "audio/wav", probe)).toBe(true);
    expect(canPlayInBrowser("a.avi", "video/x-msvideo", probe)).toBe(false);
    expect(canPlayInBrowser("a.txt", "text/plain", probe)).toBe(false);
  });
  it("parses HTTP Range headers", () => {
    expect(parseRange(null, 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=100-199", 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=1000-", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
  });
  it("maps byte ranges to chunks", () => {
    expect(chunksForRange(0, 0, 10 * P2P_CHUNK_SIZE)).toEqual({ from: 0, to: 0 });
    expect(chunksForRange(P2P_CHUNK_SIZE - 1, P2P_CHUNK_SIZE, 10 * P2P_CHUNK_SIZE)).toEqual({ from: 0, to: 1 });
    expect(chunksForRange(0, 1e12, 3 * P2P_CHUNK_SIZE + 5)).toEqual({ from: 0, to: 3 });
  });
});

describe("range protocol", () => {
  it("validates range messages", () => {
    expect(parseControl(JSON.stringify({ type: "range", index: 0, from: 2, to: 5 }))).toMatchObject({ type: "range" });
    expect(parseControl(JSON.stringify({ type: "range", index: 0, from: 5, to: 2 }))).toBeNull();
    expect(parseControl(JSON.stringify({ type: "range", index: -1, from: 0, to: 0 }))).toBeNull();
    expect(parseControl(JSON.stringify({ type: "range", index: 0, from: 0, to: MAX_RANGE_CHUNKS }))).toBeNull();
  });
  it("manifests stay v2 with an optional streamable flag (old receivers ignore it)", () => {
    const m = parseControl(JSON.stringify({ type: "manifest", v: 2, chunkSize: P2P_CHUNK_SIZE, files: [{ name: "a.webm", size: 1, mime: "video/webm" }], wrappedSecret: "x.y", streamable: true }));
    expect(m).toMatchObject({ v: 2, streamable: true });
  });
  it("groups missing chunks into bounded runs", () => {
    const have = new Set([3, 4, 9]);
    expect(missingRuns(0, 10, (c) => have.has(c))).toEqual([[0, 2], [5, 8], [10, 10]]);
    expect(missingRuns(0, 200, () => false)).toEqual([[0, 63], [64, 127], [128, 191], [192, 200]]);
    expect(missingRuns(5, 6, () => true)).toEqual([]);
  });
});

describe("StreamReader", () => {
  it("fetches only the needed chunks, decrypts them and slices exact byte ranges", async () => {
    const size = 5 * P2P_CHUNK_SIZE + 1234;
    const data = new Uint8Array(size).map((_, i) => (i * 31) % 251);
    const key = await deriveFileKey(createSecret());
    const sent: Extract<P2PControl, { type: "range" }>[] = [];
    let reader!: StreamReader;
    // Fake sender: answers out of order (reversed), like any WebRTC peer may not.
    const answer = async (m: Extract<P2PControl, { type: "range" }>) => {
      for (let c = m.to; c >= m.from; c--) {
        await reader.onFrame(await sealChunk(key, 0, c, data.subarray(c * P2P_CHUNK_SIZE, (c + 1) * P2P_CHUNK_SIZE)));
      }
    };
    reader = new StreamReader(key, [{ name: "v.webm", size, mime: "video/webm" }], (m) => {
      const r = m as Extract<P2PControl, { type: "range" }>;
      sent.push(r);
      setTimeout(() => void answer(r), 0);
    });
    const a = await reader.read(0, P2P_CHUNK_SIZE - 10, P2P_CHUNK_SIZE + 9);
    expect(Array.from(a)).toEqual(Array.from(data.subarray(P2P_CHUNK_SIZE - 10, P2P_CHUNK_SIZE + 10)));
    expect(sent[0]).toMatchObject({ from: 0, to: 1 });
    expect(sent[1]).toMatchObject({ from: 2, to: 5, prefetch: true });
    // The tail is now cached: no new request.
    const before = sent.length;
    const tail = await reader.read(0, size - 100, size + 50);
    expect(Array.from(tail)).toEqual(Array.from(data.subarray(size - 100)));
    expect(sent.length).toBe(before);
  });
  it("rejects tampered frames", async () => {
    const key = await deriveFileKey(createSecret());
    const other = await deriveFileKey(createSecret());
    const reader = new StreamReader(key, [{ name: "a", size: 10, mime: "" }], () => undefined);
    await expect(reader.onFrame(await sealChunk(other, 0, 0, new Uint8Array(10)))).rejects.toThrow();
  });
});
