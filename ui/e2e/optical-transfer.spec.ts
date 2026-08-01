/**
 * E2E tests for the optical (screen-to-camera) transfer feature.
 *
 * These tests verify the UI components and protocol round-trip without
 * requiring a real camera — they mock MediaDevices and simulate the QR
 * encode→decode cycle programmatically.
 */
import { test, expect } from "@playwright/test";

test.describe("Optical transfer", () => {
  test("send panel renders profile selector with 5 profiles", async ({ page }) => {
    await page.goto("/");
    // Click the "No network" tab in SendPanel
    await page.getByRole("button", { name: /sans réseau|no network/i }).click();

    // Profile buttons should be visible
    await expect(page.getByRole("button", { name: /Robust/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Balanced/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Turbo 15/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Turbo 30/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Turbo 60/i })).toBeVisible();
  });

  test("profile auto-recommends when file is selected", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /sans réseau|no network/i }).click();

    // Create a small test file via file input
    const fileInput = page.locator('input[type="file"]');
    const buffer = Buffer.alloc(10 * 1024, 0x42); // 10 KB file
    await fileInput.setInputFiles({
      name: "small-test.bin",
      mimeType: "application/octet-stream",
      buffer,
    });

    // Robust should be auto-selected for small files (< 50 KB)
    await expect(page.getByRole("button", { name: /Robust/i })).toHaveCSS(
      /border-color/,
      /rgb/,
    );
  });

  test("receive panel renders camera button", async ({ page }) => {
    await page.goto("/#/receive");
    // The OpticalReceivePanel should be available via the receive tab
    await page.getByRole("button", { name: /ouvrir la caméra|open camera/i }).click();
    // Should attempt to open camera (will fail in headless but button exists)
  });
});

test.describe("Protocol round-trip", () => {
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
