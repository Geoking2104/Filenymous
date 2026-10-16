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
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.addInitScript(
    ([url, strip]) => {
      // Keep handles on signaling sockets so tests can simulate network blips.
      const Native = window.WebSocket;
      const sockets: WebSocket[] = [];
      (window as unknown as { __sockets: WebSocket[] }).__sockets = sockets;
      (window as unknown as { WebSocket: unknown }).WebSocket = class extends Native {
        constructor(u: string | URL, p?: string | string[]) {
          super(u, p);
          sockets.push(this);
        }
      };
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
  await sender.getByRole("button", { name: /^(Démarrer|Start)$/ }).click();

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
  await expect(sender.getByTestId("p2p-send-status")).toContainText(/Téléchargement terminé par le destinataire|Download completed by the recipient/);
  await expect(sender.locator('[data-testid="p2p-send-log"] li[data-result="complete"]')).toHaveCount(1);
  await expect(sender.locator('[data-testid="p2p-send-files"] li[data-file-state="delivered"]')).toHaveCount(2);
  await expect(receiver.getByTestId("p2p-recv-bytes")).toBeVisible();
  // Pigeon landed on both sides, peers' browser/OS exchanged over the channel.
  await expect(receiver.getByTestId("pigeon-pct")).toHaveText("100 %");
  await expect(sender.getByTestId("pigeon-pct")).toHaveText("100 %");
  await expect(receiver.getByTestId("p2p-peer-device")).toContainText(/Chrome|Chromium|Web/);
  await expect(sender.getByTestId("device-to")).toContainText(/Chrome|Web/);

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
  await sender.getByRole("button", { name: /^(Démarrer|Start)$/ }).click();
  const code = (await sender.getByTestId("p2p-code").textContent())!.trim();

  const receiver = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await prepare(receiver, { noPicker: true });
  await receiver.goto("/");
  await receiver.locator(".v3-receive-row input").fill(code);
  await receiver.locator(".v3-receive-row button").click();
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  const dl = receiver.waitForEvent("download");
  await receiver.getByTestId("p2p-download").click();
  const file = readFileSync((await (await dl).path())!);
  expect(sha(file)).toBe(sha(data));
});

test("survives a receiver signaling reconnect, shows live progress on both sides, then the completion ack", async ({ browser }) => {
  // Regression: a receiver WebSocket blip (peer-left/peer-joined on the relay)
  // used to tear down the live DataChannel → download stuck at 0 % and the
  // sender never learnt whether the recipient finished.
  const data = randomBytes(6 * 1024 * 1024 + 7);
  const sender = await (await browser.newContext()).newPage();
  await prepare(sender);
  await sender.goto("/");
  await sender.locator('input[type="file"]').first().setInputFiles({ name: "big.bin", mimeType: "application/octet-stream", buffer: data });
  await sender.getByRole("button", { name: /^(Démarrer|Start)$/ }).click();
  const link = await sender.getByTestId("p2p-link").inputValue();

  const receiver = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await prepare(receiver, { noPicker: true });
  await receiver.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "connected");

  // Simulate a network blip on the receiver's signaling socket.
  await receiver.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.forEach((ws) => ws.close()));
  await receiver.waitForTimeout(2000);
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "connected");

  const dl = receiver.waitForEvent("download");
  await receiver.getByTestId("p2p-download").click();
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", /transferring|complete/);
  const file = readFileSync((await (await dl).path())!);
  expect(sha(file)).toBe(sha(data));
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "complete");
  await expect(receiver.getByTestId("p2p-recv-bytes")).toContainText("6.0 Mo / 6.0 Mo");
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await expect(sender.locator('[data-testid="p2p-send-log"] li[data-result="complete"]')).toHaveCount(1);
});

test("sender reports failure with a reason when the recipient closes mid-transfer", async ({ browser }) => {
  const data = randomBytes(24 * 1024 * 1024);
  const sender = await (await browser.newContext()).newPage();
  await prepare(sender);
  await sender.goto("/");
  await sender.locator('input[type="file"]').first().setInputFiles({ name: "huge.bin", mimeType: "application/octet-stream", buffer: data });
  await sender.getByRole("button", { name: /^(Démarrer|Start)$/ }).click();
  const link = await sender.getByTestId("p2p-link").inputValue();

  const rctx = await browser.newContext({ acceptDownloads: true });
  const receiver = await rctx.newPage();
  await prepare(receiver, { noPicker: true });
  await receiver.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  await receiver.getByTestId("p2p-download").click();
  await expect(sender.getByTestId("p2p-send-bytes")).toBeVisible();
  await expect.poll(async () => (await sender.getByTestId("p2p-send-bytes").textContent()) ?? "").toMatch(/[1-9]\d*(\.\d)? (Ko|Mo)/);
  await rctx.close();
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "failed", { timeout: 30_000 });
  await expect(sender.locator('[data-testid="p2p-send-log"] li[data-result="failed"]')).toContainText(/Échec \/ interrompu|Failed \/ interrupted/);
});

test.describe("password-protected transfers", () => {
  async function startProtected(browser: import("@playwright/test").Browser, password: string, data: Buffer, shot = false) {
    const sender = await (await browser.newContext()).newPage();
    await prepare(sender);
    await sender.goto("/");
    await sender.locator('input[type="file"]').first().setInputFiles([
      { name: "secret.bin", mimeType: "application/octet-stream", buffer: data },
      { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
    ]);
    await expect(sender.getByTestId("review-step")).toContainText(/Vous allez envoyer 2 fichiers|You are about to send 2 files/);
    await expect(sender.getByTestId("review-files")).toContainText("text/plain");
    await sender.getByRole("button", { name: /Retirer note.txt|Remove note.txt/ }).click();
    await expect(sender.getByTestId("review-step")).toContainText(/Vous allez envoyer 1 fichier\.|You are about to send 1 file\./);
    await sender.getByTestId("send-password").fill(password);
    if (shot) await sender.screenshot({ path: "/workspace/filenymous-review-step.png", fullPage: true });
    await sender.getByTestId("start-send").click();
    const link = await sender.getByTestId("p2p-link").inputValue();
    expect(link).not.toContain(password);
    expect(decodeURIComponent(link)).not.toContain(password);
    await expect(sender.getByTestId("p2p-send-protected")).toBeVisible();
    const receiver = await (await browser.newContext({ acceptDownloads: true })).newPage();
    await prepare(receiver, { noPicker: true });
    await receiver.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "password", { timeout: 45_000 });
    // No file names leak before the password is proven.
    await expect(receiver.getByTestId("p2p-files")).toHaveCount(0);
    return { sender, receiver };
  }

  test("wrong password shows an error and allows a retry; the right one decrypts", async ({ browser }) => {
    const data = randomBytes(300 * 1024 + 5);
    const { sender, receiver } = await startProtected(browser, "s3cret-pass", data, true);
    await receiver.screenshot({ path: "/workspace/filenymous-receiver-password.png", fullPage: true });
    await receiver.getByTestId("p2p-password").fill("nope");
    await receiver.getByTestId("p2p-password-submit").click();
    await expect(receiver.getByTestId("p2p-password-error")).toContainText(/4/, { timeout: 30_000 });
    await receiver.screenshot({ path: "/workspace/filenymous-receiver-password-wrong.png", fullPage: true });
    await expect(sender.getByTestId("p2p-send-protected")).toContainText("1/5");
    await receiver.getByTestId("p2p-password").fill("s3cret-pass");
    await receiver.getByTestId("p2p-password-submit").click();
    await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
    await expect(receiver.getByTestId("p2p-files")).toContainText("secret.bin");
    const dl = receiver.waitForEvent("download");
    await receiver.getByTestId("p2p-download").click();
    expect(sha(readFileSync((await (await dl).path())!))).toBe(sha(data));
    await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  });

  test("locks the share after 5 wrong passwords", async ({ browser }) => {
    const { sender, receiver } = await startProtected(browser, "right", randomBytes(1024));
    for (let i = 0; i < 5; i++) {
      await expect(receiver.getByTestId("p2p-password")).toBeEnabled({ timeout: 30_000 });
      await receiver.getByTestId("p2p-password").fill(`wrong-${i}`);
      await receiver.getByTestId("p2p-password-submit").click();
      if (i < 4) await expect(receiver.getByTestId("p2p-password-error")).toContainText(String(4 - i), { timeout: 30_000 });
    }
    await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "error", { timeout: 30_000 });
    await expect(receiver.getByTestId("p2p-recv-status")).toContainText(/Trop de mots de passe|Too many wrong passwords/);
    await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "failed");
    // A fresh recipient is refused too.
    const again = await (await browser.newContext()).newPage();
    await prepare(again, { noPicker: true });
    await again.goto((await sender.getByTestId("p2p-link").inputValue()).replace(/^https?:\/\/[^/]+/, ""));
    await again.waitForTimeout(5000);
    await expect(again.getByTestId("p2p-recv-status")).not.toHaveAttribute("data-status", /password|ready/);
  });
});
