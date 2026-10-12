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
});
