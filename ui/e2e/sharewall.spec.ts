/**
 * E2E: Sharewall — live multi-peer wall, star topology around the host's tab,
 * through a locally started p2p-signal relay. Three browser contexts.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 21789 + Math.floor(Math.random() * 1000);
const SIGNAL = `ws://127.0.0.1:${PORT}`;
let relay: ChildProcess;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], {
    env: { ...process.env, PORT: String(PORT), STUN_URLS: "", RATE_LIMIT_MAX_MESSAGES: "5000", WALL_HOST_GRACE_MS: "800", WALL_SWEEP_MS: "500" },
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
const fixture = (n: string) => readFileSync(resolve(here, "fixtures", n));

interface Ctx {
  page: Page;
  sent: string[];
}

async function newPage(browser: Browser, opts: { fakeClock?: boolean } = {}): Promise<Ctx> {
  const context = await browser.newContext({ acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  if (opts.fakeClock) await page.clock.install();
  await page.addInitScript((url) => {
    (window as unknown as { __FILENYMOUS_SIGNAL_URL__: string }).__FILENYMOUS_SIGNAL_URL__ = url;
  }, SIGNAL);
  // Everything the page sends to the relay, to prove the key never leaves the fragment.
  const sent: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => sent.push(String(f.payload))));
  return { page, sent };
}

/** True when closing the tab right now would trigger the beforeunload prompt. */
async function guarded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
}

async function createWall(host: Page, opts: { ttl?: "m15" | "h1" | "h24"; burn?: boolean; hostLeave?: boolean; password?: string } = {}) {
  await host.goto("/#wall-new");
  await host.getByTestId(`wall-ttl-${opts.ttl ?? "h1"}`).click();
  if (opts.burn) await host.getByTestId("wall-burn").check();
  if (opts.hostLeave === false) await host.getByTestId("wall-host-leave").uncheck();
  if (opts.password) await host.getByTestId("wall-password").fill(opts.password);
  await host.getByTestId("wall-create-submit").click();
  await expect(host.getByTestId("wall-keep-open")).toBeVisible();
  await expect(host.getByTestId("wall-host-status")).toHaveAttribute("data-status", "online", { timeout: 15_000 });
  const link = await host.getByTestId("wall-link").inputValue();
  return { link, hostUrl: host.url() };
}

async function join(peer: Page, link: string, password?: string) {
  await peer.goto(local(link));
  if (password) {
    await peer.getByTestId("drop-password-input").fill(password);
    await peer.getByTestId("drop-password-submit").click();
  }
  await expect(peer.getByTestId("wall-peer-status")).toHaveAttribute("data-status", "online", { timeout: 20_000 });
}

const items = (p: Page) => p.getByTestId("wall-grid").getByTestId("wall-item");
const item = (p: Page, name: string) => p.locator(`[data-testid="wall-item"][data-name="${name}"]`);
const snippet = (p: Page) => p.locator('[data-testid="wall-item"][data-kind="text"]');

test("3 contexts: live grid, snippets, previews, identical downloads, kill switch", async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { ttl: "h1", hostLeave: false });
  expect(link).toMatch(/\/#wall:wall-[a-f0-9]{24}\/[A-Za-z0-9_-]{43}\/[0-9a-z]+\/n$/);
  const key = link.split("/").slice(-3)[0]!;
  const hostSecret = host.page.url().split("#wall-host:")[1]!.split("/")[0]!;
  const code = await host.page.getByTestId("wall-code").locator("strong").textContent();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // Nobody connected yet: closing the host tab is not guarded.
  expect(await guarded(host.page)).toBe(false);

  const [a, b] = await Promise.all([newPage(browser), newPage(browser)]);
  await join(a.page, link);
  await join(b.page, link);
  await expect(host.page.getByTestId("wall-host")).toHaveAttribute("data-peers", "2");
  // Same verification code everywhere.
  await expect(a.page.getByTestId("wall-code").locator("strong")).toHaveText(code!);
  await expect(b.page.getByTestId("wall-code").locator("strong")).toHaveText(code!);
  // With peers connected, the host's tab asks before closing.
  expect(await guarded(host.page)).toBe(true);

  // Peers drop files and a snippet; the host drops an image.
  const big = randomBytes(900 * 1024 + 123);
  const note = "Bonjour le mur !\nligne 2 <script>alert(1)</script>";
  const secret = "API_KEY=sk-test-" + randomBytes(8).toString("hex");
  await a.page.getByTestId("wall-file-input").setInputFiles([
    { name: "big.bin", mimeType: "application/octet-stream", buffer: big },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(note) },
  ]);
  await a.page.getByTestId("wall-text").fill(secret);
  await a.page.getByTestId("wall-text-submit").click();
  await b.page.getByTestId("wall-file-input").setInputFiles([
    { name: "clip.webm", mimeType: "video/webm", buffer: fixture("stream-sample.webm") },
    { name: "doc.pdf", mimeType: "application/pdf", buffer: fixture("author.pdf") },
  ]);
  await b.page.getByTestId("wall-text").fill("note de B");
  await b.page.getByTestId("wall-text-submit").click();
  await host.page.getByTestId("wall-file-input").setInputFiles([{ name: "photo.jpg", mimeType: "image/jpeg", buffer: fixture("exif-gps.jpg") }]);

  // Everyone sees the same live grid of 7 items.
  for (const p of [host.page, a.page, b.page]) await expect(items(p)).toHaveCount(7, { timeout: 30_000 });

  // Snippets are masked until revealed, then readable and copyable.
  const aSecretOnB = snippet(b.page).filter({ hasText: "Participant 1" });
  await expect(aSecretOnB.locator(".is-masked")).toBeVisible();
  await expect(b.page.getByText(secret)).toHaveCount(0);
  await aSecretOnB.getByTestId("wall-reveal").click();
  await expect(aSecretOnB.getByTestId("wall-secret-text")).toHaveText(secret);
  await aSecretOnB.getByTestId("wall-copy").click();
  expect(await b.page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  await aSecretOnB.getByTestId("wall-hide").click();
  await expect(aSecretOnB.locator(".is-masked")).toBeVisible();

  // Previews from memory: image, video, text (as text, script not executed), PDF download only.
  await item(a.page, "photo.jpg").getByTestId("wall-preview").click();
  const img = a.page.getByTestId("wall-preview-img");
  await expect(img).toBeVisible();
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  expect(await img.getAttribute("src")).toMatch(/^blob:/);
  const imgUrl = (await img.getAttribute("src"))!;
  await a.page.getByTestId("wall-preview-close").click();
  // The Blob URL is revoked when the previewer closes.
  expect(await a.page.evaluate((u) => fetch(u).then(() => "alive", () => "revoked"), imgUrl)).toBe("revoked");

  await item(a.page, "clip.webm").getByTestId("wall-preview").click();
  const video = a.page.getByTestId("wall-preview-video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await a.page.keyboard.press("Escape");
  await expect(a.page.getByTestId("wall-previewer")).toHaveCount(0);

  let dialogs = 0;
  b.page.on("dialog", (d) => {
    dialogs++;
    void d.accept();
  });
  await item(b.page, "notes.txt").getByTestId("wall-preview").click();
  await expect(b.page.getByTestId("wall-preview-text")).toHaveText(note);
  expect(await b.page.evaluate(() => document.querySelectorAll(".sw-modal script").length)).toBe(0);
  await b.page.getByTestId("wall-preview-close").click();
  await expect(item(b.page, "doc.pdf").getByTestId("wall-preview")).toHaveCount(0);

  // Downloads are byte-identical (sha256) for another peer and for the host.
  const dl = b.page.waitForEvent("download");
  await item(b.page, "big.bin").getByTestId("wall-download").click();
  const got = readFileSync((await (await dl).path())!);
  expect(sha(got)).toBe(sha(big));
  const dl2 = host.page.waitForEvent("download");
  await item(host.page, "clip.webm").getByTestId("wall-download").click();
  const d2 = await dl2;
  expect(d2.suggestedFilename()).toBe("clip.webm");
  expect(sha(readFileSync((await d2.path())!))).toBe(sha(fixture("stream-sample.webm")));
  expect(dialogs).toBe(0); // no burn on this wall: no confirmation

  // The relay never received the key, the host secret from a peer, a file name or any content.
  for (const c of [host, a, b]) {
    const all = c.sent.join("\n");
    expect(all).not.toContain(key);
    expect(all).not.toContain(secret);
    expect(all).not.toContain("big.bin");
    if (c !== host) expect(all).not.toContain(hostSecret);
  }
  // Nothing about the wall was written to browser storage.
  for (const p of [host.page, a.page, b.page]) {
    const stored = await p.evaluate(async () => {
      const ls = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      const dbs = (await indexedDB.databases?.())?.map((d) => d.name) ?? [];
      return { ls, dbs };
    });
    expect(stored.ls).not.toContain(key);
    expect(stored.ls).not.toContain(secret);
    expect(stored.dbs.filter((n) => /wall/i.test(n ?? ""))).toEqual([]);
  }

  // A peer can leave: it wipes its copy, the others keep going.
  b.page.removeAllListeners("dialog");
  b.page.once("dialog", (d) => void d.accept());
  await b.page.getByTestId("wall-leave").click();
  await expect(b.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "left");
  await expect(host.page.getByTestId("wall-host")).toHaveAttribute("data-peers", "1");

  // Kill switch: the host destroys the wall, peers wipe, the relay closes the room.
  host.page.once("dialog", (d) => void d.accept());
  await host.page.getByTestId("wall-destroy").click();
  await expect(host.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed");
  await expect(a.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
  await expect(a.page.getByTestId("wall-item")).toHaveCount(0);
  expect(await guarded(host.page)).toBe(false);
  // The link is dead: a new visitor gets "destroyed" from the relay.
  await b.page.goto("about:blank");
  await b.page.goto(local(link));
  await expect(b.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
});

test("password + burn after one download; the host sees the item disappear", async ({ browser }) => {
  test.setTimeout(90_000);
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { burn: true, password: "pa55-wall" });
  expect(link).toMatch(/\/p1h$/);
  expect(link).not.toContain("pa55-wall");
  const [a, b] = await Promise.all([newPage(browser), newPage(browser)]);

  // Wrong password is refused, the right one joins.
  await a.page.goto(local(link));
  await a.page.getByTestId("drop-password-input").fill("wrong");
  await a.page.getByTestId("drop-password-submit").click();
  await expect(a.page.getByTestId("drop-password-gate").getByRole("alert")).toBeVisible({ timeout: 20_000 });
  await a.page.getByTestId("drop-password-input").fill("pa55-wall");
  await a.page.getByTestId("drop-password-submit").click();
  await expect(a.page.getByTestId("wall-peer-status")).toHaveAttribute("data-status", "online", { timeout: 20_000 });
  await join(b.page, link, "pa55-wall");

  const payload = randomBytes(200 * 1024);
  await a.page.getByTestId("wall-file-input").setInputFiles([{ name: "once.bin", mimeType: "application/octet-stream", buffer: payload }]);
  for (const p of [host.page, a.page, b.page]) await expect(item(p, "once.bin")).toHaveCount(1, { timeout: 20_000 });

  // The author re-downloading its own item does not burn it.
  const own = a.page.waitForEvent("download");
  await item(a.page, "once.bin").getByTestId("wall-download").click();
  await own;
  await expect(item(host.page, "once.bin")).toHaveCount(1);

  // B downloads it (after a confirmation): gone from the wall for everyone else.
  let confirmText = "";
  b.page.once("dialog", (d) => {
    confirmText = d.message();
    void d.accept();
  });
  const dl = b.page.waitForEvent("download");
  await item(b.page, "once.bin").getByTestId("wall-download").click();
  expect(sha(readFileSync((await (await dl).path())!))).toBe(sha(payload));
  expect(confirmText).toContain("s'autodétruit");
  await expect(item(host.page, "once.bin")).toHaveCount(0, { timeout: 10_000 });
  // Those who already fetched it (B, and A who re-downloaded its own file) keep a
  // local in-memory copy, marked as such, until the wall is wiped.
  await expect(item(b.page, "once.bin").locator(".sw-chip")).toBeVisible();
  await expect(item(a.page, "once.bin").locator(".sw-chip")).toBeVisible({ timeout: 10_000 });

  host.page.once("dialog", (d) => void d.accept());
  await host.page.getByTestId("wall-destroy").click();
  await expect(b.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
});

test("TTL expiry (fake clock) wipes host and peers", async ({ browser }) => {
  test.setTimeout(90_000);
  const host = await newPage(browser, { fakeClock: true });
  const { link } = await createWall(host.page, { ttl: "m15", hostLeave: false });
  const a = await newPage(browser, { fakeClock: true });
  await join(a.page, link);
  await a.page.getByTestId("wall-text").fill("éphémère");
  await a.page.getByTestId("wall-text-submit").click();
  await expect(snippet(host.page)).toHaveCount(1, { timeout: 15_000 });
  await expect(host.page.getByTestId("wall-countdown")).toContainText(/1[45]:\d\d/);

  await a.page.clock.fastForward("16:00");
  await host.page.clock.fastForward("16:00");
  await expect(a.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "expired", { timeout: 10_000 });
  await expect(host.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "expired", { timeout: 10_000 });
  await expect(a.page.getByTestId("wall-item")).toHaveCount(0);
});

test("destroy-on-host-leave: closing the host tab wipes every peer", async ({ browser }) => {
  test.setTimeout(90_000);
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { ttl: "h1" }); // option on by default
  expect(link).toMatch(/\/nh$/);
  const [a, b] = await Promise.all([newPage(browser), newPage(browser)]);
  await join(a.page, link);
  await join(b.page, link);
  await a.page.getByTestId("wall-file-input").setInputFiles([{ name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  await expect(item(b.page, "x.txt")).toHaveCount(1, { timeout: 15_000 });
  await host.page.close({ runBeforeUnload: false });
  for (const p of [a.page, b.page]) {
    await expect(p.getByTestId("wall-ended")).toHaveAttribute("data-reason", "host-left", { timeout: 15_000 });
    await expect(p.getByTestId("wall-item")).toHaveCount(0);
  }
  // After the grace period the relay has closed the room for good.
  await a.page.waitForTimeout(1500);
  await a.page.goto("about:blank");
  await a.page.goto(local(link));
  await expect(a.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
});
