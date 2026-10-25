/**
 * Receiver opens a link whose sender is gone: after a short wait the page
 * explains why and offers to retry or type another code (no endless spinner).
 * Local relay; the wait is shortened through a test-only window override.
 */
import { expect, test } from "@playwright/test";
import { startRelay, type Relay } from "./wall-helpers";

let relay: Relay;
test.beforeAll(async () => {
  relay = await startRelay();
});
test.afterAll(() => relay?.proc.kill());

for (const lang of ["fr-FR", "en-US"]) {
  test(`no sender: clear message, retry and "another code" (${lang})`, async ({ browser }) => {
    const ctx = await browser.newContext({ locale: lang });
    const page = await ctx.newPage();
    await page.addInitScript((url) => {
      const w = window as unknown as Record<string, unknown>;
      w.__FILENYMOUS_SIGNAL_URL__ = url;
      w.__FILENYMOUS_TEST_NO_SENDER_MS__ = 1500;
    }, relay.url);
    // Random, never-announced code + secret (not a real share).
    await page.goto("/#p2p:739-284-QXZ/Zm9vYmFyYmF6cXV4MTIzNDU2");
    await expect(page.getByTestId("p2p-no-sender")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("p2p-no-sender")).toHaveAttribute("role", "alert");
    await expect(page.getByTestId("p2p-no-sender-retry")).toBeVisible();
    await page.getByTestId("p2p-other-code").click();
    await expect(page).not.toHaveURL(/#p2p:/);
    await expect(page.locator("#pz-home-code")).toBeFocused({ timeout: 5_000 });
    await ctx.close();
  });
}
