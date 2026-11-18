/**
 * Document tab: a PDF is opened, edited (pages, form, text overlay, merge,
 * optimise) and exported entirely in the browser, then handed to the P2P send
 * flow. The downloaded file is checked with pdf-lib.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";

async function makePdf(pages: number, withForm = false): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([400 + i, 560]);
    p.drawText(`Page ${i + 1}`, { x: 40, y: 500, size: 28, font });
  }
  if (withForm) {
    const f = doc.getForm().createTextField("name");
    f.addToPage(doc.getPage(0), { x: 40, y: 400, width: 200, height: 24 });
  }
  return Buffer.from(await doc.save());
}

test("open, edit, export and send a PDF locally", async ({ page }) => {
  const uploads: string[] = [];
  page.on("request", (r) => {
    if (["POST", "PUT"].includes(r.method())) uploads.push(r.url());
  });
  await page.goto("/#document");
  await expect(page.getByTestId("service-head")).toHaveAttribute("data-service", "document");
  await expect(page.getByTestId("doc-drop")).toBeVisible();

  await page.getByTestId("doc-file").setInputFiles({ name: "contrat.pdf", mimeType: "application/pdf", buffer: await makePdf(3, true) });
  await expect(page.getByTestId("doc-thumb")).toHaveCount(3);
  await expect(page.getByTestId("doc-pageno")).toHaveText(/1 \/ 3/);
  await expect(page.locator(".doc-page canvas")).toBeVisible();

  // Pages: rotate the first, delete the last.
  await page.getByTestId("doc-rotate").first().click();
  await page.getByTestId("doc-delete").nth(2).click();
  await expect(page.getByTestId("doc-thumb")).toHaveCount(2);
  // Undo / redo the deletion through the undo stack.
  await page.getByTestId("doc-undo").click();
  await expect(page.getByTestId("doc-thumb")).toHaveCount(3);
  await page.getByTestId("doc-delete").nth(2).click();
  await expect(page.getByTestId("doc-thumb")).toHaveCount(2);

  // Form.
  await page.getByTestId("doc-tool-form").click();
  await page.getByTestId("doc-form-text").fill("Alice Martin");
  await page.getByTestId("doc-form-apply").click();
  await expect(page.getByTestId("doc-msg")).toBeVisible();

  // Text overlay placed by clicking the page.
  await page.getByTestId("doc-tool-annotate").click();
  await page.getByTestId("doc-anno-text").fill("Lu et approuvé");
  await page.locator(".doc-page canvas").click({ position: { x: 60, y: 80 } });
  await expect(page.getByTestId("doc-overlay")).toHaveCount(1);
  await page.getByTestId("doc-anno-apply").click();
  await expect(page.getByTestId("doc-overlay")).toHaveCount(0);

  // Merge one more PDF.
  await page.getByTestId("doc-tool-merge").click();
  await page.getByTestId("doc-merge-file").setInputFiles({ name: "annexe.pdf", mimeType: "application/pdf", buffer: await makePdf(1) });
  await page.getByTestId("doc-merge").click();
  await expect(page.getByTestId("doc-thumb")).toHaveCount(3);

  // Optimise (lossless + metadata).
  await page.getByTestId("doc-tool-optimise").click();
  await page.getByTestId("doc-optimise").click();
  await expect(page.getByTestId("doc-msg")).toContainText("→");

  // Download and verify with pdf-lib.
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("doc-download").click()]);
  expect(dl.suggestedFilename()).toBe("contrat.pdf");
  const out = await PDFDocument.load(readFileSync((await dl.path())!));
  expect(out.getPageCount()).toBe(3);
  expect(out.getPage(0).getRotation().angle).toBe(90);
  expect(out.getPage(2).getWidth()).toBe(400);
  expect(out.getForm().getTextField("name").getText()).toBe("Alice Martin");

  // Nothing was uploaded while editing.
  expect(uploads).toEqual([]);

  // Hand the result to the P2P send flow.
  await page.getByTestId("doc-send").click();
  await expect(page.getByTestId("review-step")).toBeVisible();
  await expect(page.getByTestId("review-step")).toContainText("contrat.pdf");
});

test("split by ranges downloads a zip", async ({ page }) => {
  await page.goto("/#doc");
  await page.getByTestId("doc-file").setInputFiles({ name: "rapport.pdf", mimeType: "application/pdf", buffer: await makePdf(5) });
  await expect(page.getByTestId("doc-thumb")).toHaveCount(5);
  await page.getByTestId("doc-tool-split").click();
  await page.getByTestId("doc-ranges").fill("1-2, 9");
  await page.getByTestId("doc-split").click();
  await expect(page.getByRole("alert")).toContainText("9");
  await page.getByTestId("doc-ranges").fill("1-2, 4-");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("doc-split").click()]);
  expect(dl.suggestedFilename()).toMatch(/\.zip$/);
});

test("rejects a non-PDF file", async ({ page }) => {
  await page.goto("/#document");
  await page.getByTestId("doc-file").setInputFiles({ name: "photo.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") });
  await expect(page.getByRole("alert")).toContainText("photo.pdf");
  await expect(page.getByTestId("doc-drop")).toBeVisible();
});

test("Coffre-fort round trip: store the PDF, reopen it in Document", async ({ page }) => {
  test.setTimeout(180_000);
  const PW = "correct horse battery staple demo";
  page.on("dialog", (d) => void d.accept());
  // Create a vault (throwaway demo password).
  await page.goto("/#safe");
  await expect(page.getByTestId("cf-onboarding")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("cf-start").click();
  await page.getByTestId("cf-master").fill(PW);
  await page.getByTestId("cf-master2").fill(PW);
  await page.getByTestId("cf-create").click();
  await expect(page.getByTestId("cf-phrase")).toBeVisible({ timeout: 30_000 });
  const words = await page.locator('[data-testid^="cf-word-"] span').allTextContents();
  await page.getByTestId("cf-phrase-ack").check();
  await page.getByTestId("cf-phrase-next").click();
  for (let i = 0; i < 3; i++) {
    const input = page.getByTestId(`cf-check-${i}`);
    await input.fill(words[Number(await input.getAttribute("data-pos"))]!);
  }
  await page.getByTestId("cf-check-submit").click();
  await expect(page.getByTestId("cf-vault")).toBeVisible({ timeout: 30_000 });

  // Document → Coffre-fort.
  await page.evaluate(() => (location.hash = "#document"));
  await page.getByTestId("doc-file").setInputFiles({ name: "facture.pdf", mimeType: "application/pdf", buffer: await makePdf(2) });
  await expect(page.getByTestId("doc-thumb")).toHaveCount(2);
  await page.getByTestId("doc-to-safe").click();
  const unlock = page.getByTestId("cf-unlock");
  await expect(unlock.or(page.getByTestId("cf-editor"))).toBeVisible({ timeout: 30_000 });
  if (await unlock.isVisible()) {
    await page.getByTestId("cf-unlock-pw").fill(PW);
    await page.getByTestId("cf-unlock-submit").click();
  }
  await expect(page.getByTestId("cf-f-handed")).toContainText("facture.pdf", { timeout: 30_000 });
  await expect(page.getByTestId("cf-f-title")).toHaveValue("facture.pdf");
  await page.getByTestId("cf-save").click();
  await expect(page.getByTestId("cf-detail-title")).toHaveText("facture.pdf", { timeout: 15_000 });

  // Coffre-fort → Document.
  await page.getByTestId("cf-open-document").click();
  await expect(page.getByTestId("service-head")).toHaveAttribute("data-service", "document");
  await expect(page.getByTestId("doc-thumb")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId("doc-name")).toContainText("facture.pdf");
});

test("draw a signature and stamp it on a page", async ({ page }) => {
  await page.goto("/#document");
  await page.getByTestId("doc-file").setInputFiles({ name: "bail.pdf", mimeType: "application/pdf", buffer: await makePdf(1) });
  await page.getByTestId("doc-tool-annotate").click();
  await page.getByLabel(/Image ou signature/).check();
  await page.getByTestId("doc-sign").click();
  const pad = page.getByTestId("doc-pad").locator("canvas");
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10, { steps: 8 });
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 10, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId("doc-pad-use").click();
  await expect(page.getByTestId("doc-anno-ready")).toBeVisible();
  await page.locator(".doc-page canvas").click({ position: { x: 120, y: 300 } });
  await expect(page.getByTestId("doc-overlay")).toHaveCount(1);
  if (process.env.DOC_SHOTS) await page.screenshot({ path: `${process.env.DOC_SHOTS}/annotate.png` });
  await page.getByTestId("doc-anno-apply").click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("doc-download").click()]);
  const out = await PDFDocument.load(readFileSync((await dl.path())!));
  const xobj = out.getPage(0).node.Resources()?.get(out.getPage(0).node.Resources()!.keys().find((k) => k.asString() === "/XObject")!);
  expect(xobj).toBeTruthy();
});
