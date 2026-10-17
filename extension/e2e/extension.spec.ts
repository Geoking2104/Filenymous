/**
 * E2E: the unpacked Chrome extension (headless Chromium) against a local
 * p2p-signal relay (ALLOWED_ORIGIN with "chrome-extension://*") and the web app
 * dev server. Text → secret link → revealed in the app; file (popup) and image
 * (context menu) → P2P → received in the app.
 */
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(here, "../dist-e2e/chrome");
const PORT = 21789 + Math.floor(Math.random() * 1000);
const SIGNAL = `ws://127.0.0.1:${PORT}`;
const API = `http://127.0.0.1:${PORT}`;
const APP = "http://localhost:5173/";
const SHOTS = process.env.FN_SHOTS_DIR || resolve(here, "../test-results/shots");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let relay: ChildProcess;
let images: Server;
let imagesPort = 0;
let ctx: BrowserContext;
let sw: Worker;
let extId = "";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.execPath, [resolve(here, "../build.mjs"), "--e2e"], { env: { ...process.env, FN_SIGNAL_URL: SIGNAL, FN_APP_URL: APP }, stdio: "ignore" });
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], {
    env: { ...process.env, PORT: String(PORT), STUN_URLS: "", REDIS_URL: "", ALLOWED_ORIGIN: "http://localhost:5173,chrome-extension://*", VAULT_CREATE_PER_MIN: "1000", VAULT_READ_PER_MIN: "1000" },
    stdio: "pipe",
  });
  await new Promise<void>((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    relay.stdout!.on("data", (d) => String(d).includes("listening") && (clearTimeout(t), ok()));
  });
  // A site with one CORS-enabled image and one without CORS.
  images = createServer((req, res) => {
    if (req.url === "/cors/photo.png") res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
    else if (req.url === "/private/photo.png") res.writeHead(200, { "content-type": "image/png" });
    else return res.writeHead(404).end();
    res.end(PNG);
  });
  await new Promise<void>((ok) => images.listen(0, "127.0.0.1", ok));
  imagesPort = (images.address() as { port: number }).port;

  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "fn-ext-")), {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  extId = new URL(sw.url()).host;
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP.slice(0, -1) });
});

test.afterAll(async () => {
  await ctx?.close();
  relay?.kill();
  images?.close();
});

async function appPage(): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript(([signal, api]) => {
    const w = window as unknown as Record<string, unknown>;
    w.__FILENYMOUS_SIGNAL_URL__ = signal;
    w.__FILENYMOUS_VAULT_URL__ = api;
    delete w.showSaveFilePicker;
    delete w.showDirectoryPicker;
  }, [SIGNAL, API] as const);
  return page;
}

type Reply = { ok: boolean; link?: string; error?: string; message?: string };
const menu = (info: Record<string, unknown>) =>
  sw.evaluate((i) => (globalThis as unknown as { __fnTest: { onMenu(i: unknown): Promise<unknown> } }).__fnTest.onMenu({ frameId: 0, editable: false, pageUrl: "", ...i }), info) as Promise<Reply>;

const activeLink = (popup: Page) => popup.locator('li[data-kind="p2p"]:not(.ended) [data-testid="share-link"]').first().inputValue();
const p2pStatus = (popup: Page) => popup.locator('li[data-kind="p2p"] [data-testid="share-status"]').first();

async function receive(link: string): Promise<{ data: Buffer; page: Page }> {
  const page = await appPage();
  await page.goto(link);
  await expect(page.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", /ready|password/, { timeout: 45_000 });
  return { page, data: Buffer.alloc(0) };
}

async function download(page: Page): Promise<Buffer> {
  const dl = page.waitForEvent("download");
  await page.getByTestId("p2p-download").click();
  await expect(page.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "complete", { timeout: 45_000 });
  return readFileSync((await (await dl).path())!);
}

test("right-click on selected text → secret link copied → revealed in the web app", async () => {
  const page = await appPage();
  await page.goto(APP);
  const secret = "ghp_EXTENSION_123\nseconde ligne é";
  const r = await menu({ menuItemId: "fn-selection", selectionText: secret });
  expect(r.ok, r.message).toBe(true);
  expect(r.link).toMatch(/^http:\/\/localhost:5173\/#s:[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{43}$/);
  // Copied by the offscreen document (reason CLIPBOARD).
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(r.link);

  const reader = await appPage();
  await reader.goto(r.link!);
  await expect(reader.getByTestId("vault-show")).toBeVisible();
  await reader.screenshot({ path: join(SHOTS, "1-secret-lien-ouvert.png") });
  await reader.getByTestId("vault-show").click();
  await expect(reader.getByTestId("vault-secret")).toHaveText(secret);
  await reader.screenshot({ path: join(SHOTS, "2-secret-revele.png") });
  await reader.reload();
  await expect(reader.getByTestId("vault-gone")).toBeVisible();
});

test("popup: file → P2P link copied → received in the web app, popup shows the state", async () => {
  const data = randomBytes(1024 * 1024 + 123);
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 400, height: 620 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.screenshot({ path: join(SHOTS, "3-popup-vide.png") });
  await popup.getByTestId("file-input").setInputFiles([{ name: "rapport-final.bin", mimeType: "application/octet-stream", buffer: data }]);
  await popup.getByTestId("send").click();
  await expect(popup.getByTestId("message")).toContainText("Lien copié");
  const link = await activeLink(popup);
  expect(link).toMatch(/^http:\/\/localhost:5173\/#p2p:\d{3}-\d{3}-[A-Z]{3}\/[A-Za-z0-9_-]{16,}\/e[0-9a-z]+$/);
  await expect(popup.getByTestId("keep-open")).toBeVisible();
  await expect(p2pStatus(popup)).toHaveText("En attente du destinataire", { timeout: 15_000 });
  await popup.screenshot({ path: join(SHOTS, "4-popup-partage-actif.png") });

  const { page } = await receive(link);
  await expect(page.getByTestId("p2p-files")).toContainText("rapport-final.bin");
  await expect(page.getByTestId("p2p-peer-device")).toContainText("Extension Filenymous");
  expect(sha(await download(page))).toBe(sha(data));
  await page.screenshot({ path: join(SHOTS, "5-app-recu.png") });
  await expect(p2pStatus(popup)).toHaveText(/^Terminé/, { timeout: 15_000 });
  await expect(popup.getByTestId("keep-open")).toBeHidden();
  await popup.screenshot({ path: join(SHOTS, "6-popup-termine.png") });
});

test("popup: password-protected file", async () => {
  const data = randomBytes(64 * 1024);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.getByTestId("file-input").setInputFiles([{ name: "contrat.pdf", mimeType: "application/pdf", buffer: data }]);
  await popup.locator("details.options summary").click();
  await popup.getByTestId("file-password").fill("cle-partagee");
  await popup.getByTestId("send").click();
  await expect(popup.getByTestId("message")).toContainText("Lien copié");
  const link = await activeLink(popup);
  const { page } = await receive(link);
  await expect(page.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "password");
  await page.getByTestId("p2p-password").fill("cle-partagee");
  await page.getByTestId("p2p-password-submit").click();
  await expect(page.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  expect(sha(await download(page))).toBe(sha(data));
});

test("right-click on an image → P2P link; without CORS the extension asks for access to that site only", async () => {
  const r = await menu({ menuItemId: "fn-image", srcUrl: `http://127.0.0.1:${imagesPort}/cors/photo.png`, mediaType: "image" });
  expect(r.ok, r.message).toBe(true);
  const { page } = await receive(r.link!);
  await expect(page.getByTestId("p2p-files")).toContainText("photo.png");
  expect(sha(await download(page))).toBe(sha(PNG));

  const grant = ctx.waitForEvent("page", { predicate: (p) => p.url().includes("/grant.html"), timeout: 15_000 });
  const blocked = await menu({ menuItemId: "fn-image", srcUrl: `http://127.0.0.1:${imagesPort}/private/photo.png`, mediaType: "image" });
  expect(blocked).toMatchObject({ ok: false, error: "blocked", origin: "http://127.0.0.1" });
  const g = await grant;
  await g.waitForLoadState();
  await expect(g.locator("#site")).toHaveText("127.0.0.1");
  await g.setViewportSize({ width: 460, height: 340 });
  await g.screenshot({ path: join(SHOTS, "7-autorisation-site.png") });
});

test("the popup secret tab creates a link the app reveals (password)", async () => {
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.locator("#tab-btn-secret").click();
  await popup.getByTestId("secret-text").fill("token-du-popup");
  await popup.getByTestId("secret-password").fill("pw");
  await popup.getByTestId("secret-send").click();
  await expect(popup.getByTestId("message")).toContainText("Lien secret copié");
  const link = await popup.locator('li[data-kind="secret"] [data-testid="share-link"]').first().inputValue();
  const reader = await appPage();
  await reader.goto(link);
  await reader.getByTestId("vault-reveal-password").fill("pw");
  await reader.getByTestId("vault-show").click();
  await expect(reader.getByTestId("vault-secret")).toHaveText("token-du-popup");
});
