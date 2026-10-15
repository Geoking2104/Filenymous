/**
 * E2E: Secrets Vault (burn-after-reading) against a locally started
 * p2p-signal relay with the in-memory store.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 20789 + Math.floor(Math.random() * 1000);
const API = `http://127.0.0.1:${PORT}`;
let relay: ChildProcess;

test.beforeAll(async () => {
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], {
    env: { ...process.env, PORT: String(PORT), REDIS_URL: "", VAULT_CREATE_PER_MIN: "1000", VAULT_READ_PER_MIN: "1000" },
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

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  await page.addInitScript((url) => {
    (window as unknown as { __FILENYMOUS_VAULT_URL__: string }).__FILENYMOUS_VAULT_URL__ = url;
  }, API);
  return page;
}

const local = (link: string) => link.replace(/^https?:\/\/[^/]+/, "");

async function create(page: Page, secret: string, opts: { password?: string; hours?: number } = {}) {
  await page.goto("/");
  await page.getByTestId("vault-entry").click();
  await page.getByTestId("vault-text").fill(secret);
  if (opts.hours) {
    await page.getByTestId("vault-mode-ttl").check();
    await page.getByTestId("vault-hours").fill(String(opts.hours));
  }
  if (opts.password) await page.getByTestId("vault-password").fill(opts.password);
  await page.getByRole("button", { name: /Générer le lien secret|Generate secret link/ }).click();
  const link = await page.getByTestId("vault-link").inputValue();
  expect(link).toMatch(/#s:[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{43}$/);
  return link;
}

test("one-time secret: explicit click, display, copy, then gone on reload", async ({ browser }) => {
  const sender = await newPage(browser);
  const secret = "ghp_ABCdef123\nsecond line";
  const link = await create(sender, secret);
  expect(await sender.evaluate(() => navigator.clipboard.readText())).toBe(link); // auto-copied

  const reader = await newPage(browser);
  await reader.goto(local(link));
  // Opening the link (like a previewer would) consumes nothing.
  await expect(reader.getByTestId("vault-show")).toBeVisible();
  await reader.reload();
  await reader.getByRole("button", { name: /Afficher le secret|Show secret/ }).click();
  await expect(reader.getByTestId("vault-secret")).toHaveText(secret);
  expect(reader.url()).not.toContain(link.split("/").pop()!); // key stripped from the address bar
  await reader.getByTestId("vault-copy").click();
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe(secret);

  await reader.reload();
  await expect(reader.getByTestId("vault-gone")).toHaveText(/Ce secret a déjà été consulté ou a expiré|already been viewed/);
  const other = await newPage(browser);
  await other.goto(local(link));
  await expect(other.getByTestId("vault-gone")).toBeVisible();
});

test("password: a wrong password does not burn the secret", async ({ browser }) => {
  const link = await create(await newPage(browser), "s3cr3t", { password: "bonne" });
  const reader = await newPage(browser);
  await reader.goto(local(link));
  await reader.getByTestId("vault-reveal-password").fill("mauvaise");
  await reader.getByTestId("vault-show").click();
  await expect(reader.getByTestId("vault-bad-password")).toBeVisible();
  await reader.getByTestId("vault-reveal-password").fill("bonne");
  await reader.getByTestId("vault-show").click();
  await expect(reader.getByTestId("vault-secret")).toHaveText("s3cr3t");
});

test("time-limited secret can be read several times", async ({ browser }) => {
  const link = await create(await newPage(browser), "multi", { hours: 2 });
  for (let i = 0; i < 2; i++) {
    const reader = await newPage(browser);
    await reader.goto(local(link));
    await reader.getByTestId("vault-show").click();
    await expect(reader.getByTestId("vault-secret")).toHaveText("multi");
  }
});

test("the reveal page applies a strict CSP", async ({ browser }) => {
  const link = await create(await newPage(browser), "csp");
  const reader = await newPage(browser);
  await reader.goto(local(link));
  await expect(reader.getByTestId("vault-show")).toBeVisible();
  const csp = await reader.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"));
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain(`connect-src 'self' ${API}`);
  const blocked = await reader.evaluate(() => fetch("https://example.com/").then(() => false, () => true));
  expect(blocked).toBe(true);
});
