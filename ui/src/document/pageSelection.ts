/**
 * Selection and reordering logic of the Pages side panel (pure, unit tested).
 * Indices are positions in the current page list.
 */
export interface PageSel {
  /** Selected positions. */
  selected: Set<number>;
  /** Shift-click / Shift+arrow range anchor. */
  anchor: number;
  /** Page shown in the viewer (keyboard focus). */
  cur: number;
}

export const emptySel = (cur = 0): PageSel => ({ selected: new Set(), anchor: cur, cur });

const range = (a: number, b: number) => {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
};

/** Click on thumbnail `i`: plain = only this page, Ctrl/Cmd = toggle, Shift = range from the anchor. */
export function clickSelect(sel: PageSel, i: number, mods: { shift?: boolean; toggle?: boolean } = {}): PageSel {
  if (mods.shift) {
    const base = mods.toggle ? new Set(sel.selected) : new Set<number>();
    range(sel.anchor, i).forEach((k) => base.add(k));
    return { selected: base, anchor: sel.anchor, cur: i };
  }
  if (mods.toggle) {
    const s = new Set(sel.selected);
    if (s.has(i)) s.delete(i);
    else s.add(i);
    return { selected: s, anchor: i, cur: i };
  }
  return { selected: new Set([i]), anchor: i, cur: i };
}

/** Keyboard navigation in the thumbnail list. Returns null when the key is not a navigation key. */
export function keyNav(sel: PageSel, key: string, count: number, shift = false): PageSel | null {
  if (count === 0) return null;
  let next: number;
  switch (key) {
    case "ArrowUp":
    case "ArrowLeft":
      next = sel.cur - 1;
      break;
    case "ArrowDown":
    case "ArrowRight":
      next = sel.cur + 1;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = count - 1;
      break;
    default:
      return null;
  }
  next = Math.max(0, Math.min(count - 1, next));
  if (shift) return { selected: new Set(range(sel.anchor, next)), anchor: sel.anchor, cur: next };
  return { selected: new Set([next]), anchor: next, cur: next };
}

export const selectAll = (count: number, cur = 0): PageSel => ({ selected: new Set(range(0, count - 1).filter((k) => k >= 0)), anchor: 0, cur });

/** Pages an action applies to: the selection, or the current page when nothing is selected. */
export function targets(sel: PageSel, count: number): number[] {
  const list = [...sel.selected].filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
  return list.length ? list : count ? [Math.min(sel.cur, count - 1)] : [];
}

/** Remove positions; returns the remaining items and a selection on the page after the removed block. */
export function removeAt<T>(items: T[], idx: number[]): { items: T[]; sel: PageSel } {
  const drop = new Set(idx);
  const out = items.filter((_, k) => !drop.has(k));
  const first = Math.min(...idx);
  const cur = Math.max(0, Math.min(first, out.length - 1));
  return { items: out, sel: emptySel(cur) };
}

/** Duplicate positions: every copy is placed right after the last selected page, copies end up selected. */
export function duplicateAt<T>(items: T[], idx: number[], clone: (t: T) => T = (t) => t): { items: T[]; sel: PageSel } {
  const sorted = [...idx].sort((a, b) => a - b);
  const last = sorted[sorted.length - 1];
  const copies = sorted.map((i) => clone(items[i]));
  const out = [...items.slice(0, last + 1), ...copies, ...items.slice(last + 1)];
  const selected = new Set(copies.map((_, k) => last + 1 + k));
  return { items: out, sel: { selected, anchor: last + 1, cur: last + 1 } };
}

/**
 * Move the pages at `idx` (kept in their relative order) so that they are
 * inserted before position `before` of the ORIGINAL list (0…length).
 * Returns the new list and the moved block's new positions (selected).
 */
export function moveTo<T>(items: T[], idx: number[], before: number): { items: T[]; sel: PageSel } {
  const moving = new Set(idx);
  const block = [...idx].sort((a, b) => a - b).map((i) => items[i]);
  const rest = items.filter((_, k) => !moving.has(k));
  const at = Math.max(0, Math.min(rest.length, before - [...moving].filter((k) => k < before).length));
  const out = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  const selected = new Set(block.map((_, k) => at + k));
  return { items: out, sel: { selected, anchor: at, cur: at } };
}

/** Move a block one step up (-1) or down (+1); null when it is already at the edge. */
export function moveBy<T>(items: T[], idx: number[], by: -1 | 1): { items: T[]; sel: PageSel } | null {
  const sorted = [...idx].sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (by < 0 && sorted[0] === 0) return null;
  if (by > 0 && sorted[sorted.length - 1] === items.length - 1) return null;
  const before = by < 0 ? sorted[0] - 1 : sorted[sorted.length - 1] + 2;
  return moveTo(items, sorted, before);
}

/** Insert `block` before position `at`; the inserted pages end up selected. */
export function insertAt<T>(items: T[], block: T[], at: number): { items: T[]; sel: PageSel } {
  const p = Math.max(0, Math.min(items.length, at));
  const out = [...items.slice(0, p), ...block, ...items.slice(p)];
  return { items: out, sel: { selected: new Set(block.map((_, k) => p + k)), anchor: p, cur: p } };
}
