/**
 * E2E: streaming share protected for pre-publication review — password gate,
 * expiry bound into the link, countdown, refusal after expiry, player stop.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 22789 + Math.floor(Math.random() * 1000);
const SIGNAL = `ws://127.0.0.1:${PORT}`;
const SHOTS = process.env.PROTECT_SHOTS_DIR;
const video = readFileSync(resolve(here, "fixtures/stream-sample.webm"));
let relay: ChildProcess;

test.beforeAll(async () => {
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], { env: { ...process.env, PORT: String(PORT), STUN_URLS: "" }, stdio: "pipe" });
  await new Promise<void>((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    relay.stdout!.on("data", (d) => String(d).includes("listening") && (clearTimeout(t), ok()));
  });
});
test.afterAll(() => relay?.kill());

async function prepare(page: Page, extra: Record<string, number> = {}) {
  await page.addInitScript(([url, x]) => {
    const w = window as unknown as Record<string, unknown>;
    w.__FILENYMOUS_SIGNAL_URL__ = url;
    Object.assign(w, x);
  }, [SIGNAL, extra] as const);
}

async function protectedShare(browser: Browser, { password = "", expiry = "24h", testExpiryS = 0, delayMs = 0, shot = false } = {}) {
  const sender = await (await browser.newContext()).newPage();
  await prepare(sender, { ...(testExpiryS ? { __FILENYMOUS_TEST_EXPIRY_S__: testExpiryS } : {}), ...(delayMs ? { __FILENYMOUS_TEST_CHUNK_DELAY_MS__: delayMs } : {}) });
  await sender.goto("/");
  await sender.locator('input[type="file"]').first().setInputFiles([{ name: "campagne-v3.webm", mimeType: "video/webm", buffer: video }]);
  await sender.getByTestId("send-stream").check();
  await expect(sender.getByTestId("stream-protect")).toBeVisible();
  if (password) await sender.getByTestId("send-password").fill(password);
  await sender.getByTestId(`expiry-${expiry}`).click();
  if (shot && SHOTS) await sender.screenshot({ path: `${SHOTS}/protect-sender-options.png`, fullPage: true });
  await sender.getByTestId("start-send").click();
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "waiting", { timeout: 15_000 });
  const link = await sender.getByTestId("p2p-link").inputValue();
  expect(link).toMatch(/#p2p:\d{3}-\d{3}-[A-Z]{3}\/[A-Za-z0-9_-]{16,}\/e[0-9a-z]+$/);
  return { sender, link: link.replace(/^https?:\/\/[^/]+/, "") };
}

async function openReceiver(browser: Browser, link: string) {
  const receiver = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await prepare(receiver);
  await receiver.goto(link);
  return receiver;
}

test("password + 24 h expiry: countdown shown, wrong password refused, right one streams", async ({ browser }) => {
  const { sender, link } = await protectedShare(browser, { password: "revue-2026", expiry: "24h", shot: true });
  await expect(sender.getByTestId("send-expiry")).toContainText(/Expire dans (23 h|1 j)/);
  await expect(sender.getByTestId("send-protect-summary")).toContainText("mot de passe");
  if (SHOTS) await sender.screenshot({ path: `${SHOTS}/protect-sender-share.png`, fullPage: true });
  const receiver = await openReceiver(browser, link);
  await expect(receiver.getByTestId("expiry-countdown")).toContainText(/Expire dans (23 h|1 j)/);
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "password", { timeout: 45_000 });
  await receiver.getByTestId("p2p-password").fill("pas-le-bon");
  await receiver.getByTestId("p2p-password-submit").click();
  await expect(receiver.getByTestId("p2p-password-error")).toContainText("4", { timeout: 30_000 });
  await expect(receiver.getByTestId("p2p-files")).toHaveCount(0);
  if (SHOTS) await receiver.screenshot({ path: `${SHOTS}/protect-receiver-wrong-password.png`, fullPage: true });
  await receiver.getByTestId("p2p-password").fill("revue-2026");
  await receiver.getByTestId("p2p-password-submit").click();
  await receiver.getByTestId("p2p-stream-play").click({ timeout: 45_000 });
  const player = receiver.getByTestId("p2p-player");
  await player.evaluate((el: HTMLMediaElement) => { el.muted = true; void el.play().catch(() => undefined); });
  await expect.poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime), { timeout: 30_000 }).toBeGreaterThan(0.3);
  await expect(receiver.getByTestId("expiry-countdown")).toBeVisible();
  if (SHOTS) await receiver.screenshot({ path: `${SHOTS}/protect-receiver-playing.png`, fullPage: true });
});

test("playback stops at expiry; the sender closes; a late visitor sees 'Ce lien a expiré'", async ({ browser }) => {
  const { sender, link } = await protectedShare(browser, { expiry: "1h", testExpiryS: 9, delayMs: 700 });
  const receiver = await openReceiver(browser, link);
  await expect(receiver.getByTestId("expiry-countdown")).toContainText(/Expire dans \d+ s/);
  await receiver.getByTestId("p2p-stream-play").click({ timeout: 45_000 });
  const player = receiver.getByTestId("p2p-player");
  await player.evaluate((el: HTMLMediaElement) => { el.muted = true; void el.play().catch(() => undefined); });
  await expect.poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime), { timeout: 30_000 }).toBeGreaterThan(0);
  // Expiry: player removed, receiver and sender closed.
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "error", { timeout: 20_000 });
  await expect(receiver.getByTestId("p2p-recv-status")).toContainText("Ce lien a expiré");
  await expect(receiver.getByTestId("p2p-player")).toHaveCount(0);
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "expired");
  if (SHOTS) {
    await receiver.screenshot({ path: `${SHOTS}/protect-receiver-expired.png`, fullPage: true });
    await sender.screenshot({ path: `${SHOTS}/protect-sender-expired.png`, fullPage: true });
  }
  const late = await openReceiver(browser, link);
  await expect(late.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "error");
  await expect(late.getByTestId("p2p-recv-status")).toContainText("Ce lien a expiré");
});

test("editing the expiry in the link breaks it", async ({ browser }) => {
  const { link } = await protectedShare(browser, { expiry: "1h" });
  const tampered = link.replace(/\/e([0-9a-z]+)$/, (_, e: string) => `/e${(parseInt(e, 36) + 86_400).toString(36)}`);
  const receiver = await openReceiver(browser, tampered);
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "error", { timeout: 45_000 });
  await expect(receiver.getByTestId("p2p-stream-play")).toHaveCount(0);
  await receiver.context().close(); // one recipient at a time per code
  // Stripping the expiry is refused too.
  const stripped = await openReceiver(browser, link.replace(/\/e[0-9a-z]+$/, ""));
  await expect(stripped.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "error", { timeout: 45_000 });
});
