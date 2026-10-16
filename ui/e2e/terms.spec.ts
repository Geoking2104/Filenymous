import { test, expect } from "@playwright/test";

test("terms of use modal opens from the footer and the review step, FR and EN", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("filenymous.lng", "fr"));
  await page.reload();
  await page.getByTestId("terms-link").click();
  const modal = page.getByTestId("terms-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Conditions d’utilisation Filenymous");
  await expect(modal.locator(".pz-term")).toHaveCount(4);
  await expect(modal.locator("em")).toHaveText("En envoyant un fichier, vous confirmez avoir compris et accepté ces conditions.");
  await page.screenshot({ path: "/workspace/filenymous-terms.png", fullPage: true });
  await page.getByRole("button", { name: "Compris !" }).click();
  await expect(modal).toBeHidden();

  // Legal notice has a terms section.
  await page.getByTestId("legal").locator("summary").click();
  await expect(page.getByTestId("legal")).toContainText("Conditions d’utilisation");

  // Line under the Start button opens the same modal.
  await page.locator('input[type="file"]').first().setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") });
  await expect(page.getByTestId("terms-note")).toContainText("En envoyant, vous acceptez les");
  await page.getByTestId("terms-note").getByRole("button").click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  // English.
  await page.getByRole("button", { name: "EN" }).click();
  await page.getByTestId("terms-link").click();
  await expect(modal).toContainText("Filenymous terms of use");
  await expect(page.getByRole("button", { name: "Got it!" })).toBeVisible();
});
