import type { Task } from "./collab";
/**
 * Feed search + image annotation helpers.
 * Pure client-side; no protocol changes required for search.
 */

import type { Post } from "./feed";
import type { SharedNote } from "./notes";

/** Lower-case, accent-free form of one character ("É" → "e"), for matching. */
function foldChar(c: string): string {
  return c.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Folded text plus, for each folded code unit, the index of its source character. */
function fold(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(text.length);
  return { folded, map };
}

export const SEARCH_MAX_CHARS = 100;

/** Normalised query ("" = no filter). */
export function normalizeQuery(query: string): string {
  return fold(String(query ?? "").trim().replace(/\s+/g, " ").slice(0, SEARCH_MAX_CHARS)).folded;
}

const has = (v: string | undefined, q: string) => !!v && fold(v).folded.includes(q);

/**
 * Live filter of the feed: message text, file / note names, poll question and
 * options. Case- and accent-insensitive. Masked notes are matched by their
 * name only (their content is never fetched for searching).
 */
export function searchPosts(posts: Post[], query: string): Post[] {
  const q = normalizeQuery(query);
  if (!q) return posts;
  return posts.filter((p) => has(p.text, q) || has(p.item?.name, q) || has(p.poll?.question, q) || !!p.poll?.options.some((o) => has(o, q)));
}

const foldFast = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const noteFold = new WeakMap<SharedNote, string>();

/** Shared notes whose title or text matches (folded text cached per note version). */
export function searchNotes(notes: SharedNote[], query: string): SharedNote[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  return notes.filter((n) => {
    let f = noteFold.get(n);
    if (f === undefined) noteFold.set(n, (f = `${foldFast(n.title)}\n${foldFast(n.text)}`));
    return f.includes(q);
  });
}

/** A short excerpt of `text` around the first match (whole lines collapsed). */
/** Checklist items and decisions whose text matches (accent- and case-insensitive). */
export function searchTasks(tasks: Task[], query: string): Task[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  return tasks.filter((x) => has(x.text, q));
}

export function matchSnippet(text: string, query: string, around = 50): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const r = highlightRanges(flat, query)[0];
  if (!r) return flat.slice(0, around * 2);
  const start = Math.max(0, r[0] - around);
  const end = Math.min(flat.length, r[1] + around);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** [start, end) ranges of `query` in `text` (same folding as searchPosts), for highlighting. */
export function highlightRanges(text: string, query: string): Array<[number, number]> {
  const q = normalizeQuery(query);
  if (!q || !text) return [];
  const { folded, map } = fold(text);
  const out: Array<[number, number]> = [];
  for (let at = folded.indexOf(q); at >= 0 && out.length < 200; at = folded.indexOf(q, at + q.length)) {
    const start = map[at]!;
    const end = map[at + q.length] ?? text.length;
    if (end > start) out.push([start, end]);
  }
  return out;
}

/** Simple stroke annotation for images (serialized as JSON, stored as a special text item or note). */
export interface AnnotationStroke {
  tool: "pen" | "highlight" | "arrow";
  color: string;
  width: number;
  points: { x: number; y: number }[];
}

export interface ImageAnnotation {
  itemId: string;
  strokes: AnnotationStroke[];
  version: number;
}

export function serializeAnnotation(ann: ImageAnnotation): string {
  return JSON.stringify(ann);
}

export function parseAnnotation(raw: string): ImageAnnotation | null {
  try {
    const o = JSON.parse(raw);
    if (typeof o.itemId !== "string" || !Array.isArray(o.strokes)) return null;
    return o as ImageAnnotation;
  } catch {
    return null;
  }
}
