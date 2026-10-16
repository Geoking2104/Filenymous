/**
 * E2E: "Partage streamé" — the recipient plays video/audio while it is still
 * being transferred (Service Worker + Range requests over the P2P channel).
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 21789 + Math.floor(Math.random() * 1000);
const SIGNAL = `ws://127.0.0.1:${PORT}`;
const SHOTS = process.env.STREAM_SHOTS_DIR;
let relay: ChildProcess;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test.beforeAll(async () => {
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], { env: { ...process.env, PORT: String(PORT), STUN_URLS: "" }, stdio: "pipe" });
  await new Promise<void>((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    relay.stdout!.on("data", (d) => String(d).includes("listening") && (clearTimeout(t), ok()));
  });
});
test.afterAll(() => relay?.kill());

/** 16-bit PCM mono WAV with a sine tone. */
function wav(seconds: number, rate = 44_100): Buffer {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return b;
}

async function prepare(page: Page, delayMs = 0) {
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.addInitScript(([url, delay]) => {
    const w = window as unknown as Record<string, unknown>;
    w.__FILENYMOUS_SIGNAL_URL__ = url;
    if (delay) w.__FILENYMOUS_TEST_CHUNK_DELAY_MS__ = delay;
    delete w.showSaveFilePicker;
    delete w.showDirectoryPicker;
  }, [SIGNAL, delayMs] as const);
}

async function share(browser: Browser, file: { name: string; mimeType: string; buffer: Buffer }, { stream = true, delayMs = 40, password = "" } = {}) {
  const sender = await (await browser.newContext()).newPage();
  await prepare(sender, delayMs);
  await sender.goto("/");
  await sender.locator('input[type="file"]').first().setInputFiles([file]);
  if (stream) await sender.getByTestId("send-stream").check();
  if (password) await sender.getByTestId("send-password").fill(password);
  if (SHOTS && stream && file.name.endsWith(".webm")) await sender.screenshot({ path: `${SHOTS}/stream-sender-review.png`, fullPage: true });
  await sender.getByTestId("start-send").click();
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "waiting", { timeout: 15_000 });
  const link = await sender.getByTestId("p2p-link").inputValue();
  const receiver = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await prepare(receiver);
  await receiver.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  return { sender, receiver };
}

async function expectPlaysBeforeComplete(receiver: Page, size: number) {
  const player = receiver.getByTestId("p2p-player");
  await expect(player).toBeVisible({ timeout: 20_000 });
  await player.evaluate((el: HTMLMediaElement) => { el.muted = true; void el.play().catch(() => undefined); });
  // The player is ready to play (or already playing) …
  await expect.poll(() => player.evaluate((el: HTMLMediaElement) => el.readyState >= 3 || el.currentTime > 0), { timeout: 30_000 }).toBe(true);
  const got = Number(await receiver.getByTestId("p2p-stream-bytes").getAttribute("data-bytes"));
  // … while the file is still being transferred,
  expect(got, "playback must start before the whole file is transferred").toBeLessThan(size);
  // … and it actually plays.
  await expect.poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime), { timeout: 30_000 }).toBeGreaterThan(0.3);
  return player;
}

test("streams a WebM video: plays before the transfer completes, seeks, and can be saved", async ({ browser }) => {
  const video = readFileSync(resolve(here, "fixtures/stream-sample.webm"));
  const { sender, receiver } = await share(browser, { name: "rushes.webm", mimeType: "video/webm", buffer: video }, { delayMs: 300 });
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  if (SHOTS) await receiver.screenshot({ path: `${SHOTS}/stream-receiver-ready.png`, fullPage: true });
  await receiver.getByTestId("p2p-stream-play").click();
  const player = await expectPlaysBeforeComplete(receiver, video.length);
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "streaming");
  if (SHOTS) {
    await receiver.screenshot({ path: `${SHOTS}/stream-receiver-playing.png`, fullPage: true });
    await sender.screenshot({ path: `${SHOTS}/stream-sender.png`, fullPage: true });
  }
  // Seek near the end: answered by a Range request for the tail only.
  await player.evaluate((el: HTMLMediaElement) => { el.currentTime = 10; });
  await expect.poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime), { timeout: 30_000 }).toBeGreaterThan(10.2);
  // Save: the full file, byte-identical.
  const dl = receiver.waitForEvent("download");
  await receiver.getByTestId("p2p-stream-save").click();
  expect(sha(readFileSync((await (await dl).path())!))).toBe(sha(video));
});

test("streams audio (WAV) behind a password", async ({ browser }) => {
  const audio = wav(30); // ~2.6 MB
  const { receiver } = await share(browser, { name: "interview.wav", mimeType: "audio/wav", buffer: audio }, { delayMs: 30, password: "écoute" });
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "password", { timeout: 45_000 });
  await receiver.getByTestId("p2p-password").fill("écoute");
  await receiver.getByTestId("p2p-password-submit").click();
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  await receiver.getByTestId("p2p-stream-play").click();
  await expectPlaysBeforeComplete(receiver, audio.length);
  if (SHOTS) await receiver.screenshot({ path: `${SHOTS}/stream-audio.png`, fullPage: true });
});

test("unsupported format falls back to play-after-download; non-streaming shares are unchanged", async ({ browser }) => {
  const { receiver } = await share(browser, { name: "clip.avi", mimeType: "video/x-msvideo", buffer: Buffer.alloc(200_000, 7) }, { delayMs: 0 });
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  await expect(receiver.getByTestId("p2p-stream-unsupported")).toBeVisible();
  await expect(receiver.getByTestId("p2p-stream-play")).toHaveCount(0);
  if (SHOTS) await receiver.screenshot({ path: `${SHOTS}/stream-fallback.png`, fullPage: true });
  await expect(receiver.getByTestId("p2p-download")).toBeVisible();

  const plain = await share(browser, { name: "movie.webm", mimeType: "video/webm", buffer: Buffer.alloc(100_000, 1) }, { stream: false, delayMs: 0 });
  await expect(plain.receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  await expect(plain.receiver.getByTestId("p2p-stream-play")).toHaveCount(0);
  const dl = plain.receiver.waitForEvent("download");
  await plain.receiver.getByTestId("p2p-download").click();
  expect(readFileSync((await (await dl).path())!).length).toBe(100_000);
});

test("home card (screenshots only)", async ({ browser }) => {
  test.skip(!SHOTS, "screenshots only");
  for (const scheme of ["light", "dark"] as const) {
    for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
      const page = await (await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: name === "mobile" ? 2 : 1 })).newPage();
      await page.goto("/");
      await page.getByTestId("carousel-dot").nth(6).click();
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${SHOTS}/home-stream-card-${name}-${scheme}.png`, fullPage: true });
    }
  }
});
