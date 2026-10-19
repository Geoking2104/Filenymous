/**
 * Feed search + image annotation helpers.
 * Pure client-side; no protocol changes required for search.
 */

import type { Post } from "./feed";

export function searchPosts(posts: Post[], query: string): Post[] {
  const q = query.trim().toLowerCase();
  if (!q) return posts;
  return posts.filter((p) => {
    if (p.text?.toLowerCase().includes(q)) return true;
    if (p.item?.name.toLowerCase().includes(q)) return true;
    if (p.poll?.question.toLowerCase().includes(q)) return true;
    if (p.poll?.options.some((o) => o.toLowerCase().includes(q))) return true;
    return false;
  });
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
