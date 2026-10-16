/**
 * E2E tests for the optical (screen-to-camera) transfer feature.
 *
 * These tests verify the UI components and protocol round-trip without
 * requiring a real camera — they mock MediaDevices and simulate the QR
 * encode→decode cycle programmatically.
 */
import { test, expect } from "@playwright/test";

// The optical send/receive panels are no longer mounted in any reachable UI
// (neither the single page nor #legacy), so their UI tests were
// removed. The protocol itself stays covered here and in src/qrferry/*.test.ts.

test.describe("Protocol round-trip", () => {
  test.beforeEach(async ({ page }) => {
    // Module imports need the Vite dev server origin.
    await page.goto("/#legacy");
  });

  test("encode and decode descriptor + data frames", async ({ page }) => {
    // Use the page context to run protocol code in the browser
    const result = await page.evaluate(async () => {
      const { encodeDescriptor, encodeDataFrame, decodeFrame, crc32 } = await import(
        "/src/qrferry/protocol.ts"
      );

      const keyMaterial = new Uint8Array(32);
      crypto.getRandomValues(keyMaterial);

      const meta = {
        sessionId: 0xdeadbeef,
        filename: "test.bin",
        mime: "application/octet-stream",
        fileSize: 100,
        transmittedSize: 112,
        symbolSize: 220,
        totalPackets: 1,
        fileCrc32: crc32(new Uint8Array(100)),
        transmittedCrc32: crc32(new Uint8Array(112)),
        keyEncoding: "inline" as const,
        compressed: false,
        keyMaterial,
      };

      // Descriptor round-trip
      const descPacket = encodeDescriptor(meta);
      const descFrame = decodeFrame(descPacket);
      if (descFrame.kind !== "descriptor") return { error: "expected descriptor" };

      // Data frame round-trip
      const payload = new Uint8Array(200);
      crypto.getRandomValues(payload);
      const dataPacket = encodeDataFrame(meta.sessionId, { sequence: 42, payload });
      const dataFrame = decodeFrame(dataPacket);
      if (dataFrame.kind !== "data") return { error: "expected data frame" };

      return {
        descriptorOk: descFrame.meta.filename === "test.bin",
        dataOk: dataFrame.sequence === 42 && dataFrame.payload.length === 200,
      };
    });

    expect(result).toEqual({ descriptorOk: true, dataOk: true });
  });

  test("compression round-trip via fflate", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { deflateSync, inflateSync } = await import("/node_modules/fflate/esm/browser.js");
      const original = new Uint8Array(1000);
      for (let i = 0; i < original.length; i++) original[i] = i % 256;

      const compressed = deflateSync(original, { level: 9 });
      const decompressed = inflateSync(compressed);

      return {
        compressed: compressed.length < original.length,
        roundTrip: decompressed.length === original.length,
        matches: decompressed.every((v: number, i: number) => v === original[i]),
      };
    });

    expect(result.compressed).toBe(true);
    expect(result.roundTrip).toBe(true);
    expect(result.matches).toBe(true);
  });
});
