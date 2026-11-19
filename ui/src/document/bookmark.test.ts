import { describe, expect, it } from "vitest";
import {
  activateNewDocument,
  bookmarkBrowser,
  EDITOR_BOOKMARK_HREF,
  EDITOR_NEW_EVENT,
  isFilenymousApp,
  isNewDocumentHash,
  shouldInterceptBookmarkClick,
} from "./bookmark";

describe("editor bookmark", () => {
  it("uses the public https URL, not a bookmarklet", () => {
    expect(EDITOR_BOOKMARK_HREF).toBe("https://filenymous.eu/app/#document-new");
    expect(EDITOR_BOOKMARK_HREF.startsWith("javascript:")).toBe(false);
    expect(EDITOR_BOOKMARK_HREF.startsWith("https://")).toBe(true);
  });

  it("recognises the new-document hashes", () => {
    expect(isNewDocumentHash("#document-new")).toBe(true);
    expect(isNewDocumentHash("#doc-new")).toBe(true);
    expect(isNewDocumentHash("#document")).toBe(false);
    expect(isNewDocumentHash("")).toBe(false);
  });

  it("intercepts only a plain left-click already inside the app", () => {
    const base = { inApp: true, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(shouldInterceptBookmarkClick(base)).toBe(true);
    expect(shouldInterceptBookmarkClick({ ...base, inApp: false })).toBe(false);
    expect(shouldInterceptBookmarkClick({ ...base, button: 1 })).toBe(false);
    expect(shouldInterceptBookmarkClick({ ...base, metaKey: true })).toBe(false);
    expect(shouldInterceptBookmarkClick({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldInterceptBookmarkClick({ ...base, shiftKey: true })).toBe(false);
    expect(shouldInterceptBookmarkClick({ ...base, altKey: true })).toBe(false);
  });

  it("dispatches an event when the hash is already #document-new", () => {
    const seen: string[] = [];
    const on = (e: Event) => seen.push(e.type);
    window.addEventListener(EDITOR_NEW_EVENT, on);
    expect(activateNewDocument("#document-new")).toBe("event");
    expect(seen).toEqual([EDITOR_NEW_EVENT]);
    window.removeEventListener(EDITOR_NEW_EVENT, on);
  });

  it("detects the app root and the browser family", () => {
    const root = document.createElement("div");
    expect(isFilenymousApp(root)).toBe(false);
    root.innerHTML = '<div class="pz-app"></div>';
    expect(isFilenymousApp(root)).toBe(true);
    expect(bookmarkBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")).toBe("chromium");
    expect(bookmarkBrowser("Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0")).toBe("firefox");
    expect(bookmarkBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")).toBe("safari");
  });
});
