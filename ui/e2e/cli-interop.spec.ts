/**
 * E2E: Filenymous CLI (cli/, Node + node-datachannel) ⇄ web app, through a
 * locally started p2p-signal relay. Skipped when cli/node_modules is absent.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(here, "../../cli");
const CLI = join(CLI_DIR, "dist/filenymous.js");
const PORT = 20789 + Math.floor(Math.random() * 1000);
const SIGNAL = `ws://127.0.0.1:${PORT}`;
const APP = "http://localhost:5173/";
const work = mkdtempSync(join(tmpdir(), "fn-cli-e2e-"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let relay: ChildProcess;

test.skip(!existsSync(join(CLI_DIR, "node_modules/node-datachannel")), "cli dependencies not installed (cd cli && npm ci)");

test.beforeAll(async () => {
  execFileSync(process.execPath, [join(CLI_DIR, "build.mjs")], { stdio: "ignore" });
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], { env: { ...process.env, PORT: String(PORT), STUN_URLS: "" }, stdio: "pipe" });
  await new Promise<void>((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    relay.stdout!.on("data", (d) => String(d).includes("listening") && (clearTimeout(t), ok()));
  });
});
test.afterAll(() => relay?.kill());

function cli(args: string[], env: Record<string, string> = {}) {
  const proc = spawn(process.execPath, [CLI, ...args, "--signal", SIGNAL, "--app-url", APP], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let errOut = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (errOut += d));
  const done = new Promise<{ code: number | null; out: string; err: string }>((ok) => proc.on("exit", (code) => ok({ code, out, err: errOut })));
  const line = (re: RegExp) => expect.poll(() => out.split("\n").find((l) => re.test(l)) ?? "", { timeout: 20_000 }).toMatch(re).then(() => out.split("\n").find((l) => re.test(l))!);
  return { proc, done, line };
}

async function prepare(page: Page) {
  await page.addInitScript((url) => {
    (window as unknown as { __FILENYMOUS_SIGNAL_URL__: string }).__FILENYMOUS_SIGNAL_URL__ = url;
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  }, SIGNAL);
}

test("CLI upload → web receiver (same link format, password gate)", async ({ browser }) => {
  const data = randomBytes(900 * 1024 + 17);
  writeFileSync(join(work, "build.zip"), data);
  const up = cli(["upload", join(work, "build.zip"), "--ttl", "2m", "--json"], { FILENYMOUS_PASSWORD: "ci-pass" });
  const created = JSON.parse(await up.line(/"share.created"/));
  expect(created.link).toMatch(/^http:\/\/localhost:5173\/#p2p:\d{3}-\d{3}-[A-Z]{3}\/[A-Za-z0-9_-]{16,}$/);

  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await prepare(page);
  await page.goto(created.link.replace(APP, "/"));
  await expect(page.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "password", { timeout: 45_000 });
  await page.getByTestId("p2p-password").fill("ci-pass");
  await page.getByTestId("p2p-password-submit").click();
  await expect(page.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  await expect(page.getByTestId("p2p-files")).toContainText("build.zip");
  await expect(page.getByTestId("p2p-peer-device")).toContainText("Filenymous CLI");
  const dl = page.waitForEvent("download");
  await page.getByTestId("p2p-download").click();
  await expect(page.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "complete", { timeout: 45_000 });
  expect(sha(readFileSync((await (await dl).path())!))).toBe(sha(data));

  const res = await up.done;
  expect(res.code, res.err).toBe(0);
  expect(res.out).toContain('"download.completed"');
});

test("web sender → CLI receive", async ({ browser }) => {
  const data = randomBytes(700 * 1024 + 3);
  const page = await (await browser.newContext()).newPage();
  await prepare(page);
  await page.goto("/");
  await page.locator('input[type="file"]').first().setInputFiles([{ name: "rushes.bin", mimeType: "application/octet-stream", buffer: data }]);
  await page.getByTestId("start-send").click();
  await expect(page.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "waiting", { timeout: 15_000 });
  const link = await page.getByTestId("p2p-link").inputValue();

  const out = join(work, "recv");
  const rx = cli(["receive", link, "-o", out]);
  const res = await rx.done;
  expect(res.code, res.err).toBe(0);
  expect(res.out.trim()).toBe(join(out, "rushes.bin"));
  expect(sha(readFileSync(join(out, "rushes.bin")))).toBe(sha(data));
  await expect(page.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await expect(page.getByTestId("device-to")).toContainText("Filenymous CLI");
});

test("CLI --stream → web player; web streaming sender → CLI receive (sequential, compatible)", async ({ browser }) => {
  const video = readFileSync(resolve(here, "fixtures/stream-sample.webm"));
  writeFileSync(join(work, "clip.webm"), video);
  const up = cli(["upload", join(work, "clip.webm"), "--ttl", "2m", "--json", "--stream"]);
  const created = JSON.parse(await up.line(/"share.created"/));
  const page = await (await browser.newContext()).newPage();
  await prepare(page);
  await page.goto(created.link.replace(APP, "/"));
  await page.getByTestId("p2p-stream-play").click({ timeout: 45_000 });
  const player = page.getByTestId("p2p-player");
  await player.evaluate((el: HTMLMediaElement) => { el.muted = true; void el.play().catch(() => undefined); });
  await expect.poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime), { timeout: 30_000 }).toBeGreaterThan(0.3);
  up.proc.kill("SIGINT");
  await up.done;

  const sender = await (await browser.newContext()).newPage();
  await prepare(sender);
  await sender.goto("/");
  await sender.locator('input[type="file"]').first().setInputFiles([{ name: "clip.webm", mimeType: "video/webm", buffer: video }]);
  await sender.getByTestId("send-stream").check();
  await sender.getByTestId("start-send").click();
  await expect(sender.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "waiting", { timeout: 15_000 });
  const out = join(work, "recv-stream");
  const res = await cli(["receive", await sender.getByTestId("p2p-link").inputValue(), "-o", out]).done;
  expect(res.code, res.err).toBe(0);
  expect(sha(readFileSync(join(out, "clip.webm")))).toBe(sha(video));
});
