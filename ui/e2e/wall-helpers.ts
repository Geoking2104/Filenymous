/** Shared helpers for the Sharewall e2e specs (local relay, contexts, wall setup). */
import { expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));

export interface Relay {
  port: number;
  url: string;
  proc: ChildProcess;
}

export async function startRelay(env: Record<string, string> = {}): Promise<Relay> {
  const port = 21789 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], {
    env: { ...process.env, PORT: String(port), STUN_URLS: "", RATE_LIMIT_MAX_MESSAGES: "5000", WALL_HOST_GRACE_MS: "800", WALL_SWEEP_MS: "500", ...env },
    stdio: "pipe",
  });
  await new Promise<void>((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    proc.stdout!.on("data", (d) => {
      if (String(d).includes("listening")) {
        clearTimeout(t);
        ok();
      }
    });
  });
  return { port, url: `ws://127.0.0.1:${port}`, proc };
}

export const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const local = (link: string) => link.replace(/^https?:\/\/[^/]+/, "");
export const fixture = (n: string) => readFileSync(resolve(here, "fixtures", n));

export interface Ctx {
  page: Page;
  sent: string[];
}

export async function newPage(browser: Browser, signal: string, opts: { fakeClock?: boolean; viewport?: { width: number; height: number }; colorScheme?: "light" | "dark" } = {}): Promise<Ctx> {
  const context = await browser.newContext({
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}),
  });
  const page = await context.newPage();
  if (opts.fakeClock) await page.clock.install();
  await page.addInitScript((url) => {
    (window as unknown as { __FILENYMOUS_SIGNAL_URL__: string }).__FILENYMOUS_SIGNAL_URL__ = url;
  }, signal);
  // Everything the page sends to the relay, to prove the key never leaves the fragment.
  const sent: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => sent.push(String(f.payload))));
  return { page, sent };
}

/** True when closing the tab right now would trigger the beforeunload prompt. */
export async function guarded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
}

export interface CreateWallOpts {
  /** Wall display name typed in the create form. */
  name?: string;
  burn?: boolean;
  password?: string;
  agents?: boolean;
  /**
   * Legacy link (created before walls lost their expiry): opens a host link
   * built here, with an expiry and/or without "destroy when the host leaves".
   * The create form can no longer produce these, but such links stay valid.
   */
  legacy?: { ttlMs?: number; hostLeave?: boolean };
}

export async function createWall(host: Page, opts: CreateWallOpts = {}) {
  if (opts.legacy) {
    const b64 = (n: number) => randomBytes(n).toString("base64url");
    const exp = opts.legacy.ttlMs ? Math.floor((Date.now() + opts.legacy.ttlMs) / 1000).toString(36) : "0";
    const flags = `${opts.password ? "p" : "n"}${opts.burn ? "1" : ""}${opts.legacy.hostLeave ? "h" : ""}`;
    await host.goto(`/#wall-host:${b64(24)}/${b64(32)}/${exp}/${flags}`);
    if (opts.password) {
      await host.getByTestId("drop-password-input").fill(opts.password);
      await host.getByTestId("drop-password-submit").click();
    }
  } else {
    await host.goto("/#wall-new");
    if (opts.name) await host.getByTestId("wall-name").fill(opts.name);
    if (opts.burn) await host.getByTestId("wall-burn").check();
    if (opts.agents) await host.getByTestId("wall-agents").check();
    if (opts.password) await host.getByTestId("wall-password").fill(opts.password);
    // Creating requires the explicit "leaving destroys the wall" acknowledgement.
    await expect(host.getByTestId("wall-create-submit")).toBeDisabled();
    await host.getByTestId("wall-ack-leave").check();
    await host.getByTestId("wall-create-submit").click();
  }
  await expect(host.getByTestId("wall-keep-open")).toBeVisible();
  await expect(host.getByTestId("wall-host-status")).toHaveAttribute("data-status", "online", { timeout: 15_000 });
  const link = await host.getByTestId("wall-link").inputValue();
  return { link, hostUrl: host.url() };
}

/** Answers the shared in-app "close this window?" dialog. */
export async function answerLeave(page: Page, confirm: boolean) {
  const dialog = page.getByTestId("leave-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("leave-message")).toContainText(/fermer la fenêtre|close this window/);
  await page.getByTestId(confirm ? "leave-confirm" : "leave-cancel").click();
  await expect(dialog).toHaveCount(0);
}

export async function join(peer: Page, link: string, password?: string) {
  await peer.goto(local(link));
  if (password) {
    await peer.getByTestId("drop-password-input").fill(password);
    await peer.getByTestId("drop-password-submit").click();
  }
  await expect(peer.getByTestId("wall-peer-status")).toHaveAttribute("data-status", "online", { timeout: 20_000 });
}

export async function sendNote(p: Page, text: string) {
  await p.getByTestId("wall-note-toggle").click();
  await p.getByTestId("wall-text").fill(text);
  await p.getByTestId("wall-text-submit").click();
  await expect(p.getByTestId("wall-text")).toHaveCount(0);
}

export async function say(p: Page, text: string) {
  await p.getByTestId("wall-msg-input").fill(text);
  await p.getByTestId("wall-msg-input").press("Enter");
}

export const items = (p: Page) => p.getByTestId("wall-grid").getByTestId("wall-item");
export const item = (p: Page, name: string) => p.locator(`[data-testid="wall-item"][data-name="${name}"]`);
export const snippet = (p: Page) => p.locator('[data-testid="wall-item"][data-kind="text"]');
export const msg = (p: Page, text: string) => p.getByTestId("wall-msg").filter({ hasText: text });
