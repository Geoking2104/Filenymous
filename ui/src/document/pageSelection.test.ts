import { describe, expect, it } from "vitest";
import { clickSelect, duplicateAt, emptySel, insertAt, keyNav, moveBy, moveTo, removeAt, selectAll, targets } from "./pageSelection";

const arr = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe("page selection", () => {
  it("click selects one page, Ctrl toggles, Shift selects a range from the anchor", () => {
    let s = clickSelect(emptySel(), 2);
    expect(arr(s.selected)).toEqual([2]);
    s = clickSelect(s, 5, { toggle: true });
    expect(arr(s.selected)).toEqual([2, 5]);
    s = clickSelect(s, 2, { toggle: true });
    expect(arr(s.selected)).toEqual([5]);
    s = clickSelect(s, 1, { shift: true });
    expect(arr(s.selected)).toEqual([1, 2]); // anchor = last plain or Ctrl click (page 2)
    expect(s.cur).toBe(1);
    s = clickSelect(clickSelect(emptySel(), 0), 7, { shift: true, toggle: true });
    expect(arr(s.selected)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("keyboard: arrows move, Shift extends, bounds are clamped", () => {
    let s = clickSelect(emptySel(), 1);
    s = keyNav(s, "ArrowDown", 4)!;
    expect(s.cur).toBe(2);
    expect(arr(s.selected)).toEqual([2]);
    s = keyNav(s, "ArrowDown", 4, true)!;
    s = keyNav(s, "ArrowDown", 4, true)!;
    expect(arr(s.selected)).toEqual([2, 3]);
    expect(keyNav(s, "Home", 4)!.cur).toBe(0);
    expect(keyNav(s, "End", 4)!.cur).toBe(3);
    expect(keyNav(s, "x", 4)).toBeNull();
    expect(arr(selectAll(3).selected)).toEqual([0, 1, 2]);
  });

  it("targets fall back to the current page", () => {
    expect(targets(emptySel(2), 4)).toEqual([2]);
    expect(targets({ selected: new Set([3, 1]), anchor: 1, cur: 1 }, 4)).toEqual([1, 3]);
    expect(targets(emptySel(9), 4)).toEqual([3]);
  });

  it("drag-and-drop moves a non-contiguous block before a position", () => {
    const pages = ["a", "b", "c", "d", "e"];
    expect(moveTo(pages, [0, 2], 4)).toMatchObject({ items: ["b", "d", "a", "c", "e"] });
    expect(arr(moveTo(pages, [0, 2], 4).sel.selected)).toEqual([2, 3]);
    expect(moveTo(pages, [3, 4], 0).items).toEqual(["d", "e", "a", "b", "c"]);
    expect(moveTo(pages, [1], 5).items).toEqual(["a", "c", "d", "e", "b"]);
    expect(moveTo(pages, [1], 1).items).toEqual(pages);
  });

  it("move up / down, delete, duplicate and paste", () => {
    const pages = ["a", "b", "c", "d"];
    expect(moveBy(pages, [1, 2], -1)!.items).toEqual(["b", "c", "a", "d"]);
    expect(moveBy(pages, [1, 2], 1)!.items).toEqual(["a", "d", "b", "c"]);
    expect(moveBy(pages, [0], -1)).toBeNull();
    expect(moveBy(pages, [3], 1)).toBeNull();
    const r = removeAt(pages, [1, 2]);
    expect(r.items).toEqual(["a", "d"]);
    expect(r.sel.cur).toBe(1);
    const d = duplicateAt(pages, [0, 2]);
    expect(d.items).toEqual(["a", "b", "c", "a", "c", "d"]);
    expect(arr(d.sel.selected)).toEqual([3, 4]);
    const p = insertAt(pages, ["x", "y"], 1);
    expect(p.items).toEqual(["a", "x", "y", "b", "c", "d"]);
    expect(arr(p.sel.selected)).toEqual([1, 2]);
  });
});
