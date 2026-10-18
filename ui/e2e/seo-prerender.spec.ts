import { test, expect } from "@playwright/test";

test("without JavaScript (crawlers, AI fetchers) the home page has real content", async ({ browser }) => {
  const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("Partage instantané et confidentiel, sans compte ni cloud.");
  await expect(page.locator('[data-prerender="home"] li')).toHaveCount(8);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://filenymous.eu/app/");
  await expect(page.locator('link[hreflang="en"]')).toHaveAttribute("href", "https://filenymous.eu/app/en/");
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(ld.map((s) => JSON.parse(s)["@type"])).toEqual(["WebApplication", "FAQPage"]);
});

test("with JavaScript the app replaces the prerendered content", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("dropzone")).toBeVisible();
  await expect(page.locator('[data-prerender="home"]')).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCount(1);
  await page.goto("/#secret-new");
  await expect(page.locator('[data-prerender="home"]')).toHaveCount(0);
});
