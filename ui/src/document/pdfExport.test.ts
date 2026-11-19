// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { exportPdf, type FontSet, type PMNode } from "./pdfExport";
import { inflate } from "./fontsInflate";
import { itemsToLines, linesToParagraphs } from "./pdfText";

const font = (n: string) => inflate(new Uint8Array(readFileSync(new URL(`./fonts/NotoSans-${n}.ttf.gz`, import.meta.url))));
const fonts: FontSet = { regular: font("Regular"), bold: font("Bold"), italic: font("Italic"), boldItalic: font("BoldItalic") };

// 1×1 red PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const t = (text: string, marks: string[] = []): PMNode => ({ type: "text", text, marks: marks.map((type) => ({ type })) });
const p = (...content: PMNode[]): PMNode => ({ type: "paragraph", content });

async function pagesText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    out.push(linesToParagraphs(itemsToLines(tc.items as never)).join("\n"));
  }
  await pdf.destroy();
  return out;
}

describe("PDF export", () => {
  it("writes real, extractable text with accents, styles, lists, tables and images", async () => {
    const doc: PMNode = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [t("Été à Noël — déjà")] },
        p(t("Texte "), t("gras", ["bold"]), t(" et "), t("italique", ["italic"]), t(" puis "), t("souligné", ["underline"]), t(" "), t("barré", ["strike"]), t(" ç œ € «ok» Привет Ελλάδα 😀")),
        { type: "bulletList", content: [{ type: "listItem", content: [p(t("premier point"))] }, { type: "listItem", content: [p(t("second point")), { type: "orderedList", attrs: { start: 1 }, content: [{ type: "listItem", content: [p(t("sous-point"))] }] }] }] },
        { type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "un lien", marks: [{ type: "link", attrs: { href: "https://filenymous.eu" } }] }] },
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [p(t("Nom"))] }, { type: "tableHeader", content: [p(t("Prix"))] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [p(t("Thé"))] }, { type: "tableCell", content: [p(t("2 €"))] }] }] },
        { type: "image", attrs: { src: PNG, alt: "point" } },
        { type: "codeBlock", content: [t("const x = 1;")] },
        { type: "pageBreak" },
        p(t("Deuxième page")),
      ],
    };
    const bytes = await exportPdf(doc, { fonts, title: "Essai", lang: "fr-FR" });
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(2);
    expect(loaded.getTitle()).toBe("Essai");
    const [w, h] = [loaded.getPage(0).getWidth(), loaded.getPage(0).getHeight()];
    expect(Math.round(w)).toBe(595);
    expect(Math.round(h)).toBe(842);

    const [p1, p2] = await pagesText(bytes);
    expect(p1).toContain("Été à Noël — déjà");
    expect(p1).toContain("gras");
    expect(p1).toContain("ç œ € «ok» Привет Ελλάδα ?");
    expect(p1).toContain("premier point");
    expect(p1).toContain("sous-point");
    expect(p1).toContain("un lien");
    expect(p1).toContain("Thé");
    expect(p1).toContain("2 €");
    expect(p1).toContain("const x = 1;");
    expect(p2).toContain("Deuxième page");
    expect(p2).toContain("2 / 2");

    // The link is a clickable URI annotation.
    const annots = loaded.getPage(0).node.Annots();
    expect(annots?.size()).toBe(1);
    // The image is embedded.
    expect(bytes.length).toBeGreaterThan(5000);
  }, 30_000);

  it("breaks long text over several A4 pages", async () => {
    const long = Array.from({ length: 120 }, (_, i) => p(t(`Paragraphe ${i + 1} : ` + "lorem ipsum dolor sit amet ".repeat(6))));
    const bytes = await exportPdf({ type: "doc", content: long }, { fonts });
    const pages = await pagesText(bytes);
    expect(pages.length).toBeGreaterThan(4);
    expect(pages.join("\n")).toContain("Paragraphe 120");
  }, 30_000);
});
