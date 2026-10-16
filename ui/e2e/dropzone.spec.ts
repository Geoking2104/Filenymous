/**
 * E2E: 100 % P2P Dropzone. The owner's tab receives files from several
 * contributors through a locally started p2p-signal relay.
 */
import { test, expect, type Browser, type Download, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 19789 + Math.floor(Math.random() * 1000);
const SIGNAL = `ws://127.0.0.1:${PORT}`;
let relay: ChildProcess;

test.beforeAll(async () => {
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], {
    env: { ...process.env, PORT: String(PORT), STUN_URLS: "", RATE_LIMIT_MAX_MESSAGES: "1000" },
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
});

test.afterAll(() => {
  relay?.kill();
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const local = (link: string) => link.replace(/^https?:\/\/[^/]+/, "");

async function newPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await page.addInitScript((url) => {
    (window as unknown as { __FILENYMOUS_SIGNAL_URL__: string }).__FILENYMOUS_SIGNAL_URL__ = url;
  }, SIGNAL);
  return page;
}

/** True when closing the tab right now would trigger the beforeunload prompt. */
async function guarded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
}

async function createDrop(owner: Page, opts: { name?: string; password?: string } = {}) {
  await owner.goto("/#drop-new");
  if (opts.name) await owner.getByTestId("drop-name").fill(opts.name);
  if (opts.password) await owner.getByTestId("drop-password").fill(opts.password);
  await owner.getByTestId("drop-create-submit").click();
  await expect(owner.getByTestId("drop-keep-open")).toBeVisible();
  await expect(owner.getByTestId("drop-owner-status")).toHaveAttribute("data-status", "online", { timeout: 15_000 });
  return { link: await owner.getByTestId("drop-link").inputValue(), ownerUrl: owner.url() };
}

test("two contributors drop files into the owner's tab, with password and receipts", async ({ browser }) => {
  const owner = await newPage(browser);
  const { link } = await createDrop(owner, { name: "mon-projet", password: "pa55" });
  expect(link).toMatch(/#drop:drop-[a-f0-9]{24}\/[A-Za-z0-9_-]{16,}\/[0-9a-z]+\/p\//);
  const downloads: Download[] = [];
  owner.on("download", (d) => downloads.push(d));

  const big = randomBytes(600 * 1024 + 77);
  const small = Buffer.from("bonjour dropzone\n");
  const contributors = await Promise.all([newPage(browser), newPage(browser)]);
  const payloads = [
    [{ name: "a-big.bin", mimeType: "application/octet-stream", buffer: big }],
    [{ name: "b-small.txt", mimeType: "text/plain", buffer: small }],
  ];

  await Promise.all(
    contributors.map(async (c, i) => {
      await c.goto(local(link));
      await c.getByTestId("drop-password-input").fill("pa55");
      await c.getByTestId("drop-password-submit").click();
      await expect(c.getByText(/mon-projet/)).toBeVisible();
      await expect(c.getByTestId("drop-contrib-status")).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
      await c.getByTestId("drop-input").setInputFiles(payloads[i]!);
      await expect(c.getByTestId("drop-contrib-status")).toHaveAttribute("data-status", "complete", { timeout: 45_000 });
      // Receipt confirmed: the contributor may now close the tab freely.
      expect(await guarded(c)).toBe(false);
      await expect(c.getByText("b-small.txt")).toHaveCount(i === 1 ? 1 : 0); // never sees the others' files
    }),
  );

  await expect(owner.getByTestId("drop-contribution")).toHaveCount(2);
  await expect(owner.locator('[data-testid="drop-contribution"][data-status="done"]')).toHaveCount(2, { timeout: 15_000 });
  await expect(owner.getByTestId("drop-owner-status")).toHaveAttribute("data-active", "0");
  expect(await guarded(owner)).toBe(false);
  await expect.poll(() => downloads.length).toBe(2);
  const byName = Object.fromEntries(await Promise.all(downloads.map(async (d) => [d.suggestedFilename(), readFileSync((await d.path())!)])));
  expect(sha(byName["a-big.bin"])).toBe(sha(big));
  expect(byName["b-small.txt"].toString()).toBe(small.toString());
});

test("contributor sees 'owner offline', stays guarded, and delivers once the owner reopens", async ({ browser }) => {
  const owner = await newPage(browser);
  const { link, ownerUrl } = await createDrop(owner, { name: "offline" });
  await owner.context().close();

  const c = await newPage(browser);
  await c.goto(local(link));
  await expect(c.getByTestId("drop-contrib-status")).toHaveAttribute("data-status", "owner-offline", { timeout: 15_000 });
  const data = randomBytes(200 * 1024);
  await c.getByTestId("drop-input").setInputFiles({ name: "later.bin", mimeType: "application/octet-stream", buffer: data });
  await expect(c.getByTestId("drop-contrib-status")).toHaveAttribute("data-status", "owner-offline");
  expect(await guarded(c)).toBe(true);

  const back = await newPage(browser);
  const dl = back.waitForEvent("download", { timeout: 60_000 });
  await back.goto(local(ownerUrl)); // owner link resumes the same Dropzone
  await expect(c.getByTestId("drop-contrib-status")).toHaveAttribute("data-status", "complete", { timeout: 45_000 });
  expect(await guarded(c)).toBe(false);
  expect(sha(readFileSync((await (await dl).path())!))).toBe(sha(data));
});

test("wrong password is refused before any byte is sent", async ({ browser }) => {
  const owner = await newPage(browser);
  const { link } = await createDrop(owner, { password: "right" });
  const c = await newPage(browser);
  await c.goto(local(link));
  await c.getByTestId("drop-password-input").fill("wrong");
  await c.getByTestId("drop-password-submit").click();
  await expect(c.getByTestId("drop-contrib-status")).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await c.getByTestId("drop-input").setInputFiles({ name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(c.getByTestId("drop-password-gate")).toBeVisible({ timeout: 30_000 });
  await expect(c.getByRole("alert")).toBeVisible();
  expect(await guarded(c)).toBe(false);
  await expect(owner.getByTestId("drop-contribution")).toHaveCount(0);
});

test("expired link is refused client-side", async ({ browser }) => {
  const c = await newPage(browser);
  const past = Math.floor(Date.now() / 1000 - 60).toString(36);
  await c.goto(`/#drop:drop-${"a".repeat(24)}/${"s".repeat(22)}/${past}/n`);
  await expect(c.getByTestId("drop-contrib-status")).toHaveAttribute("data-status", "expired");
});
