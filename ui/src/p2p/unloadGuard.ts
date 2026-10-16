import { useEffect } from "react";

/**
 * Anti tab-close guard. Several independent reasons (e.g. several contributors
 * uploading at once) can hold the guard; the `beforeunload` prompt is shown as
 * long as at least one is active. Browsers ignore custom text, so the UI must
 * also display a visible warning.
 */
const reasons = new Set<string>();

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (reasons.size === 0) return;
  e.preventDefault();
  e.returnValue = "";
}

export function holdUnloadGuard(reason: string): void {
  if (reasons.size === 0) window.addEventListener("beforeunload", onBeforeUnload);
  reasons.add(reason);
}

export function releaseUnloadGuard(reason: string): void {
  if (!reasons.delete(reason)) return;
  if (reasons.size === 0) window.removeEventListener("beforeunload", onBeforeUnload);
}

export function unloadGuardActive(): boolean {
  return reasons.size > 0;
}

let seq = 0;

/** React hook: holds the guard while `active` is true. */
export function useUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const reason = `hook-${++seq}`;
    holdUnloadGuard(reason);
    return () => releaseUnloadGuard(reason);
  }, [active]);
}
