/**
 * ShareWall snapshot — export / import of an ephemeral wall state.
 * Host-only, entirely local. No server involvement.
 *
 * Format (JSON):
 * {
 *   v: 1,
 *   title: string,
 *   exportedAt: number,
 *   burn: boolean,
 *   hostLeave: boolean,
 *   posts: Post[],          // from feed.ts
 *   items: SnapshotItem[]   // metadata + base64 data
 * }
 *
 * Items larger than ~50 MiB are omitted with a warning (browser memory limits).
 */

import type { Post } from "./feed";
import type { ItemMeta } from "./model";

export interface SnapshotItem {
  meta: ItemMeta;
  /** base64 of the raw bytes. Omitted if too large. */
  dataB64?: string;
  skipped?: boolean;
}

export interface WallSnapshot {
  v: 1;
  title: string;
  exportedAt: number;
  burn: boolean;
  hostLeave: boolean;
  posts: Post[];
  items: SnapshotItem[];
}

const MAX_ITEM_B64 = 50 * 1024 * 1024; // ~37.5 MiB raw after base64 overhead

async function blobToB64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function b64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function buildSnapshot(
  title: string,
  burn: boolean,
  hostLeave: boolean,
  posts: Post[],
  getItem: (id: string) => { meta: ItemMeta; data: Blob } | undefined,
): Promise<WallSnapshot> {
  const items: SnapshotItem[] = [];
  for (const post of posts) {
    if (!post.item) continue;
    const stored = getItem(post.item.id);
    if (!stored) continue;
    if (stored.data.size > MAX_ITEM_B64) {
      items.push({ meta: stored.meta, skipped: true });
      continue;
    }
    const dataB64 = await blobToB64(stored.data);
    items.push({ meta: stored.meta, dataB64 });
  }
  return {
    v: 1,
    title,
    exportedAt: Date.now(),
    burn,
    hostLeave,
    posts,
    items,
  };
}

export function downloadSnapshot(snap: WallSnapshot, filename = "filenymous-wall.json") {
  const json = JSON.stringify(snap, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseSnapshot(json: string): WallSnapshot | null {
  try {
    const o = JSON.parse(json);
    if (o?.v !== 1 || !Array.isArray(o.posts) || !Array.isArray(o.items)) return null;
    return o as WallSnapshot;
  } catch {
    return null;
  }
}

export function snapshotItemToBlob(item: SnapshotItem): Blob | null {
  if (!item.dataB64) return null;
  return b64ToBlob(item.dataB64, item.meta.mime);
}
