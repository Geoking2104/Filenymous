/**
 * Editor document (ProseMirror JSON) → a real text PDF, laid out locally with
 * pdf-lib (MIT) on A4 pages. Text is drawn with Noto Sans (SIL OFL 1.1, four
 * styles, subset to Latin / Greek / Cyrillic) embedded through
 * @pdf-lib/fontkit (MIT), so accents and most European scripts are real,
 * searchable and copyable text. Code uses the standard Courier font.
 *
 * Supported: headings, paragraphs (alignment), bold / italic / underline /
 * strike / inline code / links (clickable), bullet and numbered lists
 * (nested), blockquotes, code blocks, horizontal rules, page breaks, images
 * (PNG / JPEG, others through `loadImage`), simple tables. Characters the
 * fonts cannot draw (emoji, CJK, Arabic…) are replaced with "?".
 */
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}

export interface FontSet {
  regular: Uint8Array;
  bold: Uint8Array;
  italic: Uint8Array;
  boldItalic: Uint8Array;
}

export interface ExportOptions {
  fonts: FontSet;
  title?: string;
  lang?: string;
  /** Page numbers "n / N" at the bottom (default true). */
  pageNumbers?: boolean;
  /** Bytes of an image the exporter cannot decode itself (not a PNG / JPEG data URL). Null skips it. */
  loadImage?: (src: string) => Promise<{ bytes: Uint8Array; type: "png" | "jpg" } | null>;
}

export const A4: [number, number] = [595.28, 841.89];
const MARGIN = { top: 62, bottom: 66, left: 64, right: 64 };
const BASE = 11;
const LEADING = 1.42;
const HEADING = [0, 22, 17.5, 14.5, 12.5, 11.5, 11];
const LINK = rgb(0.09, 0.32, 0.78);
const TEXT = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.38, 0.38, 0.42);
const RULE = rgb(0.75, 0.75, 0.78);
const SHADE = rgb(0.94, 0.94, 0.95);

interface Style {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  link?: string;
  color?: RGB;
}
const plain: Style = { bold: false, italic: false, underline: false, strike: false, code: false };

interface Tok {
  text: string;
  style: Style;
  font: PDFFont;
  size: number;
  width: number;
  space: boolean;
  br?: boolean;
}

interface Box {
  x: number;
  width: number;
}

interface BlockOpts {
  base?: Partial<Style>;
  size?: number;
  tight?: boolean;
  marker?: string;
  depth?: number;
}

const safeUri = (href: unknown): string | undefined => {
  if (typeof href !== "string") return undefined;
  return /^(https?:|mailto:|tel:)/i.test(href.trim()) ? href.trim() : undefined;
};

function dataUrlBytes(src: string): { bytes: Uint8Array; type: "png" | "jpg" } | null {
  const m = /^data:image\/(png|jpe?g);base64,(.*)$/i.exec(src);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type: m[1].toLowerCase() === "png" ? "png" : "jpg" };
}

class Writer {
  page!: PDFPage;
  y = 0;
  /** Measuring pass (tables): nothing is drawn, no page break. */
  dry = false;
  /** Inside a table row: the row was already placed, never break. */
  noBreak = false;
  quotes: { x: number; top: number }[] = [];
  private charsets = new Map<PDFFont, Set<number>>();
  private images = new Map<string, PDFImage | null>();

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: { r: PDFFont; b: PDFFont; i: PDFFont; bi: PDFFont; mono: PDFFont; monoB: PDFFont },
    readonly opts: ExportOptions,
  ) {
    this.newPage();
  }

  get top() {
    return A4[1] - MARGIN.top;
  }
  get atTop() {
    return this.y >= this.top - 0.5;
  }

  newPage() {
    if (this.page) this.closeQuoteSegments();
    this.page = this.doc.addPage(A4);
    this.y = this.top;
    this.quotes.forEach((q) => (q.top = this.y));
  }

  ensure(h: number) {
    if (this.dry || this.noBreak) return;
    if (this.y - h < MARGIN.bottom && !this.atTop) this.newPage();
  }

  private closeQuoteSegments() {
    for (const q of this.quotes) this.page.drawLine({ start: { x: q.x, y: q.top }, end: { x: q.x, y: Math.max(MARGIN.bottom, this.y) }, thickness: 2.5, color: RULE });
  }

  font(s: Style): PDFFont {
    if (s.code) return s.bold ? this.fonts.monoB : this.fonts.mono;
    if (s.bold && s.italic) return this.fonts.bi;
    if (s.bold) return this.fonts.b;
    if (s.italic) return this.fonts.i;
    return this.fonts.r;
  }

  /** Replace what the font cannot draw (and control characters). */
  clean(text: string, font: PDFFont): string {
    let set = this.charsets.get(font);
    if (!set) {
      set = new Set(font.getCharacterSet());
      this.charsets.set(font, set);
    }
    let out = "";
    for (const ch of text.replace(/\t/g, "    ")) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x200b || cp === 0xfe0f || cp === 0x200d) continue;
      if (cp < 32) out += " ";
      else if (set.has(cp)) out += ch;
      else if (cp === 0xa0 || cp === 0x202f) out += " ";
      else out += "?";
    }
    return out;
  }

  async image(src: string): Promise<PDFImage | null> {
    if (this.images.has(src)) return this.images.get(src)!;
    let img: PDFImage | null = null;
    try {
      const raw = dataUrlBytes(src) ?? (this.opts.loadImage ? await this.opts.loadImage(src) : null);
      if (raw) img = raw.type === "png" ? await this.doc.embedPng(raw.bytes) : await this.doc.embedJpg(raw.bytes);
    } catch {
      img = null;
    }
    this.images.set(src, img);
    return img;
  }
}

function styleOf(marks: PMMark[] | undefined, base: Style): Style {
  const s: Style = { ...base };
  for (const m of marks ?? []) {
    if (m.type === "bold") s.bold = true;
    else if (m.type === "italic") s.italic = true;
    else if (m.type === "underline") s.underline = true;
    else if (m.type === "strike") s.strike = true;
    else if (m.type === "code") s.code = true;
    else if (m.type === "link") s.link = safeUri(m.attrs?.href);
  }
  return s;
}

function tokenize(w: Writer, content: PMNode[] | undefined, base: Style, size: number): Tok[] {
  const toks: Tok[] = [];
  for (const n of content ?? []) {
    if (n.type === "hardBreak") {
      toks.push({ text: "", style: base, font: w.font(base), size, width: 0, space: false, br: true });
      continue;
    }
    if (n.type !== "text" || !n.text) continue;
    const style = styleOf(n.marks, base);
    const font = w.font(style);
    const sz = style.code ? size * 0.92 : size;
    const text = w.clean(n.text, font);
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      const space = /^\s+$/.test(part);
      const t = space ? " " : part;
      toks.push({ text: t, style, font, size: sz, width: font.widthOfTextAtSize(t, sz), space });
    }
  }
  return toks;
}

interface Line {
  toks: Tok[];
  /** Ends with a hard break or the paragraph end (no justification). */
  last: boolean;
}

/** Split a word that is wider than the line into pieces that fit. */
function splitLong(t: Tok, width: number): Tok[] {
  const out: Tok[] = [];
  let buf = "";
  for (const ch of Array.from(t.text)) {
    const next = buf + ch;
    if (buf && t.font.widthOfTextAtSize(next, t.size) > width) {
      out.push({ ...t, text: buf, width: t.font.widthOfTextAtSize(buf, t.size) });
      buf = ch;
    } else buf = next;
  }
  if (buf) out.push({ ...t, text: buf, width: t.font.widthOfTextAtSize(buf, t.size) });
  return out;
}

export function wrap(toks: Tok[], width: number): Line[] {
  const lines: Line[] = [];
  let line: Tok[] = [];
  let w = 0;
  const flush = (last: boolean) => {
    while (line.length && line[line.length - 1].space) line.pop();
    lines.push({ toks: line, last });
    line = [];
    w = 0;
  };
  for (const t of toks) {
    if (t.br) {
      flush(true);
      continue;
    }
    if (t.space && line.length === 0) continue;
    if (w + t.width > width && line.length) {
      flush(false);
      if (t.space) continue;
    }
    if (t.width > width) {
      const parts = splitLong(t, width);
      parts.forEach((p, k) => {
        line.push(p);
        w += p.width;
        if (k < parts.length - 1) flush(false);
      });
      continue;
    }
    line.push(t);
    w += t.width;
  }
  if (line.length || lines.length === 0) flush(true);
  else if (lines.length) lines[lines.length - 1].last = true;
  return lines;
}

function same(a: Style, b: Style) {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.code === b.code && a.link === b.link && a.color === b.color;
}

function addLink(w: Writer, uri: string, x: number, y: number, width: number, height: number) {
  const ctx = w.doc.context;
  const annot = ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + width, y + height],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(uri) },
    }),
  );
  w.page.node.addAnnot(annot);
}

/** Lay out and draw a run of inline content; returns nothing, moves `w.y`. */
function inline(w: Writer, content: PMNode[] | undefined, box: Box, o: { size: number; base: Style; align?: string; marker?: string; color?: RGB }) {
  const toks = tokenize(w, content, o.base, o.size);
  const lines = wrap(toks, box.width);
  const lh = o.size * LEADING;
  lines.forEach((line, li) => {
    w.ensure(lh);
    const baseline = w.y - o.size * 1.02;
    if (!w.dry) {
      if (li === 0 && o.marker) {
        const mf = w.font(o.base);
        const mk = w.clean(o.marker, mf);
        const mw = mf.widthOfTextAtSize(mk, o.size);
        w.page.drawText(mk, { x: box.x - mw - 5, y: baseline, size: o.size, font: mf, color: o.color ?? TEXT });
      }
      const width = line.toks.reduce((s, t) => s + t.width, 0);
      const spaces = line.toks.filter((t) => t.space).length;
      let x = box.x;
      let extra = 0;
      if (o.align === "center") x += (box.width - width) / 2;
      else if (o.align === "right") x += box.width - width;
      else if (o.align === "justify" && !line.last && spaces) extra = (box.width - width) / spaces;
      // Merge neighbours of the same style into one text run (unless justified).
      const runs: { toks: Tok[]; x: number; w: number }[] = [];
      for (const t of line.toks) {
        const tw = t.width + (t.space ? extra : 0);
        const prev = runs[runs.length - 1];
        if (prev && !extra && same(prev.toks[0].style, t.style) && prev.toks[0].size === t.size) {
          prev.toks.push(t);
          prev.w += tw;
        } else runs.push({ toks: [t], x, w: tw });
        x += tw;
      }
      for (const r of runs) {
        const s = r.toks[0].style;
        const size = r.toks[0].size;
        const text = r.toks.map((t) => t.text).join("");
        const color = s.link ? LINK : o.color ?? s.color ?? TEXT;
        if (s.code) w.page.drawRectangle({ x: r.x - 1, y: baseline - size * 0.28, width: r.w + 2, height: size * 1.2, color: SHADE });
        w.page.drawText(text, { x: r.x, y: baseline, size, font: r.toks[0].font, color });
        if (s.underline || s.link) w.page.drawLine({ start: { x: r.x, y: baseline - size * 0.13 }, end: { x: r.x + r.w, y: baseline - size * 0.13 }, thickness: Math.max(0.5, size * 0.055), color });
        if (s.strike) w.page.drawLine({ start: { x: r.x, y: baseline + size * 0.28 }, end: { x: r.x + r.w, y: baseline + size * 0.28 }, thickness: Math.max(0.5, size * 0.055), color });
        if (s.link) addLink(w, s.link, r.x, baseline - size * 0.25, r.w, size * 1.2);
      }
    }
    w.y -= lh;
  });
}

async function blocks(w: Writer, nodes: PMNode[] | undefined, box: Box, o: BlockOpts = {}) {
  const list = nodes ?? [];
  for (let k = 0; k < list.length; k++) {
    const marker = k === 0 ? o.marker : undefined;
    await block(w, list[k], box, { ...o, marker }, k === list.length - 1);
  }
  if (!list.length && o.marker) await block(w, { type: "paragraph" }, box, o, true);
}

async function block(w: Writer, n: PMNode, box: Box, o: BlockOpts, lastInParent: boolean) {
  const base: Style = { ...plain, ...o.base };
  const size = o.size ?? BASE;
  const after = o.tight && !lastInParent ? size * 0.2 : o.tight ? 0 : size * 0.6;
  switch (n.type) {
    case "paragraph": {
      inline(w, n.content, box, { size, base, align: n.attrs?.textAlign as string, marker: o.marker, color: base.color });
      w.y -= after;
      break;
    }
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
      const hs = HEADING[level];
      if (!w.atTop && !w.dry) w.y -= hs * 0.55;
      // Keep a heading with the first line of what follows.
      w.ensure(hs * LEADING + BASE * LEADING * 2);
      inline(w, n.content, box, { size: hs, base: { ...base, bold: true }, align: n.attrs?.textAlign as string, marker: o.marker });
      w.y -= hs * 0.3;
      break;
    }
    case "bulletList":
    case "orderedList": {
      const ordered = n.type === "orderedList";
      const start = Number(n.attrs?.start) || 1;
      const depth = o.depth ?? 0;
      const glyphs = ["•", "◦", "▪"];
      const indent = 22;
      if (o.marker) inline(w, [], box, { size, base, marker: o.marker });
      for (const [i, item] of (n.content ?? []).entries()) {
        const marker = ordered ? `${start + i}.` : glyphs[depth % glyphs.length];
        await blocks(w, item.content, { x: box.x + indent, width: box.width - indent }, { ...o, tight: true, marker, depth: depth + 1 });
      }
      w.y -= o.tight ? 0 : size * 0.5;
      break;
    }
    case "listItem":
      await blocks(w, n.content, box, o);
      break;
    case "blockquote": {
      const q = { x: box.x + 3, top: w.y };
      if (!w.dry) w.quotes.push(q);
      await blocks(w, n.content, { x: box.x + 16, width: box.width - 16 }, { ...o, marker: undefined, base: { ...o.base, color: MUTED, italic: true } });
      if (!w.dry) {
        w.quotes.pop();
        w.page.drawLine({ start: { x: q.x, y: q.top }, end: { x: q.x, y: w.y + size * 0.5 }, thickness: 2.5, color: RULE });
      }
      break;
    }
    case "codeBlock": {
      const font = w.fonts.mono;
      const cs = 9.5;
      const lh = cs * 1.45;
      const text = (n.content ?? []).map((c) => c.text ?? "").join("");
      const rows = text.split("\n").flatMap((l) => {
        const t: Tok = { text: w.clean(l, font) || " ", style: { ...plain, code: true }, font, size: cs, width: 0, space: false };
        t.width = font.widthOfTextAtSize(t.text, cs);
        return t.width > box.width - 12 ? splitLong(t, box.width - 12) : [t];
      });
      w.y -= 2;
      for (const r of rows) {
        w.ensure(lh);
        if (!w.dry) {
          w.page.drawRectangle({ x: box.x, y: w.y - lh, width: box.width, height: lh, color: SHADE });
          w.page.drawText(r.text, { x: box.x + 6, y: w.y - cs * 1.05, size: cs, font, color: TEXT });
        }
        w.y -= lh;
      }
      w.y -= after + 2;
      break;
    }
    case "horizontalRule": {
      w.ensure(14);
      if (!w.dry) w.page.drawLine({ start: { x: box.x, y: w.y - 7 }, end: { x: box.x + box.width, y: w.y - 7 }, thickness: 0.8, color: RULE });
      w.y -= 14;
      break;
    }
    case "pageBreak": {
      if (!w.dry && !w.noBreak && !w.atTop) w.newPage();
      break;
    }
    case "image": {
      const src = String(n.attrs?.src ?? "");
      const img = src ? await w.image(src) : null;
      if (!img) {
        inline(w, [{ type: "text", text: `[${String(n.attrs?.alt || "image")}]` }], box, { size, base: { ...base, italic: true }, color: MUTED });
        break;
      }
      let iw = img.width * 0.75;
      let ih = img.height * 0.75;
      const want = Number(n.attrs?.width);
      if (want > 0) {
        ih = (ih * want * 0.75) / iw;
        iw = want * 0.75;
      }
      const maxH = A4[1] - MARGIN.top - MARGIN.bottom - 20;
      const k = Math.min(1, box.width / iw, maxH / ih);
      iw *= k;
      ih *= k;
      w.ensure(ih + 4);
      if (!w.dry) {
        const align = n.attrs?.textAlign ?? n.attrs?.align;
        const x = align === "center" ? box.x + (box.width - iw) / 2 : align === "right" ? box.x + box.width - iw : box.x;
        w.page.drawImage(img, { x, y: w.y - ih, width: iw, height: ih });
      }
      w.y -= ih + after + 4;
      break;
    }
    case "table":
      await table(w, n, box);
      w.y -= after;
      break;
    default:
      // Unknown block: render its children, or its text.
      if (n.content?.some((c) => c.type === "text")) inline(w, n.content, box, { size, base });
      else await blocks(w, n.content, box, o);
  }
}

async function table(w: Writer, n: PMNode, box: Box) {
  const rows = (n.content ?? []).filter((r) => r.type === "tableRow");
  const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((s, c) => s + (Number(c.attrs?.colspan) || 1), 0)));
  const colW = box.width / cols;
  const pad = 5;
  for (const row of rows) {
    // Measure every cell (dry pass), then place the row as a whole.
    const cells = row.content ?? [];
    const heights: number[] = [];
    for (const c of cells) {
      const span = Number(c.attrs?.colspan) || 1;
      const saveY = w.y;
      w.dry = true;
      await blocks(w, c.content, { x: 0, width: colW * span - pad * 2 }, { tight: true, base: c.type === "tableHeader" ? { bold: true } : undefined });
      w.dry = false;
      heights.push(saveY - w.y);
      w.y = saveY;
    }
    const rowH = Math.max(BASE * LEADING, ...heights) + pad * 2;
    w.ensure(rowH);
    const top = w.y;
    let x = box.x;
    w.noBreak = true;
    for (const c of cells) {
      const span = Number(c.attrs?.colspan) || 1;
      const cw = colW * span;
      w.page.drawRectangle({ x, y: top - rowH, width: cw, height: rowH, borderColor: RULE, borderWidth: 0.7, color: c.type === "tableHeader" ? SHADE : undefined });
      w.y = top - pad;
      await blocks(w, c.content, { x: x + pad, width: cw - pad * 2 }, { tight: true, base: c.type === "tableHeader" ? { bold: true } : undefined });
      x += cw;
    }
    w.noBreak = false;
    w.y = top - rowH;
  }
}

export async function exportPdf(docJson: PMNode, opts: ExportOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [r, b, i, bi, mono, monoB] = await Promise.all([
    pdf.embedFont(opts.fonts.regular, { subset: true }),
    pdf.embedFont(opts.fonts.bold, { subset: true }),
    pdf.embedFont(opts.fonts.italic, { subset: true }),
    pdf.embedFont(opts.fonts.boldItalic, { subset: true }),
    pdf.embedFont(StandardFonts.Courier),
    pdf.embedFont(StandardFonts.CourierBold),
  ]);
  const w = new Writer(pdf, { r, b, i, bi, mono, monoB }, opts);
  await blocks(w, docJson.content, { x: MARGIN.left, width: A4[0] - MARGIN.left - MARGIN.right });

  if (opts.pageNumbers !== false) {
    const pages = pdf.getPages();
    if (pages.length > 1)
      pages.forEach((p, k) => {
        const label = `${k + 1} / ${pages.length}`;
        p.drawText(label, { x: (A4[0] - r.widthOfTextAtSize(label, 8.5)) / 2, y: MARGIN.bottom / 2 - 3, size: 8.5, font: r, color: MUTED });
      });
  }
  if (opts.title) pdf.setTitle(opts.title, { showInWindowTitleBar: true });
  if (opts.lang) pdf.setLanguage(opts.lang);
  pdf.setCreator("Filenymous");
  pdf.setProducer("Filenymous Document (pdf-lib)");
  pdf.catalog.set(PDFName.of("PageLayout"), PDFName.of("OneColumn"));
  return pdf.save({ useObjectStreams: true });
}
