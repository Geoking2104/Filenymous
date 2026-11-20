/**
 * "A document is still active" signal for the logo badge, the tab title, the
 * favicon dot and the installed-app badge. Kept tiny and dependency-free:
 * the home shell imports it without loading the Document tab.
 *
 * Rule (decision 2, 20/11/2026): the badge shows ONLY when the active
 * document changed since its last export (Save as PDF / MD). No grey state.
 *
 * Sources:
 *  - the persisted text document: a small meta record in localStorage
 *    (`fny.document.active.v1`), synced across tabs by the `storage` event and
 *    a BroadcastChannel;
 *  - a PDF with unsaved edits in THIS tab (PDFs are not persisted by default,
 *    so it only counts during the session).
 */
import { useEffect, useState } from "react";

export const META_KEY = "fny.document.active.v1";
const CHANNEL = "fny-document";
const LOCAL_EVENT = "fny-document-active";

export interface ActiveMeta {
  name: string;
  updatedAt: number;
  exportedAt?: number;
}

export function isUnexported(m: ActiveMeta | null | undefined): boolean {
  return !!m && typeof m.updatedAt === "number" && (m.exportedAt ?? 0) < m.updatedAt;
}

export function readMeta(): ActiveMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as ActiveMeta;
    return typeof m?.name === "string" && typeof m?.updatedAt === "number" ? m : null;
  } catch {
    return null;
  }
}

let channel: BroadcastChannel | null | undefined;
function bc(): BroadcastChannel | null {
  if (channel === undefined) {
    try {
      channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
      channel?.addEventListener("message", () => notifyLocal());
    } catch {
      channel = null;
    }
  }
  return channel;
}

function notifyLocal() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOCAL_EVENT));
}

/** Writes (or clears with null) the meta and tells this tab and the others. */
export function writeMeta(m: ActiveMeta | null): void {
  try {
    if (m) localStorage.setItem(META_KEY, JSON.stringify({ name: m.name, updatedAt: m.updatedAt, exportedAt: m.exportedAt }));
    else localStorage.removeItem(META_KEY);
  } catch {
    /* private mode: the badge just stays local */
  }
  notifyLocal();
  try {
    bc()?.postMessage({ type: "meta" });
  } catch {
    /* closed */
  }
}

let pdfUnsaved: string | null = null;

/** The Document tab reports a PDF with unsaved edits (name) or none (null). */
export function setPdfUnsaved(name: string | null): void {
  if (pdfUnsaved === name) return;
  pdfUnsaved = name;
  notifyLocal();
}

export interface ActiveDocState {
  /** A persisted text document exists (exported or not). */
  stored: ActiveMeta | null;
  /** Show the badge: something changed since its last export. */
  unexported: boolean;
  /** Name of the unexported document, for the tooltip. */
  name: string | null;
  updatedAt: number | null;
}

export function activeDocState(): ActiveDocState {
  const stored = readMeta();
  if (pdfUnsaved) return { stored, unexported: true, name: pdfUnsaved, updatedAt: null };
  const un = isUnexported(stored);
  return { stored, unexported: un, name: un ? stored!.name : null, updatedAt: un ? stored!.updatedAt : null };
}

export function subscribeActiveDoc(fn: () => void): () => void {
  bc();
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === META_KEY) fn();
  };
  window.addEventListener(LOCAL_EVENT, fn);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LOCAL_EVENT, fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function useActiveDocument(): ActiveDocState {
  const [s, setS] = useState(activeDocState);
  useEffect(() => {
    const update = () => setS(activeDocState());
    update();
    return subscribeActiveDoc(update);
  }, []);
  return s;
}

/* ── side effects outside the page: tab title, favicon dot, app badge ── */

export const TITLE_MARK = "• ";

export function markTitle(title: string, on: boolean): string {
  const base = title.startsWith(TITLE_MARK) ? title.slice(TITLE_MARK.length) : title;
  return on ? TITLE_MARK + base : base;
}

const ORIGINAL = "fnyHref";
let faviconToken = 0;

function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

/** Draws an orange dot on the 32 px favicon, or restores the original icons. */
export function setFaviconDot(on: boolean): void {
  if (typeof document === "undefined") return;
  const token = ++faviconToken;
  const links = iconLinks();
  if (!on) {
    for (const l of links) {
      const orig = l.dataset[ORIGINAL];
      if (orig !== undefined) {
        l.href = orig;
        if (l.dataset.fnyType) l.type = l.dataset.fnyType;
        delete l.dataset[ORIGINAL];
        delete l.dataset.fnyType;
      }
    }
    return;
  }
  const source = links.find((l) => /32/.test(l.sizes?.value ?? "")) ?? links[0];
  if (!source) return;
  const src = source.dataset[ORIGINAL] ?? source.href;
  const img = new Image();
  img.onload = () => {
    if (token !== faviconToken) return;
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 32;
      const g = c.getContext("2d");
      if (!g) return;
      g.drawImage(img, 0, 0, 32, 32);
      g.beginPath();
      g.arc(24, 8, 7, 0, Math.PI * 2);
      g.fillStyle = "#f97316";
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = "#ffffff";
      g.stroke();
      const url = c.toDataURL("image/png");
      for (const l of iconLinks()) {
        if (l.dataset[ORIGINAL] === undefined) {
          l.dataset[ORIGINAL] = l.getAttribute("href") ?? "";
          l.dataset.fnyType = l.type;
        }
        l.type = "image/png";
        l.href = url;
      }
    } catch {
      /* canvas unavailable */
    }
  };
  img.src = src;
}

type BadgeNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

/** Installed PWA only (Chrome/Edge/Safari): a dot on the app icon. */
export function setAppBadge(on: boolean): void {
  if (typeof navigator === "undefined") return;
  const n = navigator as BadgeNavigator;
  try {
    const p = on ? n.setAppBadge?.() : n.clearAppBadge?.();
    void p?.catch(() => undefined);
  } catch {
    /* unsupported */
  }
}
