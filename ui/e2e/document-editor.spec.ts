/**
 * Word-like Document tab: a text document created from scratch, formatted,
 * renamed and saved as PDF (real text, checked with pdf.js) and Markdown;
 * Markdown files opened in the editor; a PDF converted to editable text; the
 * Pages panel (one shared toolbar, multi-select, keyboard, context menu,
 * drag-and-drop reorder).
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFDict, PDFName, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([400 + i, 560]);
    p.drawText(`Page ${i + 1}`, { x: 40, y: 500, size: 28, font });
    p.drawText(`Texte de la page ${i + 1}.`, { x: 40, y: 450, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    out += tc.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("") + "\n";
  }
  await pdf.destroy();
  return out;
}

async function fontNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const names = new Set<string>();
  for (const p of doc.getPages()) {
    const fonts = p.node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
    fonts?.keys().forEach((k) => names.add(String(fonts.lookup(k, PDFDict).get(PDFName.of("BaseFont")))));
  }
  return [...names];
}

const download = async (page: Page, click: () => Promise<void>) => {
  const [dl] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: dl.suggestedFilename(), bytes: new Uint8Array(readFileSync((await dl.path())!)) };
};

test("#document-new opens a blank editor", async ({ page }) => {
  await page.goto("/#document-new");
  const ed = page.getByTestId("doc-editor");
  await expect(ed).toBeVisible();
  await expect(page.getByTestId("doc-new")).toHaveCount(0);
  await expect(ed).toBeFocused();
  await expect(page).toHaveTitle("Éditeur Filenymous");
  await expect(page).toHaveURL(/#document-new$/);
});

test("bookmarks-bar pill on the Document card is a draggable production URL", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("carousel-dot").nth(4).click();
  const link = page.getByTestId("doc-bookmark-link");
  await expect(link).toHaveAttribute("href", "https://filenymous.eu/app/#document-new");
  await expect(link).toHaveAttribute("draggable", "true");
  await expect(link).toHaveAttribute("title", "Éditeur Filenymous");
  await link.click();
  await expect(page.getByTestId("doc-editor")).toBeVisible();
  await expect(page.getByTestId("doc-editor")).toBeFocused();
  await expect(page).toHaveURL(/#document-new$/);
  expect(new URL(page.url()).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
});

test("Fichier menu opens the add-to-bookmarks dialog", async ({ page }) => {
  await page.goto("/#document-new");
  await expect(page.getByTestId("doc-editor")).toBeVisible();
  await page.getByTestId("doc-menubar-file").click();
  await page.getByTestId("doc-menu-bookmark").click();
  const dlg = page.getByTestId("doc-bookmark-dialog");
  await expect(dlg).toBeVisible();
  const link = page.getByTestId("doc-bookmark-dialog-link");
  await expect(link).toHaveAttribute("href", "https://filenymous.eu/app/#document-new");
  await expect(link).toHaveAttribute("draggable", "true");
});

test("#document-new offers a draft without blocking the caret", async ({ page }) => {
  await page.goto("/#document");
  await page.getByTestId("doc-new").click();
  await expect(page.getByTestId("doc-editor")).toBeFocused();
  await page.keyboard.type("Brouillon à reprendre");
  // Saved in this browser (IndexedDB): the status line shows it.
  await expect(page.getByText(/brouillon local/)).toBeVisible();
  // Full load, as when the bookmarks-bar shortcut is opened (a hash-only
  // move would ask to discard the current unsaved document).
  await page.goto("about:blank");
  await page.goto("/#document-new");
  const ed = page.getByTestId("doc-editor");
  await expect(ed).toBeFocused();
  await expect(page.getByTestId("doc-draft")).toContainText("Sans titre");
  await page.getByTestId("doc-draft-restore").click();
  await expect(ed).toContainText("Brouillon à reprendre");
  await ed.pressSequentially(" !");
  await expect(ed).toContainText("Brouillon à reprendre !");
});

test("new document: type, format, rename, save as PDF and Markdown", async ({ page }) => {
  const uploads: string[] = [];
  page.on("request", (r) => ["POST", "PUT"].includes(r.method()) && uploads.push(r.url()));
  await page.goto("/#document");
  await page.getByTestId("doc-new").click();
  const ed = page.getByTestId("doc-editor");
  await expect(ed).toBeFocused();

  await page.getByTestId("doc-style").selectOption("h1");
  await page.keyboard.type("Compte rendu de réunion");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Été comme hiver, déjà ça : ");
  await page.getByTestId("doc-fmt-bold").click();
  await page.keyboard.type("décision importante");
  await page.getByTestId("doc-fmt-bold").click();
  await expect(page.getByTestId("doc-fmt-bold")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Enter");
  await page.getByTestId("doc-fmt-bullet").click();
  await page.keyboard.type("premier point");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second point");
  await expect(ed.locator("h1")).toHaveText("Compte rendu de réunion");
  await expect(ed.locator("strong")).toHaveText("décision importante");
  await expect(ed.locator("ul li")).toHaveCount(2);

  // Select all + bold through the Format menu, then undo it.
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByTestId("doc-menubar-format").click();
  await page.getByTestId("doc-menu-italic").click();
  await expect(ed.locator("em").first()).toBeVisible();
  await page.getByTestId("doc-ed-undo").click();
  await expect(ed.locator("em")).toHaveCount(0);

  // Rename in the header.
  const name = page.getByTestId("doc-name-input");
  await name.fill("CR équipe");
  await name.press("Enter");

  // Ctrl+S → "Save as" dialog → PDF.
  await ed.click();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("doc-saveas")).toBeVisible();
  await expect(page.getByTestId("doc-saveas-name")).toHaveValue("CR équipe");
  const pdf = await download(page, () => page.getByTestId("doc-saveas-download").click());
  expect(pdf.name).toBe("CR équipe.pdf");
  const text = await pdfText(pdf.bytes);
  expect(text).toContain("Compte rendu de réunion");
  expect(text).toContain("Été comme hiver, déjà ça :");
  expect(text).toContain("décision importante");
  expect(text).toContain("second point");
  const fonts = await fontNames(pdf.bytes);
  expect(fonts.some((f) => /NotoSans-Bold/.test(f))).toBe(true);
  expect(fonts.some((f) => /NotoSans-Regular/.test(f))).toBe(true);
  expect(await PDFDocument.load(pdf.bytes).then((d) => Math.round(d.getPage(0).getWidth()))).toBe(595);

  // Markdown through the File menu.
  const md = await download(page, async () => {
    await page.getByTestId("doc-menubar-file").click();
    await page.getByTestId("doc-menu-save-md").click();
  });
  expect(md.name).toBe("CR équipe.md");
  const src = Buffer.from(md.bytes).toString("utf8");
  expect(src).toContain("# Compte rendu de réunion");
  expect(src).toContain("Été comme hiver, déjà ça : **décision importante**");
  expect(src).toMatch(/^- premier point$/m);

  expect(uploads).toEqual([]);
});

test("Markdown file opens in the editor; find and replace; draft survives a reload", async ({ page }) => {
  await page.goto("/#document");
  await page.getByTestId("doc-file").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n\nUn *test* avec [lien](https://filenymous.eu).\n\n| A | B |\n|---|---|\n| 1 | 2 |\n") });
  const ed = page.getByTestId("doc-editor");
  await expect(ed.locator("h1")).toHaveText("Notes");
  await expect(ed.locator("table td")).toHaveCount(2);
  await expect(page.getByTestId("doc-name-input")).toHaveValue("notes");

  await page.keyboard.press("ControlOrMeta+f");
  await page.getByTestId("doc-find-q").fill("test");
  await expect(page.getByTestId("doc-find-count")).toContainText("/ 1");
  await page.getByTestId("doc-find-r").fill("essai");
  await page.getByTestId("doc-find-replace-all").click();
  await expect(ed).toContainText("Un essai avec");

  // The edit is kept in this browser and reopened automatically after a reload.
  await expect(page.getByText(/brouillon local/)).toBeVisible();
  page.on("dialog", (d) => void d.accept());
  await page.reload();
  await expect(page.getByTestId("doc-resumed")).toContainText("notes");
  await expect(page.getByTestId("doc-editor")).toContainText("Un essai avec");
});

test("Pages panel: one shared toolbar, multi-select, keyboard, context menu and drag-and-drop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1300 });
  await page.goto("/#document");
  await page.getByTestId("doc-file").setInputFiles({ name: "dossier.pdf", mimeType: "application/pdf", buffer: await makePdf(5) });
  const thumbs = page.getByTestId("doc-thumb");
  await expect(thumbs).toHaveCount(5);

  // No per-thumbnail menu: no buttons or checkboxes inside thumbnails, one toolbar.
  await expect(page.locator(".doc-thumb button, .doc-thumb input")).toHaveCount(0);
  await expect(page.getByTestId("doc-thumbs-bar")).toHaveCount(1);
  await expect(page.getByTestId("doc-delete")).toHaveCount(1);
  await expect(page.getByTestId("doc-rotate")).toHaveCount(1);

  // Click + Ctrl+click: two pages selected, deleted with the Delete key.
  await thumbs.nth(1).click();
  await thumbs.nth(3).click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator(".doc-thumb.is-selected")).toHaveCount(2);
  await expect(page.getByTestId("doc-sel-count")).toContainText("2");
  await page.keyboard.press("Delete");
  await expect(thumbs).toHaveCount(3); // pages 1, 3, 5

  // Shift+click range, then Ctrl+A.
  await thumbs.nth(0).click();
  await thumbs.nth(2).click({ modifiers: ["Shift"] });
  await expect(page.locator(".doc-thumb.is-selected")).toHaveCount(3);
  await thumbs.nth(0).click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".doc-thumb.is-selected")).toHaveCount(1);
  await expect(page.getByTestId("doc-pageno")).toHaveText(/2 \/ 3/);

  // Right-click → Duplicate.
  await thumbs.nth(2).click({ button: "right" });
  await expect(page.getByTestId("doc-context")).toBeVisible();
  await page.getByTestId("doc-menu-pg-dup").click();
  await expect(page.getByTestId("doc-context")).toHaveCount(0);
  await expect(thumbs).toHaveCount(4); // 1, 3, 5, 5

  // Drag the first page below the second one.
  await thumbs.nth(0).click();
  await thumbs.nth(1).scrollIntoViewIfNeeded();
  const box = (await thumbs.nth(1).boundingBox())!;
  await thumbs.nth(0).dragTo(thumbs.nth(1), { targetPosition: { x: box.width / 2, y: box.height - 8 } });
  await expect(thumbs.nth(1)).toHaveAttribute("data-src", "0");

  // Ctrl+↓ moves the selection one step down.
  await thumbs.nth(1).click();
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await expect(thumbs.nth(2)).toHaveAttribute("data-src", "0");

  const out = await download(page, () => page.getByTestId("doc-download").click());
  expect(out.name).toBe("dossier.pdf");
  const doc = await PDFDocument.load(out.bytes);
  expect(doc.getPages().map((p) => p.getWidth())).toEqual([402, 404, 400, 404]);
});

test("PDF: save the text as Markdown and convert to an editable document", async ({ page }) => {
  await page.goto("/#document");
  await page.getByTestId("doc-file").setInputFiles({ name: "lettre.pdf", mimeType: "application/pdf", buffer: await makePdf(2) });
  await expect(page.getByTestId("doc-thumb")).toHaveCount(2);

  await page.getByTestId("doc-format").selectOption("md");
  const md = await download(page, () => page.getByTestId("doc-download").click());
  expect(md.name).toBe("lettre.md");
  const src = Buffer.from(md.bytes).toString("utf8");
  expect(src).toContain("Page 1");
  expect(src).toContain("Texte de la page 2.");
  expect(src).toContain("\\newpage");

  page.on("dialog", (d) => void d.accept());
  await page.getByTestId("doc-convert").click();
  const ed = page.getByTestId("doc-editor");
  await expect(ed).toContainText("Texte de la page 1.");
  await expect(ed.locator(".doc-pagebreak")).toHaveCount(1);
  await expect(page.getByTestId("doc-msg")).toBeVisible();
});
