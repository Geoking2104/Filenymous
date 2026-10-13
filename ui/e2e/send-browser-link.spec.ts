/**
 * E2E: browser-only send flow (production reality — no Holochain conductor).
 *
 * Regression coverage for the "click Send → nothing happens" bug family:
 *  1. a leftover `if (!writeReady) return` guard blocked the link path;
 *  2. filling only the optional "send by email" section (and leaving the
 *     required recipient empty) also blocked link creation.
 */
import { test, expect } from "@playwright/test";

const SEND_BTN = /Créer (le )?Magic ?Link|Create (encrypted )?Magic ?Link/;
const LIVE = process.env.FILENYMOUS_LIVE === "1";

test.describe("Send — self-contained encrypted link (no conductor)", () => {
  test("creates a plain #sl= link on click", async ({ page }) => {
    await page.goto("/");

    // The browser-only banner confirms runtime detection settled.
    await expect(page.getByText(/Mode navigateur|Browser-only mode/i).first()).toBeVisible();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "e2e-test.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello from e2e — filenymous ".repeat(10)),
    });

    await page.locator('input[type="text"]').first().fill("test@example.com");

    await page.getByRole("button", { name: SEND_BTN }).click();

    const linkInput = page.locator(".v3-link-row input");
    await expect(linkInput).toBeVisible({ timeout: 30_000 });
    const link = await linkInput.inputValue();
    expect(link).toContain("#sl=");
    expect(link).not.toContain("#slp=");
  });

  test("creates a password-protected #slp= link when the password option is on", async ({
    page,
  }) => {
    await page.goto("/");

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "e2e-secret.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("top secret"),
    });

    await page.locator('input[type="text"]').first().fill("test@example.com");

    await page.getByLabel(/Protéger par mot de passe|Protect with a password/i).check();
    await page.locator('input[type="password"]').fill("hunter22pass");

    await page.getByRole("button", { name: SEND_BTN }).click();

    const linkInput = page.locator(".v3-link-row input");
    await expect(linkInput).toBeVisible({ timeout: 30_000 });
    expect(await linkInput.inputValue()).toContain("#slp=");
  });

  test("fills the recipient from the 'send by email' section alone", async ({ page }) => {
    await page.goto("/");

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "e2e-emailto.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hi"),
    });

    // Open the optional email section and fill the recipient email there only
    // (the required "Email ou téléphone" field stays empty on purpose).
    await page.getByText(/Envoi par email|Send by email/i).click();
    await page.locator('.v3-field input[type="email"]').nth(1).fill("dest@example.com");

    // The recipient field should mirror the value…
    await expect(page.locator('input[type="text"]').first()).toHaveValue("dest@example.com");

    // …and clicking Send must produce the link.
    await page.getByRole("button", { name: SEND_BTN }).click();
    const linkInput = page.locator(".v3-link-row input");
    await expect(linkInput).toBeVisible({ timeout: 30_000 });
    expect(await linkInput.inputValue()).toContain("#sl=");
  });

  test("shows validation feedback when the recipient is missing", async ({ page }) => {
    await page.goto("/");

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "e2e-test.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("x"),
    });

    await page.getByRole("button", { name: SEND_BTN }).click();

    await expect(
      page.getByText(/valid email or phone|email ou un téléphone valide/i),
    ).toBeVisible();
  });

  test("renders the result for a long link without a QR crash", async ({ page }) => {
    await page.goto("/");

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "e2e-big.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(4096, 7),
    });

    await page.locator('input[type="text"]').first().fill("test@example.com");
    await page.getByRole("button", { name: SEND_BTN }).click();

    const linkInput = page.locator(".v3-link-row input");
    await expect(linkInput).toBeVisible({ timeout: 30_000 });
    const link = await linkInput.inputValue();
    expect(link.length).toBeGreaterThan(2900);
    await expect(page.getByText(/too long for a QR|trop long pour un QR/i)).toBeVisible();
  });

  test("email handoff: copying works and the page never navigates away", async ({ page }) => {
    await page.goto("/");
    const origin = new URL(page.url()).origin;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "e2e-mail.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("mail handoff test"),
    });

    await page.locator('input[type="text"]').first().fill("dest@example.com");
    await page.getByRole("button", { name: SEND_BTN }).click();

    const linkInput = page.locator(".v3-link-row input");
    await expect(linkInput).toBeVisible({ timeout: 30_000 });

    // Copy the ready-to-send email.
    const copyBtn = page.getByRole("button", { name: /Copier l'email|Copy the email/i });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("#sl=");
    expect(clip).toMatch(/Objet|Subject/);

    // The open button is a new-tab link — the app page must stay put.
    const openLink = page.getByRole("link", {
      name: /Ouvrir mon application email|Open my email app/i,
    });
    await expect(openLink).toBeVisible();
    await openLink.click();
    await page.waitForTimeout(800);
    expect(page.url()).not.toContain("about:blank");
    expect(page.url().startsWith(origin)).toBe(true);
  });

  test("receipt: opening and downloading a link reports to the sender tracker", async ({
    page,
    request,
  }) => {
    test.skip(!LIVE, "requires live deployment (FILENYMOUS_LIVE=1)");
    await page.goto("/");

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "e2e-rcpt.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("receipt end-to-end test"),
    });

    await page.locator('input[type="text"]').first().fill("test@example.com");
    await page.getByRole("button", { name: SEND_BTN }).click();

    const linkInput = page.locator(".v3-link-row input");
    await expect(linkInput).toBeVisible({ timeout: 30_000 });
    const link = await linkInput.inputValue();

    const frag = new URL(link).hash.slice(1);
    const rid = frag.slice(3).split(".")[3];
    expect(rid).toMatch(/^[A-Za-z0-9_-]{16}$/);

    // The sender screen must show the tracking widget.
    await expect(page.getByText(/Suivi de réception|Delivery tracking/i)).toBeVisible();

    // Open the link as the recipient and complete the download.
    await page.goto(link);
    const dl = page.getByRole("button", { name: /Télécharger|Download/i }).first();
    await expect(dl).toBeVisible({ timeout: 30_000 });
    await dl.click();
    await expect(page.getByText(/téléchargé|downloaded/i).first()).toBeVisible({
      timeout: 30_000,
    });

    // Give the beacons a moment, then check the status endpoint.
    await page.waitForTimeout(1500);
    const res = await request.get(`https://filenymous.eu/rcpt/status.php?id=${rid}`);
    expect(res.ok()).toBeTruthy();
    const j = (await res.json()) as {
      ok: boolean;
      open?: number | null;
      download?: number | null;
    };
    expect(j.ok).toBe(true);
    expect(j.open).toBeTruthy();
    expect(j.download).toBeTruthy();
  });
});
