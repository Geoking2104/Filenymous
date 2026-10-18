import { expect, test } from "@playwright/test";

test.describe("home services carousel", () => {
  test("arrows, dots, keyboard and whistleblowing card", async ({ page }) => {
    await page.goto("/");
    const carousel = page.getByTestId("services-carousel");
    await expect(carousel.locator("article.pz-service")).toHaveCount(8);
    const dots = page.getByTestId("carousel-dot");
    await expect(dots).toHaveCount(8);
    await expect(page.getByTestId("carousel-prev")).toBeDisabled();
    await page.getByTestId("carousel-next").click();
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true");
    await dots.nth(7).click();
    await expect(page.locator("article.pz-service--stream")).toBeInViewport();
    const track = carousel.locator(".pz-carousel-track");
    await track.focus();
    await page.keyboard.press("Home");
    await expect(dots.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("dropzone")).toBeInViewport();
    await dots.nth(2).click();
    await expect(page.getByTestId("wall-card")).toContainText("Nouveau");
    await expect(page.getByTestId("wall-entry")).toHaveAttribute("href", "#wall-new");
    await dots.nth(4).click();
    const whistle = page.getByTestId("whistle-card");
    await expect(whistle).toContainText("Nouveau");
    await expect(whistle.locator(".pz-teaser")).toContainText("Sapin II");
    await expect(page.getByTestId("report-entry")).toHaveAttribute("href", "#report-new");
    await expect(page.locator(".is-soon")).toHaveCount(0);
    await expect(page.getByTestId("pro-entry")).toHaveAttribute("href", "#drop-new");
    await expect(page.getByTestId("cli-docs")).toHaveAttribute("href", /\/cli#readme$/);
    await expect(page.getByTestId("soon-cli")).toHaveCount(0);
  });
});
