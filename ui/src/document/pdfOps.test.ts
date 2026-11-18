// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, degrees } from "pdf-lib";
import {
  PdfOpError,
  addOverlays,
  applyPageEdits,
  chunkPages,
  displaySize,
  displayToPdf,
  extractPages,
  fillForm,
  getInfo,
  listFormFields,
  looksLikePdf,
  mergePdfs,
  optimise,
  parseRanges,
  splitByRanges,
} from "./pdfOps";

/** A PDF whose page i is (200+i) points wide, so pages are identifiable after edits. */
async function makePdf(n: number, opts: { title?: string; form?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([200 + i, 300]);
    p.drawText(`page ${i + 1}`, { x: 20, y: 250, size: 12, font });
  }
  if (opts.title) {
    doc.setTitle(opts.title);
    doc.setAuthor("Alice Example");
  }
  if (opts.form) {
    const form = doc.getForm();
    const name = form.createTextField("name");
    name.addToPage(doc.getPage(0), { x: 10, y: 10, width: 150, height: 20 });
    const ok = form.createCheckBox("agree");
    ok.addToPage(doc.getPage(0), { x: 10, y: 40, width: 15, height: 15 });
    const dd = form.createDropdown("country");
    dd.addOptions(["FR", "BE", "CH"]);
    dd.addToPage(doc.getPage(0), { x: 10, y: 70, width: 100, height: 20 });
  }
  return doc.save();
}

const widths = async (bytes: Uint8Array) => (await getInfo(bytes)).pages.map((p) => p.width);

describe("pdfOps", () => {
  it("reads basic info", async () => {
    const info = await getInfo(await makePdf(3, { title: "Contrat" }));
    expect(info.pageCount).toBe(3);
    expect(info.title).toBe("Contrat");
    expect(info.hasForm).toBe(false);
    expect(info.pages[1]).toEqual({ width: 201, height: 300, rotation: 0 });
  });

  it("merges documents in order", async () => {
    const out = await mergePdfs([await makePdf(2), await makePdf(1)]);
    expect(await widths(out)).toEqual([200, 201, 200]);
    await expect(mergePdfs([])).rejects.toBeInstanceOf(PdfOpError);
  });

  it("extracts pages in any order", async () => {
    expect(await widths(await extractPages(await makePdf(5), [4, 0, 0]))).toEqual([204, 200, 200]);
    await expect(extractPages(await makePdf(2), [5])).rejects.toMatchObject({ code: "range" });
  });

  it("keeps AcroForm fields through page edits and merges", async () => {
    const form = await makePdf(2, { form: true });
    const reordered = await applyPageEdits(form, [{ src: 1, rotate: 0 }, { src: 0, rotate: 90 }]);
    expect((await listFormFields(reordered)).map((f) => f.name)).toEqual(["name", "agree", "country"]);
    const filled = await fillForm(reordered, { name: "Alice" });
    expect((await listFormFields(filled))[0].value).toBe("Alice");
    // Pages without widgets: no form carried.
    expect(await listFormFields(await extractPages(form, [1]))).toEqual([]);
    // Merging two copies of the same form: the first copy owns the names.
    const merged = await mergePdfs([filled, form]);
    const fields = await listFormFields(merged);
    expect(fields.map((f) => f.name)).toEqual(["name", "agree", "country"]);
    expect(fields[0].value).toBe("Alice");
    expect((await getInfo(merged)).pageCount).toBe(4);
  });

  it("parses 1-based page ranges", () => {
    expect(parseRanges("1-3, 5", 6)).toEqual([[0, 1, 2], [4]]);
    expect(parseRanges("5-", 6)).toEqual([[4, 5]]);
    expect(parseRanges("-2", 6)).toEqual([[0, 1]]);
    expect(parseRanges("3-1", 6)).toEqual([[2, 1, 0]]);
    expect(() => parseRanges("0", 6)).toThrow(PdfOpError);
    expect(() => parseRanges("7", 6)).toThrow(PdfOpError);
    expect(() => parseRanges("a-b", 6)).toThrow(PdfOpError);
    expect(() => parseRanges(" , ", 6)).toThrow(PdfOpError);
    expect(chunkPages(5, 2)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it("splits into several documents", async () => {
    const parts = await splitByRanges(await makePdf(4), [[0, 1], [3]]);
    expect(parts).toHaveLength(2);
    expect(await widths(parts[0])).toEqual([200, 201]);
    expect(await widths(parts[1])).toEqual([203]);
  });

  it("reorders, rotates and deletes pages in one pass", async () => {
    const out = await applyPageEdits(await makePdf(3), [
      { src: 2, rotate: 90 },
      { src: 0, rotate: 0 },
    ]);
    const info = await getInfo(out);
    expect(info.pages.map((p) => [p.width, p.rotation])).toEqual([[202, 90], [200, 0]]);
  });

  it("rotation-only edits keep the document (form, metadata)", async () => {
    const src = await makePdf(2, { title: "Keep me", form: true });
    const out = await applyPageEdits(src, [{ src: 0, rotate: 270 }, { src: 1, rotate: -90 }]);
    const info = await getInfo(out);
    expect(info.title).toBe("Keep me");
    expect(info.hasForm).toBe(true);
    expect(info.pages.map((p) => p.rotation)).toEqual([270, 270]);
  });

  it("lists and fills AcroForm fields", async () => {
    const src = await makePdf(1, { form: true });
    const fields = await listFormFields(src);
    expect(fields.map((f) => [f.name, f.kind])).toEqual([["name", "text"], ["agree", "checkbox"], ["country", "dropdown"]]);
    expect(fields[2].options).toEqual(["FR", "BE", "CH"]);
    const filled = await fillForm(src, { name: "Zoë 😀 Durand", agree: true, country: "BE" });
    const after = await listFormFields(filled);
    // Characters outside WinAnsi (emoji) are dropped instead of failing the save.
    expect(after.find((f) => f.name === "name")?.value).toBe("Zoë  Durand");
    expect(after.find((f) => f.name === "agree")?.value).toBe(true);
    expect(after.find((f) => f.name === "country")?.value).toBe("BE");
    const flat = await fillForm(src, { name: "X" }, { flatten: true });
    expect(await listFormFields(flat)).toEqual([]);
  });

  it("maps display points to PDF space for every rotation", () => {
    const box = { x: 0, y: 0, width: 200, height: 300 };
    expect(displayToPdf(0, 0, box, 0)).toEqual({ x: 0, y: 300 });
    expect(displayToPdf(10, 20, box, 0)).toEqual({ x: 10, y: 280 });
    // 90° cw: the display is 300 wide × 200 tall; its top-left is PDF (0,0).
    expect(displayToPdf(0, 0, box, 90)).toEqual({ x: 0, y: 0 });
    expect(displayToPdf(300, 200, box, 90)).toEqual({ x: 200, y: 300 });
    expect(displayToPdf(0, 0, box, 180)).toEqual({ x: 200, y: 0 });
    expect(displayToPdf(0, 0, box, 270)).toEqual({ x: 200, y: 300 });
    expect(displayToPdf(5, 5, { x: 10, y: 20, width: 200, height: 300 }, 0)).toEqual({ x: 15, y: 315 });
    expect(displaySize({ width: 200, height: 300, rotation: 90 })).toEqual({ width: 300, height: 200 });
  });

  it("bakes text and images into pages", async () => {
    const src = await makePdf(2);
    // 1×1 PNG
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );
    const out = await addOverlays(src, [
      { kind: "text", page: 0, x: 20, y: 30, text: "Lu et approuvé\nGeoffroy", size: 14, color: "#1d4ed8" },
      { kind: "image", page: 1, x: 10, y: 10, width: 80, height: 30, bytes: png, mime: "image/png" },
    ]);
    expect(out.length).toBeGreaterThan(src.length);
    expect((await getInfo(out)).pageCount).toBe(2);
    await expect(addOverlays(src, [{ kind: "text", page: 9, x: 0, y: 0, text: "x", size: 12, color: "#000000" }])).rejects.toMatchObject({ code: "range" });
  });

  it("optimises losslessly and strips metadata", async () => {
    // An uncompressed, unreferenced-garbage-laden file.
    const doc = await PDFDocument.create();
    doc.setTitle("Secret title");
    doc.setAuthor("Secret author");
    const page = doc.addPage([200, 200]);
    const content = "BT /F1 12 Tf 10 10 Td (" + "hello world ".repeat(200) + ") Tj ET";
    const raw = PDFRawStream.of(doc.context.obj({}), new TextEncoder().encode(content));
    page.node.set(PDFName.of("Contents"), doc.context.register(raw));
    doc.context.register(doc.context.obj({ Orphan: "yes" }));
    const src = await doc.save({ useObjectStreams: false });

    const res = await optimise(src, { stripMetadata: true, compressStreams: true });
    expect(res.after).toBeLessThan(res.before);
    expect(res.compressedStreams).toBeGreaterThanOrEqual(1);
    expect(res.removedObjects).toBeGreaterThanOrEqual(1);
    const text = new TextDecoder("latin1").decode(res.bytes);
    expect(text).not.toContain("Secret");
    const info = await getInfo(res.bytes);
    expect(info.pageCount).toBe(1);
    expect(info.title).toBeUndefined();
    // Reloading with pdf-lib still yields the same content stream once decoded.
    const re = await PDFDocument.load(res.bytes);
    expect(re.getPage(0).node.Contents()).toBeTruthy();
  });

  it("refuses non-PDF input with a typed error", async () => {
    await expect(getInfo(new TextEncoder().encode("hello"))).rejects.toMatchObject({ code: "invalid" });
    expect(looksLikePdf(await makePdf(1))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("PK\u0003\u0004"))).toBe(false);
  });

  it("keeps pre-existing page rotation when adding more", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]).setRotation(degrees(90));
    const out = await applyPageEdits(await doc.save(), [{ src: 0, rotate: 90 }, { src: 0, rotate: 0 }]);
    expect((await getInfo(out)).pages.map((p) => p.rotation)).toEqual([180, 90]);
  });
});
