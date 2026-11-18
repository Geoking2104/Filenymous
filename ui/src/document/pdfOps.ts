/**
 * Pure, client-side PDF operations for the Document tab (pdf-lib, MIT).
 *
 * Every function takes PDF bytes and returns new bytes: nothing is uploaded,
 * nothing is mutated in place, so the panel can keep an undo stack of plain
 * Uint8Arrays. Page indices are zero-based here; the UI shows 1-based numbers.
 */
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFObjectCopier,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import { zlibSync } from "fflate";

export class PdfOpError extends Error {
  constructor(
    readonly code: "encrypted" | "invalid" | "range" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "PdfOpError";
  }
}

/** Load for editing. Encrypted files are refused: pdf-lib cannot decrypt them. */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    const msg = (e as Error)?.message ?? String(e);
    if (name === "EncryptedPDFError" || /encrypt/i.test(msg)) throw new PdfOpError("encrypted", msg);
    throw new PdfOpError("invalid", msg);
  }
}

async function save(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: true });
}

export interface PdfInfo {
  pageCount: number;
  title?: string;
  author?: string;
  producer?: string;
  pages: { width: number; height: number; rotation: number }[];
  hasForm: boolean;
}

export async function getInfo(bytes: Uint8Array): Promise<PdfInfo> {
  const doc = await loadPdf(bytes);
  let hasForm = false;
  try {
    hasForm = doc.getForm().getFields().length > 0;
  } catch {
    hasForm = false;
  }
  return {
    pageCount: doc.getPageCount(),
    title: doc.getTitle() || undefined,
    author: doc.getAuthor() || undefined,
    producer: doc.getProducer() || undefined,
    pages: doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return { width, height, rotation: normAngle(p.getRotation().angle) };
    }),
    hasForm,
  };
}

const normAngle = (a: number) => (((Math.round(a / 90) * 90) % 360) + 360) % 360;

/** Concatenate whole documents, in order (form fields are kept, first name wins). */
export async function mergePdfs(list: Uint8Array[]): Promise<Uint8Array> {
  if (list.length === 0) throw new PdfOpError("empty", "nothing to merge");
  const out = await PDFDocument.create();
  const names = new Set<string>();
  for (const bytes of list) {
    const src = await loadPdf(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
    carryForm(src, out, pages, names);
  }
  return save(out);
}

const N = {
  AcroForm: PDFName.of("AcroForm"),
  Fields: PDFName.of("Fields"),
  Parent: PDFName.of("Parent"),
  Subtype: PDFName.of("Subtype"),
  Widget: PDFName.of("Widget"),
  T: PDFName.of("T"),
};

/**
 * pdf-lib's copyPages() keeps widget annotations but not the document's
 * AcroForm, so copied pages would lose their form. Rebuild the field list
 * from the widgets on the copied pages and copy the form defaults (DA/DR…).
 * A field whose name is already taken (merging two copies of one form) stays
 * drawn but is not registered twice.
 */
function carryForm(src: PDFDocument, out: PDFDocument, pages: PDFPage[], names: Set<string>) {
  const srcForm = src.catalog.lookupMaybe(N.AcroForm, PDFDict);
  if (!srcForm) return;
  const ctx = out.context;
  let form = out.catalog.lookupMaybe(N.AcroForm, PDFDict);
  const fresh: PDFRef[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const widget = ctx.lookup(ref);
      if (!(ref instanceof PDFRef) || !(widget instanceof PDFDict) || widget.get(N.Subtype) !== N.Widget) continue;
      let cur: PDFDict = widget;
      let top: PDFRef = ref;
      for (let guard = 0; guard < 32; guard++) {
        const p: PDFObject | undefined = cur.get(N.Parent);
        const pd: PDFObject | undefined = p instanceof PDFRef ? ctx.lookup(p) : undefined;
        if (!(p instanceof PDFRef) || !(pd instanceof PDFDict)) break;
        top = p;
        cur = pd;
      }
      const t = cur.get(N.T);
      const name = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : "";
      if (!name || seen.has(top.toString())) continue;
      seen.add(top.toString());
      if (names.has(name)) continue;
      names.add(name);
      fresh.push(top);
    }
  }
  if (fresh.length === 0) return;
  if (!form) {
    form = ctx.obj({});
    const copier = PDFObjectCopier.for(src.context, ctx);
    for (const k of ["DA", "DR", "Q", "NeedAppearances"]) {
      const v = srcForm.get(PDFName.of(k));
      if (v) form.set(PDFName.of(k), copier.copy(v));
    }
    form.set(N.Fields, ctx.obj([]));
    out.catalog.set(N.AcroForm, ctx.register(form));
  }
  const fields = form.lookupMaybe(N.Fields, PDFArray) ?? ctx.obj([]);
  form.set(N.Fields, fields);
  for (const r of fresh) fields.push(r);
}

/** New document made of the given pages (zero-based, any order, repeats allowed). */
export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const src = await loadPdf(bytes);
  return save(await copyInto(src, indices.map((src) => ({ src, rotate: 0 }))));
}

/**
 * Parse a 1-based page selection such as "1-3, 5, 8-" into groups of
 * zero-based indices (one group per comma-separated item). Open ends ("8-",
 * "-3") run to the last / from the first page.
 */
export function parseRanges(spec: string, pageCount: number): number[][] {
  const items = spec.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new PdfOpError("range", "empty selection");
  return items.map((item) => {
    const m = /^(\d*)\s*(?:[-–]\s*(\d*))?$/.exec(item);
    if (!m || (m[1] === "" && m[2] === undefined) || (m[1] === "" && m[2] === "")) throw new PdfOpError("range", item);
    const isRange = item.includes("-") || item.includes("–");
    const a = m[1] === "" ? 1 : Number(m[1]);
    const b = isRange ? (m[2] === "" || m[2] === undefined ? pageCount : Number(m[2])) : a;
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) throw new PdfOpError("range", item);
    const out: number[] = [];
    if (a <= b) for (let i = a; i <= b; i++) out.push(i - 1);
    else for (let i = a; i >= b; i--) out.push(i - 1);
    return out;
  });
}

/** One output document per group. */
export async function splitByRanges(bytes: Uint8Array, groups: number[][]): Promise<Uint8Array[]> {
  const src = await loadPdf(bytes);
  const out: Uint8Array[] = [];
  for (const g of groups) out.push(await save(await copyInto(src, g.map((i) => ({ src: i, rotate: 0 })))));
  return out;
}

/** Chunks of `every` pages (the last one may be shorter). */
export function chunkPages(pageCount: number, every: number): number[][] {
  const n = Math.max(1, Math.floor(every));
  const groups: number[][] = [];
  for (let i = 0; i < pageCount; i += n) groups.push(Array.from({ length: Math.min(n, pageCount - i) }, (_, k) => i + k));
  return groups;
}

/** A page of the result: which source page, plus an extra clockwise rotation. */
export interface PageEdit {
  src: number;
  rotate: number;
}

async function copyInto(src: PDFDocument, edits: PageEdit[]): Promise<PDFDocument> {
  if (edits.length === 0) throw new PdfOpError("empty", "no pages");
  const n = src.getPageCount();
  for (const e of edits) if (!Number.isInteger(e.src) || e.src < 0 || e.src >= n) throw new PdfOpError("range", String(e.src + 1));
  const out = await PDFDocument.create();
  const pages = await out.copyPages(
    src,
    edits.map((e) => e.src),
  );
  pages.forEach((p, i) => {
    const extra = normAngle(edits[i].rotate);
    if (extra) p.setRotation(degrees(normAngle(p.getRotation().angle + extra)));
    out.addPage(p);
  });
  carryForm(src, out, pages, new Set());
  return out;
}

/**
 * Reorder / rotate / delete in one pass. Keeps the document-level parts
 * (form, outline, metadata) when the page list is unchanged except rotation;
 * otherwise rebuilds the document from the listed pages.
 */
export async function applyPageEdits(bytes: Uint8Array, edits: PageEdit[]): Promise<Uint8Array> {
  const src = await loadPdf(bytes);
  const identity = edits.length === src.getPageCount() && edits.every((e, i) => e.src === i);
  if (identity) {
    src.getPages().forEach((p, i) => {
      const extra = normAngle(edits[i].rotate);
      if (extra) p.setRotation(degrees(normAngle(p.getRotation().angle + extra)));
    });
    return save(src);
  }
  return save(await copyInto(src, edits));
}

// ---------------------------------------------------------------- forms --

export type FieldKind = "text" | "checkbox" | "dropdown" | "optionlist" | "radio" | "other";
export interface FormFieldInfo {
  name: string;
  kind: FieldKind;
  value: string | boolean | string[];
  options?: string[];
  multiline?: boolean;
  readOnly: boolean;
}

export async function listFormFields(bytes: Uint8Array): Promise<FormFieldInfo[]> {
  const doc = await loadPdf(bytes);
  let fields;
  try {
    fields = doc.getForm().getFields();
  } catch {
    return [];
  }
  return fields.map((f): FormFieldInfo => {
    const base = { name: f.getName(), readOnly: f.isReadOnly() };
    if (f instanceof PDFTextField) return { ...base, kind: "text", value: f.getText() ?? "", multiline: f.isMultiline() };
    if (f instanceof PDFCheckBox) return { ...base, kind: "checkbox", value: f.isChecked() };
    if (f instanceof PDFDropdown) return { ...base, kind: "dropdown", value: f.getSelected()[0] ?? "", options: f.getOptions() };
    if (f instanceof PDFOptionList) return { ...base, kind: "optionlist", value: f.getSelected(), options: f.getOptions() };
    if (f instanceof PDFRadioGroup) return { ...base, kind: "radio", value: f.getSelected() ?? "", options: f.getOptions() };
    return { ...base, kind: "other", value: "" };
  });
}

export type FormValues = Record<string, string | boolean | string[]>;

/** Fill AcroForm fields by name; `flatten` bakes the values into the pages. */
export async function fillForm(bytes: Uint8Array, values: FormValues, opts: { flatten?: boolean } = {}): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [name, v] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!f || f.isReadOnly()) continue;
    if (f instanceof PDFTextField) f.setText(winAnsiSafe(font, String(v ?? "")) || undefined);
    else if (f instanceof PDFCheckBox) (v === true || v === "true" ? f.check() : f.uncheck());
    else if (f instanceof PDFDropdown) (v ? f.select(String(v)) : f.clear());
    else if (f instanceof PDFOptionList) {
      const list = (Array.isArray(v) ? v : [String(v)]).filter(Boolean);
      if (list.length) f.select(list);
      else f.clear();
    } else if (f instanceof PDFRadioGroup) (v ? f.select(String(v)) : f.clear());
  }
  form.updateFieldAppearances(font);
  if (opts.flatten) form.flatten();
  return save(doc);
}

/** Drop characters the standard (WinAnsi) fonts cannot encode, keep the rest. */
export function winAnsiSafe(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") {
      out += ch;
      continue;
    }
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      /* not encodable in WinAnsi: skipped */
    }
  }
  return out;
}

// ------------------------------------------------------------- overlays --

/**
 * Overlays are positioned in *display* points: the page as the viewer shows
 * it (after its /Rotate), origin at the top-left, 1 unit = 1 PDF point.
 */
export type Overlay =
  | { kind: "text"; page: number; x: number; y: number; text: string; size: number; color: string }
  | { kind: "image"; page: number; x: number; y: number; width: number; height: number; bytes: Uint8Array; mime: "image/png" | "image/jpeg" };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Display point (top-left origin, after rotation) → PDF user-space point. */
export function displayToPdf(dx: number, dy: number, box: Box, rotation: number): { x: number; y: number } {
  const W = box.width;
  const H = box.height;
  let u: number;
  let v: number; // unrotated, top-left origin
  switch (normAngle(rotation)) {
    case 90:
      u = dy;
      v = H - dx;
      break;
    case 180:
      u = W - dx;
      v = H - dy;
      break;
    case 270:
      u = W - dy;
      v = dx;
      break;
    default:
      u = dx;
      v = dy;
  }
  return { x: box.x + u, y: box.y + H - v };
}

/** Displayed size of a page (width/height swapped for 90°/270°). */
export function displaySize(page: { width: number; height: number; rotation: number }): { width: number; height: number } {
  return normAngle(page.rotation) % 180 === 0 ? { width: page.width, height: page.height } : { width: page.height, height: page.width };
}

function hexColor(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Bake text and images into the page content (not PDF annotation objects). */
export async function addOverlays(bytes: Uint8Array, overlays: Overlay[]): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const pages = doc.getPages();
  let font: PDFFont | null = null;
  for (const o of overlays) {
    const page: PDFPage | undefined = pages[o.page];
    if (!page) throw new PdfOpError("range", String(o.page + 1));
    const box = page.getCropBox();
    const rot = normAngle(page.getRotation().angle);
    if (o.kind === "text") {
      font ??= await doc.embedFont(StandardFonts.Helvetica);
      const size = Math.max(4, Math.min(144, o.size));
      const lines = winAnsiSafe(font, o.text).split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!line) return;
        // Click point = top-left of the text block; baseline sits ~0.8 em below.
        const p = displayToPdf(o.x, o.y + size * 0.8 + i * size * 1.2, box, rot);
        page.drawText(line, { x: p.x, y: p.y, size, font: font!, color: hexColor(o.color), rotate: degrees(rot) });
      });
    } else {
      const img = o.mime === "image/png" ? await doc.embedPng(o.bytes) : await doc.embedJpg(o.bytes);
      // Anchor = the image's display bottom-left corner.
      const p = displayToPdf(o.x, o.y + o.height, box, rot);
      page.drawImage(img, { x: p.x, y: p.y, width: o.width, height: o.height, rotate: degrees(rot) });
    }
  }
  return save(doc);
}

// ------------------------------------------------------------- optimise --

export interface OptimiseOptions {
  /** Remove the Info dictionary, XMP metadata and per-page PieceInfo. */
  stripMetadata?: boolean;
  /** Flate-compress streams that are stored without any filter. */
  compressStreams?: boolean;
}
export interface OptimiseResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  removedObjects: number;
  compressedStreams: number;
}

/**
 * Lossless optimisation: drops unreachable objects, recompresses unfiltered
 * streams, writes object streams; optionally strips metadata. Images are not
 * resampled (that would be lossy and needs a renderer).
 */
export async function optimise(bytes: Uint8Array, opts: OptimiseOptions = {}): Promise<OptimiseResult> {
  const doc = await loadPdf(bytes);
  const ctx = doc.context;
  if (opts.stripMetadata) {
    ctx.trailerInfo.Info = undefined;
    ctx.trailerInfo.ID = undefined;
    doc.catalog.delete(PDFName.of("Metadata"));
    doc.catalog.delete(PDFName.of("PieceInfo"));
    for (const p of doc.getPages()) {
      p.node.delete(PDFName.of("Metadata"));
      p.node.delete(PDFName.of("PieceInfo"));
    }
  }
  // Garbage-collect: keep only what the trailer can reach.
  const reachable = new Set<string>();
  const stack: (PDFObject | undefined)[] = [ctx.trailerInfo.Root];
  if (ctx.trailerInfo.Info) stack.push(ctx.trailerInfo.Info);
  if (ctx.trailerInfo.Encrypt) stack.push(ctx.trailerInfo.Encrypt);
  while (stack.length) {
    const o = stack.pop();
    if (!o) continue;
    if (o instanceof PDFRef) {
      const k = o.toString();
      if (reachable.has(k)) continue;
      reachable.add(k);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) stack.push(v);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  let removedObjects = 0;
  let compressedStreams = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) {
      ctx.delete(ref);
      removedObjects++;
      continue;
    }
    if (opts.compressStreams && obj instanceof PDFRawStream && !obj.dict.has(PDFName.of("Filter"))) {
      const raw = obj.getContents();
      if (raw.length < 128) continue;
      const z = zlibSync(raw, { level: 9 });
      if (z.length >= raw.length) continue;
      const dict = obj.dict.clone(ctx);
      dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
      dict.delete(PDFName.of("DecodeParms"));
      ctx.assign(ref, PDFRawStream.of(dict, z));
      compressedStreams++;
    }
  }
  const out = await save(doc);
  return { bytes: out, before: bytes.length, after: out.length, removedObjects, compressedStreams };
}

/** True when the bytes start like a PDF (allowing a little leading junk). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}
