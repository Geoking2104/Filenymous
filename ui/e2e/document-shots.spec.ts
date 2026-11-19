/** Screenshots of the Word-like editor and the Pages panel (only with DOC_SHOTS=<dir>). */
import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

test.skip(!process.env.DOC_SHOTS, "screenshots only on demand");
test.use({ colorScheme: "dark", viewport: { width: 1440, height: 1000 } });

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([595, 842]);
    p.drawRectangle({ x: 0, y: 760, width: 595, height: 82, color: rgb(0.2, 0.25, 0.55) });
    p.drawText(`Complete Filing Dossier — ${i + 1}`, { x: 40, y: 790, size: 22, font, color: rgb(1, 1, 1) });
    for (let l = 0; l < 22; l++) p.drawText("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.", { x: 40, y: 720 - l * 26, size: 12, font: body });
  }
  return Buffer.from(await doc.save());
}

test("editor and pages panel", async ({ page }) => {
  const dir = process.env.DOC_SHOTS!;
  await page.goto("/#document");
  await expect(page.getByTestId("doc-new")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/0-start.png` });
  await page.getByTestId("doc-new").click();
  await page.getByTestId("doc-style").selectOption("h1");
  await page.keyboard.type("Note de cadrage");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ce document a été créé ");
  await page.getByTestId("doc-fmt-bold").click();
  await page.keyboard.type("directement dans Filenymous");
  await page.getByTestId("doc-fmt-bold").click();
  await page.keyboard.type(", sans serveur : il peut être enregistré en PDF ou en Markdown, envoyé en P2P ou rangé dans le coffre-fort.");
  await page.keyboard.press("Enter");
  await page.getByTestId("doc-style").selectOption("h2");
  await page.keyboard.type("Objectifs");
  await page.keyboard.press("Enter");
  await page.getByTestId("doc-fmt-bullet").click();
  for (const l of ["Créer un fichier ex nihilo", "Mettre en forme comme dans un traitement de texte", "Exporter un vrai PDF texte (accents compris)"]) {
    await page.keyboard.type(l);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Enter");
  await page.getByTestId("doc-ins-table").click();
  for (const c of ["Livrable", "Format", "Statut", "Compte rendu", "PDF", "Prêt"]) {
    await page.keyboard.type(c);
    await page.keyboard.press("Tab");
  }
  await page.getByTestId("doc-editor").locator("h1").click();
  await page.screenshot({ path: `${dir}/1-editor.png` });
  await page.getByTestId("doc-menubar-format").click();
  await page.screenshot({ path: `${dir}/2-editor-format-menu.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("doc-saveas")).toBeVisible();
  await page.screenshot({ path: `${dir}/3-save-as.png` });
  await page.keyboard.press("Escape");

  page.on("dialog", (d) => void d.accept());
  await page.getByTestId("doc-close").click();
  await page.getByTestId("doc-file").setInputFiles({ name: "Complete-Filing-Dossier-2026.pdf", mimeType: "application/pdf", buffer: await makePdf(6) });
  const thumbs = page.getByTestId("doc-thumb");
  await expect(thumbs).toHaveCount(6);
  await thumbs.nth(1).click();
  await thumbs.nth(2).click({ modifiers: ["ControlOrMeta"] });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/4-pages-panel.png` });
  await thumbs.nth(2).click({ button: "right" });
  await expect(page.getByTestId("doc-context")).toBeVisible();
  await page.screenshot({ path: `${dir}/5-pages-context-menu.png` });
  await page.keyboard.press("Escape");
  await page.getByTestId("doc-menubar-file").click();
  await page.screenshot({ path: `${dir}/6-pdf-file-menu.png` });
});
