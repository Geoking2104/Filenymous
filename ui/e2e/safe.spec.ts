/**
 * Coffre-fort (persistent personal vault) e2e: onboarding with the 24-word
 * phrase check, items, ⌘K palette + clipboard ring, lock / unlock, phrase
 * recovery, P2P share between two browser contexts over the local relay, and a
 * concurrent-edit conflict resolved side by side.
 *
 * Every value typed here is a throwaway demo value; screenshots keep the
 * recovery phrase blurred and never show a revealed secret.
 *
 *   SAFE_BASE_URL=https://filenymous.eu/app/   run against the live site (uses its relay)
 *   SAFE_SHOTS=/path                           where to write the screenshots
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startRelay, type Relay } from "./wall-helpers";

const BASE = process.env.SAFE_BASE_URL ?? "/";
const SHOTS = process.env.SAFE_SHOTS ?? "test-results/safe-shots";
const LIVE = !!process.env.SAFE_BASE_URL;
const PW_A = "correct horse battery staple demo";
const PW_A2 = "violet lantern quietly sixteen orbit";
const PW_B = "maple circuit harbor vivid demo";

mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });

async function newVaultPage(browser: Browser, relay?: Relay, viewport = { width: 1280, height: 860 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, permissions: ["clipboard-read", "clipboard-write"], locale: "fr-FR" });
  const page = await ctx.newPage();
  if (relay)
    await page.addInitScript((url) => {
      (window as unknown as { __FILENYMOUS_SIGNAL_URL__: string }).__FILENYMOUS_SIGNAL_URL__ = url;
    }, relay.url);
  page.on("dialog", (d) => void d.accept());
  return page;
}

async function openSafe(page: Page) {
  await page.goto(`${BASE}#safe`);
  await expect(page.getByTestId("cf-onboarding").or(page.getByTestId("cf-unlock")).or(page.getByTestId("cf-vault"))).toBeVisible({ timeout: 30_000 });
}

/** Full onboarding; returns the 24 words (read from the DOM, never logged). */
async function onboard(page: Page, password: string, shots = false): Promise<string[]> {
  await openSafe(page);
  await expect(page.getByTestId("cf-onboarding")).toBeVisible();
  if (shots) await shot(page, "01-onboarding");
  await page.getByTestId("cf-start").click();
  await page.getByTestId("cf-master").fill(password);
  await page.getByTestId("cf-master2").fill(password);
  await expect(page.getByTestId("cf-create")).toBeEnabled();
  await page.getByTestId("cf-create").click();
  await expect(page.getByTestId("cf-phrase")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("cf-noreset")).toBeVisible();
  const words = await page.locator('[data-testid^="cf-word-"] span').allTextContents();
  expect(words).toHaveLength(24);
  // Blurred until clicked.
  const filter = await page.locator('[data-testid="cf-word-0"] span').evaluate((el) => getComputedStyle(el).filter);
  expect(filter).toContain("blur");
  if (shots) await shot(page, "02-phrase-blurred");
  await page.getByTestId("cf-phrase-ack").check();
  await page.getByTestId("cf-phrase-next").click();
  await expect(page.getByTestId("cf-check")).toBeVisible();
  // Wrong answer first.
  for (let i = 0; i < 3; i++) await page.getByTestId(`cf-check-${i}`).fill("zzz");
  await page.getByTestId("cf-check-submit").click();
  await expect(page.getByTestId("cf-check-err")).toBeVisible();
  for (let i = 0; i < 3; i++) {
    const input = page.getByTestId(`cf-check-${i}`);
    const pos = Number(await input.getAttribute("data-pos"));
    await input.fill(words[pos]!);
  }
  if (shots) await shot(page, "03-phrase-check");
  await page.getByTestId("cf-check-submit").click();
  await expect(page.getByTestId("cf-vault")).toBeVisible({ timeout: 30_000 });
  return words;
}

async function addLogin(page: Page, v: { title: string; username: string; password: string; url?: string; notes?: string }) {
  await page.getByTestId("cf-new").click();
  await page.getByTestId("cf-new-login").click();
  await page.getByTestId("cf-f-title").fill(v.title);
  await page.getByTestId("cf-f-username").fill(v.username);
  await page.getByTestId("cf-f-password").fill(v.password);
  if (v.url) await page.getByTestId("cf-f-url").fill(v.url);
  if (v.notes) await page.getByTestId("cf-f-notes").fill(v.notes);
  await page.getByTestId("cf-save").click();
  await expect(page.getByTestId("cf-detail-title")).toHaveText(v.title, { timeout: 15_000 });
}

async function unlock(page: Page, password: string) {
  await expect(page.getByTestId("cf-unlock")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("cf-unlock-pw").fill(password);
  await page.getByTestId("cf-unlock-submit").click();
  await expect(page.getByTestId("cf-vault")).toBeVisible({ timeout: 30_000 });
}

test.describe("coffre-fort", () => {
  test.describe.configure({ timeout: 180_000 });

  test("onboarding, items, ⌘K, clipboard, lock, phrase recovery", async ({ browser }) => {
    const page = await newVaultPage(browser);
    const words = await onboard(page, PW_A, true);

    await addLogin(page, { title: "GitHub (démo)", username: "alice@example.test", password: "demo-Password-1234", url: "https://github.com", notes: "Compte de démonstration" });
    await addLogin(page, { title: "Banque (démo)", username: "alice.demo", password: "demo-Password-1234" });
    await page.getByTestId("cf-new").click();
    await page.getByTestId("cf-new-note").click();
    await page.getByTestId("cf-f-title").fill("Wi-Fi maison (démo)");
    await page.getByTestId("cf-f-notes").fill("Réseau : demo-ssid");
    await page.getByTestId("cf-save").click();
    await expect(page.getByTestId("cf-item")).toHaveCount(3);

    // Secret masked by default; reveal shows a 10 s ring; history has 1 version.
    await page.getByTestId("cf-item").filter({ hasText: "GitHub" }).click();
    await expect(page.getByTestId("cf-val-password")).not.toContainText("demo-Password");
    await page.getByTestId("cf-reveal-password").click();
    await expect(page.getByTestId("cf-val-password")).toHaveText("demo-Password-1234");
    await expect(page.getByTestId("cf-detail").getByTestId("cf-ring")).toBeVisible();
    await page.getByTestId("cf-hide-password").click();
    await expect(page.getByTestId("cf-val-password")).not.toContainText("demo-Password");
    await shot(page, "04-vault-list");

    // Edit creates a new version.
    await page.getByTestId("cf-edit").click();
    await page.getByTestId("cf-f-username").fill("alice+2@example.test");
    await page.getByTestId("cf-save").click();
    await expect(page.getByTestId("cf-detail")).toContainText("v2");

    // Security dashboard flags the reused password.
    await page.getByTestId("cf-tab-security").click();
    await expect(page.getByTestId("cf-security")).toContainText("Banque (démo)");
    await page.getByTestId("cf-tab-items").click();

    // ⌘K / Ctrl+K palette: search, copy with clear ring.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("cf-palette")).toBeVisible();
    await page.getByTestId("cf-pal-input").fill("git");
    await expect(page.getByTestId("cf-pal-row").first()).toContainText("GitHub");
    await shot(page, "05-palette");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("cf-palette")).toBeHidden();
    await expect(page.getByTestId("cf-clip")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("demo-Password-1234");
    await page.getByTestId("cf-clip-clear").click();
    await expect(page.getByTestId("cf-clip")).toBeHidden();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("");

    // Lock, wrong password, unlock.
    await page.getByTestId("cf-lock").click();
    await expect(page.getByTestId("cf-unlock")).toBeVisible();
    await page.getByTestId("cf-unlock-pw").fill("not the password");
    await page.getByTestId("cf-unlock-submit").click();
    await expect(page.getByTestId("cf-unlock-err")).toBeVisible({ timeout: 15_000 });
    await unlock(page, PW_A);
    await expect(page.getByTestId("cf-item")).toHaveCount(3);

    // Reload keeps the vault (persistent OPFS), locked.
    await page.reload();
    await unlock(page, PW_A);
    await expect(page.getByTestId("cf-item")).toHaveCount(3);

    // Forgot password → recovery phrase → new password.
    await page.getByTestId("cf-lock").click();
    await page.getByTestId("cf-forgot").click();
    await page.getByTestId("cf-phrase-input").fill(words.join(" "));
    await page.getByTestId("cf-phrase-submit").click();
    await expect(page.getByTestId("cf-newpw")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("cf-master").fill(PW_A2);
    await page.getByTestId("cf-master2").fill(PW_A2);
    await page.getByTestId("cf-newpw-submit").click();
    await expect(page.getByTestId("cf-vault")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("cf-lock").click();
    await unlock(page, PW_A2);
    await expect(page.getByTestId("cf-item")).toHaveCount(3);
    await page.context().close();
  });

  test("P2P share between two vaults, then a concurrent-edit conflict", async ({ browser }) => {
    test.skip(LIVE && !process.env.SAFE_LIVE_SHARE, "live share uses the production relay; opt in with SAFE_LIVE_SHARE=1");
    const relay = LIVE ? undefined : await startRelay();
    try {
      const a = await newVaultPage(browser, relay);
      if (process.env.SAFE_DEBUG) a.on("websocket", (ws) => { ws.on("close", () => console.log("A WS CLOSE", ws.url())); ws.on("framereceived", (f) => String(f.payload).includes("error") && console.log("A RX", String(f.payload).slice(0, 120))); });
      const b = await newVaultPage(browser, relay);
      await onboard(a, PW_A);
      await onboard(b, PW_B);
      await expect(a.getByTestId("cf-inbox")).toHaveAttribute("data-state", "online", { timeout: 20_000 });
      await expect(b.getByTestId("cf-inbox")).toHaveAttribute("data-state", "online", { timeout: 20_000 });

      // Alice adds Bob from his contact card (public keys only).
      await b.getByTestId("cf-tab-contacts").click();
      const card = await b.getByTestId("cf-my-card").inputValue();
      expect(card).toMatch(/^fny1\./);
      await a.getByTestId("cf-tab-contacts").click();
      await a.getByTestId("cf-contact-card").fill(card);
      await a.getByTestId("cf-contact-alias").fill("Bob");
      await a.getByTestId("cf-contact-add").click();
      await expect(a.getByTestId("cf-contacts")).toContainText("Bob");
      await a.getByTestId("cf-tab-items").click();
      await b.getByTestId("cf-tab-items").click();

      await addLogin(a, { title: "Serveur staging (démo)", username: "deploy", password: "demo-Staging-5678" });
      await a.getByTestId("cf-share").click();
      await expect(a.getByTestId("cf-share-dialog")).toBeVisible();
      await expect(a.getByTestId("cf-share-honest")).toContainText("pas par la cryptographie");
      await a.getByTestId("cf-role-editor").click();
      await a.getByTestId("cf-share-expiry").selectOption({ index: 3 });
      await shot(a, "06-share");
      await a.getByTestId("cf-share-send").click();
      await expect(a.getByTestId("cf-share-result")).toContainText("Bob", { timeout: 60_000 });

      // Bob doesn't know Alice yet: the share waits for his approval.
      await expect(b.getByTestId("cf-pending")).toBeVisible({ timeout: 15_000 });
      await b.getByTestId("cf-pending-alias").fill("Alice");
      await b.getByTestId("cf-pending-accept").click();
      await expect(b.getByTestId("cf-detail-title")).toHaveText("Serveur staging (démo)");
      await expect(b.getByTestId("cf-received-note")).toContainText("Alice");
      // Escape closes the share dialog (shared modal behaviour).
      await a.keyboard.press("Escape");
      await expect(a.getByTestId("cf-share-dialog")).toHaveCount(0);

      // Bob closes his vault; both edit the same item → concurrent versions.
      await b.getByTestId("cf-lock").click();
      await expect(b.getByTestId("cf-unlock")).toBeVisible();
      await a.getByTestId("cf-edit").click();
      await a.getByTestId("cf-f-password").fill("demo-Alice-edit-0001");
      await a.getByTestId("cf-save").click();
      await expect(a.getByTestId("cf-sync-failed")).toBeVisible({ timeout: 60_000 });

      await unlock(b, PW_B);
      await expect(b.getByTestId("cf-inbox")).toHaveAttribute("data-state", "online", { timeout: 20_000 });
      await b.getByTestId("cf-item").filter({ hasText: "Serveur staging" }).click();
      await b.getByTestId("cf-edit").click();
      await b.getByTestId("cf-f-username").fill("deploy-bob");
      await b.getByTestId("cf-save").click();

      await expect(a.getByTestId("cf-conflict-badge")).toBeVisible({ timeout: 60_000 });
      await expect(a.getByTestId("cf-conflict-badge")).toContainText("2");
      await a.getByTestId("cf-item").filter({ hasText: "Serveur staging" }).click();
      // Opening an item in conflict goes straight to the side-by-side view.
      await expect(a.getByTestId("cf-conflict-view")).toContainText("2 versions concurrentes détectées");
      await expect(a.getByTestId("cf-diff")).toContainText("deploy-bob");
      await shot(a, "07-conflict");
      // Manual merge: Bob's username + Alice's password.
      await a.getByTestId("cf-merge").click();
      await a.getByTestId("cf-pick-username-b").check();
      await a.getByTestId("cf-pick-password-a").check();
      await a.getByTestId("cf-merge-save").click();
      await expect(a.getByTestId("cf-conflict-badge")).toHaveCount(0, { timeout: 15_000 });
      await expect(a.getByTestId("cf-detail")).toContainText("deploy-bob");
      await a.getByTestId("cf-reveal-password").click();
      await expect(a.getByTestId("cf-val-password")).toHaveText("demo-Alice-edit-0001");
      await a.context().close();
      await b.context().close();
    } finally {
      relay?.proc.kill();
    }
  });

  test("mobile layout and one-time secret service untouched", async ({ browser }) => {
    const page = await newVaultPage(browser, undefined, { width: 390, height: 844 });
    await page.goto(`${BASE}#coffre`);
    await expect(page.getByTestId("cf-onboarding")).toBeVisible({ timeout: 30_000 });
    await page.goto(`${BASE}#secret-new`);
    await expect(page.getByTestId("service-head")).toHaveAttribute("data-service", "secret");
    await page.context().close();
  });

  test("contact invite link: public card only, verified handle, add in one step, backup reminder", async ({ browser }) => {
    test.skip(LIVE, "creates two throwaway vaults; local only");
    const a = await newVaultPage(browser);
    const b = await newVaultPage(browser);
    await onboard(a, PW_A);
    await onboard(b, PW_B);
    // Fresh vault: last backup "never" shown in settings; reminder appears once there is data.
    await expect(a.getByTestId("cf-backup-banner")).toHaveCount(0);
    await addLogin(a, { title: "Démo invitation", username: "demo", password: "demo-Invite-1234" });
    await expect(a.getByTestId("cf-backup-banner")).toBeVisible();
    await a.getByTestId("cf-backup-banner-later").click();
    await expect(a.getByTestId("cf-backup-banner")).toHaveCount(0);

    await a.getByTestId("cf-tab-contacts").click();
    const handleA = (await a.getByTestId("cf-my-handle").textContent())!.trim();
    await a.getByTestId("cf-invite-open").click();
    const url = await a.getByTestId("cf-invite-out-url").inputValue();
    expect(url).toMatch(/#safe-contact:fny1\.[A-Za-z0-9_-]+$/);
    await expect(a.getByTestId("cf-invite-out")).toBeVisible();

    // Bob opens the link (vault unlocked): he sees Alice's handle and adds her.
    await b.goto(url);
    await expect(b.getByTestId("cf-invite")).toBeVisible({ timeout: 15_000 });
    await expect(b.getByTestId("cf-invite-handle")).toHaveText(handleA);
    await expect(b.getByTestId("cf-invite-verify")).toBeVisible();
    expect(b.url()).not.toContain("safe-contact");
    await b.getByTestId("cf-invite-alias").fill("Alice");
    await b.getByTestId("cf-invite-accept").click();
    await expect(b.getByTestId("cf-invite-added")).toBeVisible();
    await expect(b.getByTestId("cf-contacts")).toContainText("Alice");
    // He can send his own link back.
    await expect(b.getByTestId("cf-invite-reply-url")).toHaveValue(/\/r$/);

    // Opening his own link only says it is his.
    await b.getByTestId("cf-invite-close").click();
    await b.getByTestId("cf-invite-open").click();
    const own = await b.getByTestId("cf-invite-out-url").inputValue();
    await b.goto(own);
    await expect(b.getByTestId("cf-invite-self")).toBeVisible({ timeout: 15_000 });
    await a.context().close();
    await b.context().close();
  });
});
