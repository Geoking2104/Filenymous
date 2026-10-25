/**
 * Shared dialog behaviour for every modal/popover in the app:
 * - Escape closes (only the top-most dialog when several are stacked);
 * - Tab / Shift+Tab stay inside the dialog (focus trap, modal dialogs only);
 * - focus moves into the dialog on open and returns to the opener on close.
 */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable=true]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden && el.getAttribute("aria-hidden") !== "true" && !el.closest("[inert]"));
}

/** Open dialogs, oldest first: only the last one reacts to keys. */
const stack: symbol[] = [];

export interface ModalOptions {
  /** Defaults to true. */
  open?: boolean;
  /** Keep Tab inside the dialog (default true; false for light popovers). */
  trap?: boolean;
  /** Element to focus first (default: the first focusable, else the dialog itself). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Do not move focus on open (the dialog manages it itself). */
  keepFocus?: boolean;
  /** Escape is ignored while false (e.g. an upload in progress). */
  canClose?: boolean;
}

export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void, opts: ModalOptions = {}): void {
  const { open = true, trap = true, keepFocus = false } = opts;
  const latest = useRef({ onClose, opts });
  latest.current = { onClose, opts };

  useEffect(() => {
    if (!open) return;
    const id = Symbol("modal");
    stack.push(id);
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (root && !keepFocus) {
      const first = latest.current.opts.initialFocus?.current ?? focusableIn(root)[0];
      if (first) first.focus();
      else {
        if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
        root.focus();
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      const el = ref.current;
      if (e.key === "Escape") {
        if (latest.current.opts.canClose === false) return;
        e.preventDefault();
        e.stopPropagation();
        latest.current.onClose();
        return;
      }
      if (e.key !== "Tab" || !trap || !el) return;
      const items = focusableIn(el);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && el.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture: runs before page-level shortcuts, so Escape closes the dialog only.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      // Back to whatever opened the dialog, if it is still on the page.
      if (opener && opener !== document.body && document.contains(opener)) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trap, keepFocus]);
}
