/** Unsaved text document kept in this browser only (localStorage), restored after a reload. */
const KEY = "fny.document.draft.v1";

export interface Draft {
  name: string;
  html: string;
  at: number;
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return typeof d?.html === "string" && typeof d?.name === "string" ? d : null;
  } catch {
    return null;
  }
}

/** False when the draft did not fit (quota, private mode). */
export function saveDraft(d: Omit<Draft, "at">): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...d, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
