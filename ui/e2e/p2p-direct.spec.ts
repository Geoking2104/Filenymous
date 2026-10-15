/**
 * E2E: direct transfer between two browser contexts,
 * through a locally started p2p-signal relay (no external network needed).
 */
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const PORT = 18789 + Math.floor(Math.random() * 1000);
const SIGNAL = `ws://127.0.0.1:${PORT}`;
let relay: ChildProcess;

test.beforeAll(async () => {
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], {
    env: { ...process.env, PORT: String(PORT), STUN_URLS: "" },
    stdio: "pipe",
  });
  await new Promise<void>((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    relay.stdout!.on("data", (d) => {
      if (String(d).includes("listening")) {
        clearTimeout(t);
        ok();
      }
    });
  });
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
  expect(health.ok).toBe(true);
});

test.afterAll(() => {
  relay?.kill();
});

async function prepare(page: Page, { noPicker = false } = {}) {
  await page.addInitScript(
    ([url, strip]) => {
      (window as unknown as { __FILENYMOUS_SIGNAL_URL__: string }).__FILENYMOUS_SIGNAL_URL__ = url as string;
      if (strip) {
        // Headless can't answer the File System Access picker: use the Blob fallback.
        delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
        delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
      }
    },
    [SIGNAL, noPicker] as const,
  );
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("streams two files sender → receiver over WebRTC with a short link", async ({ browser }) => {
  const big = randomBytes(700 * 1024 + 123); // > 10 chunks, odd tail
  const small = Buffer.from("bonjour filenymous p2p\n");

  const senderCtx = await browser.newContext();
  const sender = await senderCtx.newPage();
  await prepare(sender);
  await sender.goto("/");
  await sender.locator('input[type="file"]').first().setInputFiles([
    { name: "big.bin", mimeType: "application/octet-stream", buffer: big },
    { name: "hello.txt", mimeType: "text/plain", buffer: small },
  ]);
  await sender.getByTestId("path-direct").click();
  await sender.getByRole("button", { name: /Démarrer le transfert direct|Start direct transfer/ }).click();

  const linkInput = sender.getByTestId("p2p-link");
  await expect(linkInput).toBeVisible();
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "waiting", { timeout: 15_000 });
  const link = await linkInput.inputValue();
  expect(link).toMatch(/#p2p:\d{3}-\d{3}-[A-Z]{3}\/[A-Za-z0-9_-]{16,}$/);
  await expect(sender.locator('[data-testid="p2p-send-panel"] svg')).toBeVisible(); // QR code

  const receiverCtx = await browser.newContext({ acceptDownloads: true });
  const receiver = await receiverCtx.newPage();
  await prepare(receiver, { noPicker: true });
  await receiver.goto(link.replace(/^https?:\/\/[^/]+/, ""));

  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  await expect(receiver.getByTestId("p2p-files")).toContainText("big.bin");
  await expect(receiver.getByTestId("p2p-files")).toContainText("hello.txt");

  const got: import("@playwright/test").Download[] = [];
  receiver.on("download", (d) => got.push(d));
  await receiver.getByTestId("p2p-download").click();
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "complete", { timeout: 45_000 });
  await expect.poll(() => got.length).toBe(2);

  const byName = Object.fromEntries(await Promise.all(got.map(async (d) => [d.suggestedFilename(), readFileSync((await d.path())!)])));
  expect(sha(byName["big.bin"])).toBe(sha(big));
  expect(byName["hello.txt"].toString()).toBe(small.toString());

  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "complete", { timeout: 15_000 });

  // A second recipient can use the same link while the sender's tab stays open.
  const second = await (await browser.newContext()).newPage();
  await prepare(second, { noPicker: true });
  await second.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(second.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });

  await senderCtx.close();
  await receiverCtx.close();
});

test("typed code (no secret in URL) still decrypts via the code-wrapped secret", async ({ browser }) => {
  const data = randomBytes(150 * 1024);
  const sender = await (await browser.newContext()).newPage();
  await prepare(sender);
  await sender.goto("/");
  await sender.locator('input[type="file"]').first().setInputFiles({ name: "x.bin", mimeType: "application/octet-stream", buffer: data });
  await sender.getByTestId("path-direct").click();
  await sender.getByRole("button", { name: /Démarrer le transfert direct|Start direct transfer/ }).click();
  const code = (await sender.getByTestId("p2p-code").textContent())!.trim();

  const receiver = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await prepare(receiver, { noPicker: true });
  await receiver.goto("/");
  await receiver.getByRole("tab", { name: /Recevoir|Receive/ }).click();
  await receiver.locator(".v3-receive-row input").fill(code);
  await receiver.locator(".v3-receive-row button").click();
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  const dl = receiver.waitForEvent("download");
  await receiver.getByTestId("p2p-download").click();
  const file = readFileSync((await (await dl).path())!);
  expect(sha(file)).toBe(sha(data));
});
