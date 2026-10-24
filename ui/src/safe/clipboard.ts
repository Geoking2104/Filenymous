/**
 * Copy with auto-clear: the clipboard is overwritten 30 s after a copy
 * (best effort — the OS, clipboard managers or other apps may keep a copy).
 */
import { useSyncExternalStore } from "react";

export const CLEAR_AFTER_MS = 30_000;

type State = { label: string; until: number; total: number } | null;
let state: State = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let retryOnFocus = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

async function wipe() {
  timer = undefined;
  try {
    await navigator.clipboard.writeText("");
    retryOnFocus = false;
  } catch {
    // Writing needs a focused document: retry when the tab is focused again.
    retryOnFocus = true;
  }
  state = null;
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    if (retryOnFocus) void wipe();
  });
}

export async function copySecret(value: string, label: string, ms = CLEAR_AFTER_MS): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    return false;
  }
  clearTimeout(timer);
  state = { label, until: Date.now() + ms, total: ms };
  timer = setTimeout(() => void wipe(), ms);
  emit();
  return true;
}

export function clearNow(): void {
  clearTimeout(timer);
  if (state) void wipe();
}

export function useClipboardState(): State {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}
