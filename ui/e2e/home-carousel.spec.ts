import { expect, test } from "@playwright/test";

test.describe("home services carousel", () => {
  test("arrows, dots, keyboard and coming-soon teaser", async ({ page }) => {
    await page.goto("/");
    const carousel = page.getByTestId("services-carousel");
    await expect(carousel.locator("article.pz-service")).toHaveCount(7);
    const dots = page.getByTestId("carousel-dot");
    await expect(dots).toHaveCount(7);
    await expect(page.getByTestId("carousel-prev")).toBeDisabled();
    await page.getByTestId("carousel-next").click();
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true");
    await dots.nth(6).click();
    await expect(page.getByTestId("soon-stream")).toBeInViewport();
    const track = carousel.locator(".pz-carousel-track");
    await track.focus();
    await page.keyboard.press("Home");
    await expect(dots.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("dropzone")).toBeInViewport();
    await dots.nth(3).click();
    const teaserBtn = page.getByTestId("soon-whistle").getByRole("button");
    await teaserBtn.click();
    await expect(teaserBtn).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("soon-whistle").locator(".pz-teaser")).toBeVisible();
    await expect(page.getByTestId("pro-entry")).toHaveAttribute("href", "#drop-new");
  });
});
