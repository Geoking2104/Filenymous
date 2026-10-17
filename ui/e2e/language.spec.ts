import { test, expect } from "@playwright/test";

const FR = "Partagez en toute confiance, sans compte ni nuage.";
const EN = "Share with confidence, no account, no cloud.";

for (const [locale, title, lang] of [["en-US", EN, "en"], ["en-GB", EN, "en"], ["fr-FR", FR, "fr"], ["fr-CA", FR, "fr"], ["de-DE", FR, "fr"]] as const) {
  test(`hero follows a ${locale} browser`, async ({ browser }) => {
    const page = await (await browser.newContext({ locale })).newPage();
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText(title);
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
  });
}

test("?lang= overrides the browser language", async ({ browser }) => {
  const page = await (await browser.newContext({ locale: "fr-FR" })).newPage();
  await page.goto("/?lang=en");
  await expect(page.locator("h1")).toHaveText(EN);
  await page.goto("/?lang=fr");
  await expect(page.locator("h1")).toHaveText(FR);
});
