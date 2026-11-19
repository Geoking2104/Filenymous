/**
 * Text extraction from a PDF with pdf.js (text layer only): the result is
 * paragraphs per page. Layout, columns, images and fonts are not kept; a
 * scanned PDF (images only) yields no text.
 */
import type { PDFDocumentProxy } from "./pdfView";

export interface TextLine {
  text: string;
  /** Baseline, in PDF units from the bottom of the page. */
  y: number;
  /** Font height. */
  h: number;
}

interface Item {
  str: string;
  transform: number[];
  height: number;
  hasEOL?: boolean;
}

/** pdf.js text items → lines (items on the same baseline are joined). */
export function itemsToLines(items: Item[]): TextLine[] {
  const lines: TextLine[] = [];
  let cur: TextLine | null = null;
  let lastX = 0;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const y = it.transform[5];
    const x = it.transform[4];
    const h = Math.abs(it.height || it.transform[3] || 10);
    if (cur && Math.abs(cur.y - y) <= Math.max(2, h * 0.4)) {
      if (it.str && cur.text && !/\s$/.test(cur.text) && !/^\s/.test(it.str) && x - lastX > h * 0.15) cur.text += " ";
      cur.text += it.str;
      cur.h = Math.max(cur.h, h);
    } else if (it.str.trim() || cur === null) {
      cur = { text: it.str, y, h };
      lines.push(cur);
    }
    lastX = x + (it.str.length ? (h * it.str.length) / 2 : 0);
    if (it.hasEOL) cur = null;
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
}

/**
 * Lines → paragraphs: a vertical gap clearly larger than the usual line
 * spacing starts a new paragraph; lines of a paragraph are joined with a
 * space (a trailing hyphen joins the word).
 */
export function linesToParagraphs(lines: TextLine[]): string[] {
  if (!lines.length) return [];
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0) gaps.push(g);
  }
  const sorted = gaps.slice().sort((a, b) => a - b);
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 4)] : lines[0].h * 1.2;
  const out: string[] = [];
  let para = lines[0].text;
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    const bigger = Math.abs(lines[i].h - lines[i - 1].h) > Math.max(1.5, lines[i - 1].h * 0.2);
    if (gap <= 0 || gap > Math.max(typical * 1.45, lines[i - 1].h * 1.9) || bigger) {
      out.push(para);
      para = lines[i].text;
    } else if (/[A-Za-zÀ-ÿ]-$/.test(para)) {
      para = para.slice(0, -1) + lines[i].text;
    } else {
      para += " " + lines[i].text;
    }
  }
  out.push(para);
  return out;
}

/** Paragraphs per page of a whole PDF. */
export async function extractParagraphs(pdf: PDFDocumentProxy, order?: number[]): Promise<string[][]> {
  const pages = order ?? Array.from({ length: pdf.numPages }, (_, i) => i);
  const out: string[][] = [];
  for (const i of pages) {
    const page = await pdf.getPage(i + 1);
    const tc = await page.getTextContent();
    out.push(linesToParagraphs(itemsToLines(tc.items as Item[])));
    page.cleanup();
  }
  return out;
}
