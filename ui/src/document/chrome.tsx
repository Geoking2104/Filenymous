/**
 * Word-like chrome shared by the PDF and text modes of the Document tab:
 * menu bar, context menu, editable file name, "Save as" dialog, shortcuts.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { sanitizeStem, type SaveFormat } from "./fileName";

export type MenuEntry =
  | { sep: true }
  | { sep?: false; id: string; label: string; shortcut?: string; onSelect: () => void; disabled?: boolean; checked?: boolean; icon?: ReactNode };
export interface Menu {
  id: string;
  label: string;
  items: MenuEntry[];
}

/**
 * Fixed overlays are portalled to the app root: the animated main column has a
 * transform, which would otherwise become their containing block. The root
 * keeps the theme variables.
 */
const overlayRoot = () => (document.querySelector(".pz-app") as HTMLElement | null) ?? document.body;

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** "Ctrl+S" → "⌘S" on macOS. */
export const kbd = (s: string) => (isMac ? s.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧") : s);

/** Items of a menu (dropdown or context menu), keyboard navigable. */
function MenuList({ items, onClose, label, autoFocus, testId }: { items: MenuEntry[]; onClose: (refocus?: boolean) => void; label: string; autoFocus?: boolean; testId?: string }) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [autoFocus]);
  const onKey = (e: ReactKeyboardEvent) => {
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") (e.preventDefault(), btns[(i + 1) % btns.length]?.focus());
    else if (e.key === "ArrowUp") (e.preventDefault(), btns[(i - 1 + btns.length) % btns.length]?.focus());
    else if (e.key === "Home") (e.preventDefault(), btns[0]?.focus());
    else if (e.key === "End") (e.preventDefault(), btns[btns.length - 1]?.focus());
    else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onClose(true));
    else if (e.key === "Tab") onClose();
  };
  return (
    <ul className="doc-menu-list" role="menu" aria-label={label} ref={ref} onKeyDown={onKey} data-testid={testId}>
      {items.map((it, k) =>
        it.sep ? (
          <li key={`sep-${k}`} role="separator" className="doc-menu-sep" />
        ) : (
          <li key={it.id} role="none">
            <button
              type="button"
              role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={it.checked}
              disabled={it.disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onClose();
                it.onSelect();
              }}
              data-testid={`doc-menu-${it.id}`}
            >
              <span className="doc-menu-icon" aria-hidden="true">{it.checked ? "✓" : it.icon}</span>
              <span className="doc-menu-label">{it.label}</span>
              {it.shortcut && <kbd>{kbd(it.shortcut)}</kbd>}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

export function MenuBar({ menus, label }: { menus: Menu[]; label: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [kb, setKb] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !bar.current?.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(null);
    };
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", off);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  const focusTop = (id: string) => bar.current?.querySelector<HTMLButtonElement>(`[data-menu="${id}"]`)?.focus();
  const step = (id: string, by: number) => {
    const i = menus.findIndex((m) => m.id === id);
    return menus[(i + by + menus.length) % menus.length].id;
  };
  return (
    <div className="doc-menubar" role="menubar" aria-label={label} ref={bar} data-testid="doc-menubar">
      {menus.map((m) => (
        <div key={m.id} className="doc-menu">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === m.id}
            className={open === m.id ? "on" : ""}
            data-menu={m.id}
            data-testid={`doc-menubar-${m.id}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              setKb(e.detail === 0);
              setOpen((o) => (o === m.id ? null : m.id));
            }}
            onMouseEnter={() => open && open !== m.id && setOpen(m.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setKb(true), setOpen(m.id));
              else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const n = step(m.id, e.key === "ArrowRight" ? 1 : -1);
                focusTop(n);
                if (open) setOpen(n);
              }
            }}
          >
            {m.label}
          </button>
          {open === m.id && (
            <div
              className="doc-menu-pop"
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const n = step(m.id, e.key === "ArrowRight" ? 1 : -1);
                  setOpen(n);
                  setKb(true);
                }
              }}
            >
              <MenuList items={m.items} label={m.label} autoFocus={kb} testId={`doc-menu-${m.id}-list`} onClose={(refocus) => (setOpen(null), refocus && focusTop(m.id))} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ContextMenu({ x, y, items, label, onClose }: { x: number; y: number; items: MenuEntry[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    }
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", off);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [x, y, onClose]);
  return createPortal(
    <div className="doc-menu-pop doc-context" style={{ left: pos.x, top: pos.y }} ref={ref} data-testid="doc-context">
      <MenuList items={items} label={label} autoFocus onClose={onClose} />
    </div>,
    overlayRoot(),
  );
}

/** File name in the header: the stem is edited in place, the extension follows the save format. */
export function NameField({ stem, ext, onRename, inputRef, disabled }: { stem: string; ext?: string; onRename: (s: string) => void; inputRef?: RefObject<HTMLInputElement>; disabled?: boolean }) {
  const { t } = useTranslation();
  const [v, setV] = useState(stem);
  useEffect(() => setV(stem), [stem]);
  const commit = () => {
    const s = sanitizeStem(v);
    setV(s);
    if (s !== stem) onRename(s);
  };
  return (
    <span className="doc-name" title={ext ? `${stem}.${ext}` : stem} data-testid="doc-name">
      <span aria-hidden="true">📄</span>
      <input
        ref={inputRef}
        value={v}
        disabled={disabled}
        aria-label={t("document.ui.rename")}
        spellCheck={false}
        size={Math.max(8, Math.min(48, v.length + 1))}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.preventDefault(), commit(), e.currentTarget.blur());
          if (e.key === "Escape") (setV(stem), e.currentTarget.blur());
        }}
        data-testid="doc-name-input"
      />
      {ext && <span className="doc-name-ext">.{ext}</span>}
    </span>
  );
}

export type SaveAction = "download" | "send" | "safe";

export function SaveAsDialog({ stem, format, intent, onCancel, onConfirm, mdNote }: { stem: string; format: SaveFormat; intent: SaveAction; onCancel: () => void; onConfirm: (stem: string, format: SaveFormat, action: SaveAction) => void; mdNote?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(stem);
  const [fmt, setFmt] = useState<SaveFormat>(format);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    input.current?.select();
    return () => prev?.focus?.();
  }, []);
  const go = (action: SaveAction) => onConfirm(sanitizeStem(name), fmt, action);
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onCancel());
    if (e.key !== "Tab") return;
    const f = Array.from(box.current?.querySelectorAll<HTMLElement>("input, button") ?? []).filter((el) => !(el as HTMLButtonElement).disabled);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) (e.preventDefault(), f[f.length - 1].focus());
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) (e.preventDefault(), f[0].focus());
  };
  const primary = (a: SaveAction) => (a === intent ? "pz-btn" : "pz-btn-ghost");
  return createPortal(
    <div className="doc-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="doc-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} ref={box} onKeyDown={trap} data-testid="doc-saveas">
        <h2 id={`${id}-t`}>{t("document.ui.saveAsTitle")}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go(intent);
          }}
        >
          <label className="doc-field">
            <span>{t("document.ui.fileName")}</span>
            <span className="doc-saveas-name">
              <input ref={input} value={name} onChange={(e) => setName(e.target.value)} data-testid="doc-saveas-name" />
              <span>.{fmt}</span>
            </span>
          </label>
          <fieldset className="doc-fieldset">
            <legend className="doc-hint">{t("document.ui.format")}</legend>
            <label className="doc-radio">
              <input type="radio" name={`${id}-fmt`} checked={fmt === "pdf"} onChange={() => setFmt("pdf")} data-testid="doc-saveas-pdf" /> PDF
            </label>
            <label className="doc-radio">
              <input type="radio" name={`${id}-fmt`} checked={fmt === "md"} onChange={() => setFmt("md")} data-testid="doc-saveas-md" /> Markdown (.md)
            </label>
          </fieldset>
          {fmt === "md" && mdNote && <p className="doc-hint">{mdNote}</p>}
          <div className="doc-row doc-modal-actions">
            <button type="button" className="pz-btn-ghost" onClick={onCancel}>{t("document.ui.cancel")}</button>
            <span className="doc-spacer" />
            <button type="button" className={primary("safe")} onClick={() => go("safe")} data-testid="doc-saveas-safe">🔐 {t("document.ui.toSafe")}</button>
            <button type="button" className={primary("send")} onClick={() => go("send")} data-testid="doc-saveas-send">↗ {t("document.ui.send")}</button>
            <button type="submit" className={primary("download")} onClick={(e) => (e.preventDefault(), go("download"))} data-testid="doc-saveas-download">⬇ {t("document.ui.download")}</button>
          </div>
        </form>
      </div>
    </div>,
    overlayRoot(),
  );
}

/** Ctrl (Cmd on macOS) pressed. */
export const mod = (e: KeyboardEvent | ReactKeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

/** Typing in a text field (not the editor): leave the keys to the field. */
export const inField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el?.tagName) return false;
  return (el.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((el as HTMLInputElement).type)) || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
};

/** Keyboard shortcuts of the panel, active while it is mounted. */
export function useShortcuts(handler: (e: KeyboardEvent) => boolean) {
  const h = useRef(handler);
  h.current = handler;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Another dialog of the app is open on top of the panel.
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[role="dialog"]') && !t.closest(".doc-modal")) return;
      if (h.current(e)) e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
}

export function ToolButton({ label, shortcut, onClick, active, disabled, children, testId, className }: { label: string; shortcut?: string; onClick: () => void; active?: boolean; disabled?: boolean; children: ReactNode; testId?: string; className?: string }) {
  return (
    <button
      type="button"
      className={`doc-tb-btn${active ? " on" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={shortcut ? `${label} (${kbd(shortcut)})` : label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

/** Format picker + destinations, shared with the PDF mode. */
export function ExportBar({ busy, onRun, mdTitle }: { busy: boolean; onRun: (f: SaveFormat, a: SaveAction) => void; mdTitle?: string }) {
  const { t } = useTranslation();
  const [fmt, setFmt] = useState<SaveFormat>("pdf");
  return (
    <div className="doc-export" data-testid="doc-export">
      <label className="doc-export-fmt">
        <span>{t("document.ui.format")}</span>
        <select value={fmt} onChange={(e) => setFmt(e.target.value as SaveFormat)} data-testid="doc-format" title={fmt === "md" ? mdTitle : undefined}>
          <option value="pdf">PDF</option>
          <option value="md">Markdown (.md)</option>
        </select>
      </label>
      <button type="button" className="pz-btn" disabled={busy} data-testid="doc-download" onClick={() => onRun(fmt, "download")}>⬇ {t("document.ui.download")}</button>
      <button type="button" className="pz-btn" disabled={busy} data-testid="doc-send" onClick={() => onRun(fmt, "send")}>↗ {t("document.send")}</button>
      <button type="button" className="pz-btn-ghost" disabled={busy} data-testid="doc-to-safe" onClick={() => onRun(fmt, "safe")}>🔐 {t("document.toSafe")}</button>
    </div>
  );
}

