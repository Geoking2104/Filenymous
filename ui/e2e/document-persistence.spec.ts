/**
 * Browser memory of the Document tab (IndexedDB) and the "not exported" badge
 * on the logo, tab title and favicon. Screenshots with PERSIST_SHOTS=<dir>.
 */
import { expect, test, type Page } from "@playwright/test";

const shots = process.env.PERSIST_SHOTS;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNk+M9Qz0AEYBxVSF+FjP8ZGOqJUshAjEKGUYX0VUhfBQDuWBEJ8dUvAQAAAABJRU5ErkJggg==", "base64");

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
});

test("text document survives a reload; badge only until it is exported", async ({ page }) => {
  if (shots) await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#document");
  await expect(page.getByTestId("logo-doc-badge")).toHaveCount(0);
  await page.getByTestId("doc-new").click();
  const ed = page.getByTestId("doc-editor");
  await expect(ed).toBeFocused();
  await page.keyboard.type("Compte rendu à garder");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Deuxième ligne.");
  // Pasted image: stored apart from the HTML (no 5 MB localStorage limit).
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
    document.querySelector('[data-testid="doc-editor"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString("base64"));
  await expect(ed.locator("img")).toHaveCount(1);
  const name = page.getByTestId("doc-name-input");
  await name.fill("CR persistance");
  await name.press("Enter");

  // Badge on the logo + mark in the tab title, as soon as it is saved locally.
  const badge = page.getByTestId("logo-doc-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("title", /CR persistance/);
  await expect(page).toHaveTitle(/^• /);
  await shot(page, "1-badge-editor");

  // Reload: reopened automatically, with its image, its name, and still badged.
  await page.reload();
  await expect(page.getByTestId("doc-resumed")).toContainText("CR persistance");
  await expect(ed).toContainText("Compte rendu à garder");
  await expect(ed).toContainText("Deuxième ligne.");
  await expect(ed.locator("img")).toHaveCount(1);
  await expect(page.getByTestId("doc-name-input")).toHaveValue("CR persistance");
  await expect(badge).toBeVisible();
  await shot(page, "2-restored-draft");

  // Home: the badge stays on the logo, the card offers to resume.
  await page.goto("/");
  await expect(badge).toBeVisible();
  await expect(page.getByTestId("document-resume")).toContainText("CR persistance");
  if (shots) {
    await page.getByTestId("document-card").scrollIntoViewIfNeeded();
    await shot(page, "3-home-card-resume");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(".pz-header").screenshot({ path: `${shots}/0-logo-badge.png` });
  }

  // Export as Markdown: the badge and the title mark go away, the document stays.
  await page.getByTestId("document-resume").click();
  await expect(ed).toContainText("Compte rendu à garder");
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.getByTestId("doc-menubar-file").click();
      await page.getByTestId("doc-menu-save-md").click();
    })(),
  ]);
  expect(dl.suggestedFilename()).toBe("CR persistance.md");
  await expect(badge).toHaveCount(0);
  await expect(page).not.toHaveTitle(/^• /);
  await shot(page, "4-exported-no-badge");

  // Still remembered after a reload, without badge; a new edit brings it back.
  await page.reload();
  await expect(ed).toContainText("Compte rendu à garder");
  await expect(badge).toHaveCount(0);
  await ed.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Ajout.");
  await expect(badge).toBeVisible();

  // Close and forget: nothing left.
  await page.getByTestId("doc-close").click();
  await expect(badge).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("doc-new")).toBeVisible();
  await expect(page.getByTestId("doc-draft")).toHaveCount(0);
});

test("the badge follows another tab", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  a.on("dialog", (d) => void d.accept());
  await b.goto("/");
  await expect(b.getByTestId("logo-doc-badge")).toHaveCount(0);
  await a.bringToFront();
  await a.goto("/#document");
  await a.getByTestId("doc-new").click();
  await a.getByTestId("doc-editor").pressSequentially("Depuis l'onglet A");
  await expect(a.getByTestId("logo-doc-badge")).toBeVisible();
  await expect(b.getByTestId("logo-doc-badge")).toBeVisible();
  await a.getByTestId("doc-close").click();
  await expect(b.getByTestId("logo-doc-badge")).toHaveCount(0);
});

test("old localStorage draft is migrated", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("fny.document.draft.v1", JSON.stringify({ name: "Ancien brouillon", html: "<p>Texte d'avant</p>", at: Date.now() })));
  await page.goto("/#document");
  await expect(page.getByTestId("doc-editor")).toContainText("Texte d'avant");
  await expect(page.getByTestId("doc-resumed")).toContainText("Ancien brouillon");
  expect(await page.evaluate(() => localStorage.getItem("fny.document.draft.v1"))).toBeNull();
});
