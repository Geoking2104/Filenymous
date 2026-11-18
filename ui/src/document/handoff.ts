/**
 * In-memory hand-off of one file between the Document tab and the
 * Coffre-fort. Both live in the same page, so a module-level slot is enough:
 * nothing is written to storage, and the slot is emptied when read.
 */
export type HandoffTarget = "safe" | "document";

const slots = new Map<HandoffTarget, File>();

export function handOff(target: HandoffTarget, file: File): void {
  slots.set(target, file);
}

/** Returns the pending file for `target` once, then forgets it. */
export function takeHandoff(target: HandoffTarget): File | null {
  const f = slots.get(target) ?? null;
  slots.delete(target);
  return f;
}

export function peekHandoff(target: HandoffTarget): File | null {
  return slots.get(target) ?? null;
}

export function isPdfFile(f: { name: string; type?: string }): boolean {
  return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
}
