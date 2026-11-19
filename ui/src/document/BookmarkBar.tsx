/**
 * Draggable "Éditeur Filenymous" bookmark pill, and the "Add to bookmarks"
 * dialog (Fichier menu). The href is a plain https URL so a drag onto the
 * bookmarks bar works in every browser.
 */
import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { bookmarkBrowser, EDITOR_BOOKMARK_HREF, handleBookmarkClick, type BookmarkBrowser } from "./bookmark";

const overlayRoot = () => (document.querySelector(".pz-app") as HTMLElement | null) ?? document.body;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function bookmarkMod(): string {
  return isMac ? "⌘" : "Ctrl";
}

export function BookmarkLink({ className, testId = "doc-bookmark-link", showHints = false }: { className?: string; testId?: string; showHints?: boolean }) {
  const { t } = useTranslation();
  const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    handleBookmarkClick(e);
  };
  return (
    <span className={`doc-bookmark${className ? ` ${className}` : ""}`}>
      <a
        className="doc-bookmark-pill"
        href={EDITOR_BOOKMARK_HREF}
        title={t("document.bookmark.title")}
        draggable="true"
        onClick={onClick}
        data-testid={testId}
      >
        {t("document.bookmark.pill")}
      </a>
      {showHints && (
        <span className="doc-bookmark-hints">
          <span>{t("document.bookmark.dragHint")}</span>
          <span>{t("document.bookmark.shortcutHint", { mod: bookmarkMod() })}</span>
          <span>{t("document.bookmark.showBar", { mod: bookmarkMod() })}</span>
        </span>
      )}
    </span>
  );
}

export function BookmarkDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const kind = bookmarkBrowser();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLButtonElement>("button, a")?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("keydown", esc, true);
      prev?.focus?.();
    };
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(EDITOR_BOOKMARK_HREF);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const howto: Record<BookmarkBrowser, string> = {
    chromium: t("document.bookmark.howtoChrome", { mod: bookmarkMod() }),
    firefox: t("document.bookmark.howtoFirefox", { mod: bookmarkMod() }),
    safari: t("document.bookmark.howtoSafari", { mod: bookmarkMod() }),
  };

  return createPortal(
    <div className="doc-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="doc-modal doc-bookmark-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} ref={box} data-testid="doc-bookmark-dialog">
        <h2 id={`${id}-t`}>{t("document.bookmark.dialogTitle")}</h2>
        <p className="doc-hint">{t("document.bookmark.dialogLead")}</p>
        <BookmarkLink showHints testId="doc-bookmark-dialog-link" />
        <div className="doc-row doc-modal-actions">
          <button type="button" className="pz-btn" onClick={() => void copy()} data-testid="doc-bookmark-copy">
            {copied ? t("document.bookmark.copied") : t("document.bookmark.copy")}
          </button>
          <span className="doc-spacer" />
          <button type="button" className="pz-btn-ghost" onClick={onClose}>{t("document.ui.cancel")}</button>
        </div>
        <p className="doc-bookmark-howto" data-testid="doc-bookmark-howto">{howto[kind]}</p>
        {kind !== "chromium" && <p className="doc-hint">{t("document.bookmark.howtoChrome", { mod: bookmarkMod() })}</p>}
        {kind !== "firefox" && <p className="doc-hint">{t("document.bookmark.howtoFirefox", { mod: bookmarkMod() })}</p>}
        {kind !== "safari" && <p className="doc-hint">{t("document.bookmark.howtoSafari", { mod: bookmarkMod() })}</p>}
        <p className="doc-hint">{t("document.bookmark.limit")}</p>
      </div>
    </div>,
    overlayRoot(),
  );
}

/** Fichier-menu entry + dialog, shared by the text and PDF modes. */
export function useBookmarkMenu(): { item: { id: string; label: string; onSelect: () => void }; dialog: ReactNode } {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return {
    item: { id: "bookmark", label: t("document.bookmark.add"), onSelect: () => setOpen(true) },
    dialog: open ? <BookmarkDialog onClose={() => setOpen(false)} /> : null,
  };
}
