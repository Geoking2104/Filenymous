/**
 * Helpers for the "Éditeur Filenymous" bookmarks-bar shortcut.
 *
 * Browsers refuse to add a bookmark programmatically (a site must not fill
 * the user's bookmarks without a drag or Ctrl/Cmd+D). The link is a plain
 * https URL, not a javascript: bookmarklet, so it works in every browser
 * and under a CSP that forbids bookmarklets.
 */

export const EDITOR_BOOKMARK_HREF = "https://filenymous.eu/app/#document-new";
export const EDITOR_NEW_EVENT = "filenymous-document-new";

export function isNewDocumentHash(hash: string): boolean {
  return hash === "#document-new" || hash === "#doc-new";
}

export function isFilenymousApp(root: ParentNode | null | undefined = typeof document !== "undefined" ? document : null): boolean {
  return !!root?.querySelector?.(".pz-app");
}

/** Left-click, no modifier, already inside the app: open a document instead of leaving. */
export function shouldInterceptBookmarkClick(opts: {
  inApp: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return opts.inApp && opts.button === 0 && !opts.metaKey && !opts.ctrlKey && !opts.shiftKey && !opts.altKey;
}

/** Start a blank document in the already-running app, or navigate to #document-new. */
export function activateNewDocument(currentHash = typeof location !== "undefined" ? location.hash : ""): "event" | "hash" {
  if (isNewDocumentHash(currentHash)) {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(EDITOR_NEW_EVENT));
    return "event";
  }
  if (typeof location !== "undefined") location.hash = "#document-new";
  return "hash";
}

export function handleBookmarkClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }, inApp = isFilenymousApp()): boolean {
  if (!shouldInterceptBookmarkClick({ inApp, button: e.button, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey })) {
    return false;
  }
  e.preventDefault();
  activateNewDocument();
  return true;
}

/** Kick off the Document + TipTap chunks as soon as we know a blank editor is wanted. */
export function prefetchDocumentEditor(): void {
  void import("./DocumentPanel");
  void import("./TextEditor");
}

export type BookmarkBrowser = "safari" | "firefox" | "chromium";

export function bookmarkBrowser(ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): BookmarkBrowser {
  if (/Firefox\//i.test(ua)) return "firefox";
  // Safari includes "Safari" in every Chromium UA; exclude those.
  if (/Safari/i.test(ua) && !/Chrome|Chromium|Android|Edg\//i.test(ua)) return "safari";
  return "chromium";
}

/** PWA file-handler launches (Chromium installed apps). Harmless when unsupported. */
export function listenForFileLaunches(onFile: (file: File) => void): () => void {
  const lq = (typeof window !== "undefined" ? (window as unknown as { launchQueue?: LaunchQueue }) : undefined)?.launchQueue;
  if (!lq?.setConsumer) return () => undefined;
  let cancelled = false;
  lq.setConsumer(async (params) => {
    const handles = params.files ?? [];
    if (!handles.length || cancelled) return;
    try {
      const file = await handles[0].getFile();
      if (!cancelled && file) onFile(file);
    } catch {
      /* the handle may be stale */
    }
  });
  return () => {
    cancelled = true;
  };
}

interface LaunchQueue {
  setConsumer(cb: (params: { files?: Array<{ getFile: () => Promise<File> }> }) => void): void;
}
