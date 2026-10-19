/**
 * ShareWall snapshot: the host's local export of an ephemeral wall.
 *
 * Entirely client-side. Nothing is sent to any server; the only network effect
 * of an export is the transparency notice the host posts in its own sealed
 * feed. Self-destruct (burn-after-one-download) walls cannot be exported.
 *
 * JSON format v1:
 *   { format: "filenymous-wall-snapshot", v: 1, title, exportedAt, burn: false,
 *     members: [{ label, name, host?, agent? }], posts: Post[],
 *     items: [{ id, meta, dataB64 }], skipped: [{ id, name, size, reason }] }
 *
 * Importing is deliberately NOT wired in the UI. parseSnapshot() only exists so
 * a future viewer has a strict, non-executing validator: it rebuilds every
 * post through cleanPost/cleanMeta, enforces size caps, and
 * snapshotItemToBlob() never trusts the stored MIME type (no text/html, SVG…).
 */
import { cleanMember, cleanName, cleanPost, MAX_POSTS, type Member, type Post } from "./feed";
import { cleanMeta, type ItemMeta } from "./model";

export const SNAPSHOT_FORMAT = "filenymous-wall-snapshot";
/** Files larger than this (raw bytes) are skipped, matching the wall's upload cap. */
export const MAX_EXPORT_ITEM_BYTES = 50 * 1024 * 1024;
/** Total raw bytes of embedded files per export. */
export const MAX_EXPORT_TOTAL_BYTES = 200 * 1024 * 1024;
/** Hard cap on a snapshot file accepted by parseSnapshot. */
export const MAX_SNAPSHOT_CHARS = Math.ceil((MAX_EXPORT_TOTAL_BYTES * 4) / 3) + 8 * 1024 * 1024;

export type SkipReason = "too-large" | "budget" | "unavailable";

export interface SnapshotMember { label: string; name: string; host?: boolean; agent?: boolean }
export interface SnapshotItem { id: string; meta: ItemMeta; dataB64: string }
export interface SnapshotSkipped { id: string; name: string; size: number; reason: SkipReason }

export interface WallSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  v: 1;
  title: string;
  exportedAt: number;
  burn: false;
  members: SnapshotMember[];
  posts: Post[];
  items: SnapshotItem[];
  skipped: SnapshotSkipped[];
}

export interface SnapshotSource {
  title?: string;
  burn: boolean;
  members: Member[];
  posts: Post[];
  /** Non-consuming access to an item's bytes (host only). */
  getItem: (id: string) => { meta: ItemMeta; data: Blob } | null;
  now?: number;
}

export class ExportBlockedError extends Error {
  constructor() {
    super("export is disabled on self-destruct walls");
    this.name = "ExportBlockedError";
  }
}

/** Base64 in 32 KiB chunks (no quadratic string building, no call-stack blowup). */
export function bytesToB64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK))));
  }
  return btoa(parts.join(""));
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function blobBytes(b: Blob): Promise<Uint8Array> {
  if (typeof b.arrayBuffer === "function") return new Uint8Array(await b.arrayBuffer());
  return new Uint8Array(await new Response(b).arrayBuffer());
}

export async function buildSnapshot(src: SnapshotSource): Promise<WallSnapshot> {
  if (src.burn) throw new ExportBlockedError();
  const posts = src.posts.slice(-MAX_POSTS).map((p) => structuredCloneSafe(p));
  const items: SnapshotItem[] = [];
  const skipped: SnapshotSkipped[] = [];
  let budget = MAX_EXPORT_TOTAL_BYTES;
  for (const p of posts) {
    if (!p.item) continue;
    const meta = p.item;
    if (meta.size > MAX_EXPORT_ITEM_BYTES) { skipped.push({ id: p.id, name: meta.name, size: meta.size, reason: "too-large" }); continue; }
    if (meta.size > budget) { skipped.push({ id: p.id, name: meta.name, size: meta.size, reason: "budget" }); continue; }
    const got = src.getItem(p.id);
    if (!got) { skipped.push({ id: p.id, name: meta.name, size: meta.size, reason: "unavailable" }); continue; }
    const bytes = await blobBytes(got.data);
    if (bytes.length > MAX_EXPORT_ITEM_BYTES || bytes.length > budget) {
      skipped.push({ id: p.id, name: meta.name, size: bytes.length, reason: bytes.length > MAX_EXPORT_ITEM_BYTES ? "too-large" : "budget" });
      continue;
    }
    budget -= bytes.length;
    items.push({ id: p.id, meta: got.meta, dataB64: bytesToB64(bytes) });
  }
  return {
    format: SNAPSHOT_FORMAT,
    v: 1,
    title: cleanName(src.title ?? "") || "",
    exportedAt: src.now ?? Date.now(),
    burn: false,
    members: src.members.map((m) => ({ label: m.label, name: m.name, ...(m.host ? { host: true } : {}), ...(m.agent ? { agent: true } : {}) })),
    posts,
    items,
    skipped,
  };
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Plain-text Markdown transcript (no file contents). */
export function buildTranscript(s: Pick<WallSnapshot, "title" | "exportedAt" | "members" | "posts">, lang: "fr" | "en" = "fr"): string {
  const names = new Map(s.members.map((m) => [m.label, m.name]));
  const who = (l: string) => names.get(l) ?? (l === "host" ? (lang === "fr" ? "Hôte" : "Host") : l);
  const iso = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const L = lang === "fr"
    ? { h: "Mur Filenymous", exp: "Exporté le", warn: "Copie locale d'un contenu éphémère. Les participants n'ont pas donné leur accord : à manipuler avec soin.", file: "Fichier", note: "Note masquée", poll: "Sondage" }
    : { h: "Filenymous wall", exp: "Exported", warn: "Local copy of ephemeral content. Participants were not asked: handle with care.", file: "File", note: "Masked note", poll: "Poll" };
  const out: string[] = [`# ${L.h}${s.title ? ` — ${s.title}` : ""}`, "", `${L.exp} ${iso(s.exportedAt)}`, "", `> ${L.warn}`, ""];
  for (const p of s.posts) {
    const head = `**${who(p.by)}** · ${iso(p.at)}`;
    let body = "";
    if (p.kind === "msg") body = p.text ?? "";
    else if (p.kind === "poll" && p.poll) body = `${L.poll} : ${p.poll.question}\n${p.poll.options.map((o, i) => `- ${o} (${p.poll!.votes?.[i]?.length ?? 0})`).join("\n")}`;
    else if (p.item) body = `${p.kind === "note" ? L.note : L.file} : ${p.item.name}${p.kind === "note" ? "" : ` (${p.item.size} B)`}`;
    out.push(head, "", body.split("\n").map((l) => `    ${l}`).join("\n"), "");
  }
  return out.join("\n");
}

/** filenymous-mur-<slug>-<YYYY-MM-DD>.<ext>, safe on every filesystem. */
export function snapshotFilename(title: string | undefined, ext: "json" | "md", now = Date.now()): string {
  const slug = (title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "sans-nom";
  const d = new Date(now);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `filenymous-mur-${slug}-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.${ext}`;
}

/** Saves a blob locally. The object URL is revoked later so the download can start. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function snapshotBlob(s: WallSnapshot): Blob {
  return new Blob([JSON.stringify(s)], { type: "application/json" });
}

/**
 * Strict validator for a snapshot file (import is not wired in the UI).
 * Never evaluates anything: JSON.parse + field-by-field rebuild.
 */
export function parseSnapshot(raw: string): WallSnapshot | null {
  if (typeof raw !== "string" || raw.length > MAX_SNAPSHOT_CHARS) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const s = o as Record<string, unknown>;
  if (s.format !== SNAPSHOT_FORMAT || s.v !== 1 || s.burn !== false) return null;
  if (typeof s.exportedAt !== "number" || !Number.isFinite(s.exportedAt)) return null;
  if (!Array.isArray(s.posts) || s.posts.length > MAX_POSTS) return null;
  if (!Array.isArray(s.members) || s.members.length > 64) return null;
  if (!Array.isArray(s.items) || s.items.length > MAX_POSTS) return null;
  if (!Array.isArray(s.skipped) || s.skipped.length > MAX_POSTS) return null;
  const posts: Post[] = [];
  for (const p of s.posts) { const c = cleanPost(p, cleanMeta); if (!c) return null; posts.push(c); }
  const members: SnapshotMember[] = [];
  for (const m of s.members) { const c = cleanMember(m); if (!c) return null; members.push({ label: c.label, name: c.name, ...(c.host ? { host: true } : {}), ...(c.agent ? { agent: true } : {}) }); }
  const ids = new Set(posts.map((p) => p.id));
  const items: SnapshotItem[] = [];
  let total = 0;
  for (const it of s.items) {
    if (!it || typeof it !== "object") return null;
    const r = it as Record<string, unknown>;
    const meta = cleanMeta(r.meta);
    if (!meta || typeof r.id !== "string" || !ids.has(r.id) || typeof r.dataB64 !== "string") return null;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(r.dataB64)) return null;
    const size = Math.floor((r.dataB64.length * 3) / 4);
    total += size;
    if (size > MAX_EXPORT_ITEM_BYTES + 3 || total > MAX_EXPORT_TOTAL_BYTES + 3 * items.length + 3) return null;
    items.push({ id: r.id, meta, dataB64: r.dataB64 });
  }
  const skipped: SnapshotSkipped[] = [];
  for (const k of s.skipped) {
    const r = (k ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.size !== "number" || !["too-large", "budget", "unavailable"].includes(r.reason as string)) return null;
    skipped.push({ id: r.id.slice(0, 64), name: r.name.slice(0, 255), size: r.size, reason: r.reason as SkipReason });
  }
  return { format: SNAPSHOT_FORMAT, v: 1, title: cleanName(s.title ?? ""), exportedAt: s.exportedAt, burn: false, members, posts, items, skipped };
}

const SAFE_MIME = /^(image\/(png|jpeg|gif|webp|avif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|text\/plain|application\/pdf)$/;

/** Blob for an imported item; unknown or active types (HTML, SVG, JS…) become octet-stream. */
export function snapshotItemToBlob(it: SnapshotItem): Blob {
  const mime = SAFE_MIME.test(it.meta.mime) ? it.meta.mime : "application/octet-stream";
  return new Blob([b64ToBytes(it.dataB64) as BlobPart], { type: mime });
}
