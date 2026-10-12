/**
 * E2E: browser-only send flow (production reality — no Holochain conductor).
 *
 * Regression test for the "click Send → nothing happens" bug: a leftover
 * `if (!writeReady) return` guard blocked the self-contained link path in
 * SendWorkspace before createWebLink() could run.
 */
import { test, expect } from "@playwright/test";

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

    await page.getByRole("button", { name: /Créer le Magic Link|Create Magic Link/i }).click();

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

    await page.getByRole("button", { name: /Créer le Magic Link|Create Magic Link/i }).click();

    const linkInput = page.locator(".v3-link-row input");
    await expect(linkInput).toBeVisible({ timeout: 30_000 });
    expect(await linkInput.inputValue()).toContain("#slp=");
  });

  test("shows validation feedback when the recipient is missing", async ({ page }) => {
    await page.goto("/");

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "e2e-test.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("x"),
    });

    await page.getByRole("button", { name: /Créer le Magic Link|Create Magic Link/i }).click();

    await expect(
      page.getByText(/valid email or phone|email ou un téléphone valide/i),
    ).toBeVisible();
  });
});
