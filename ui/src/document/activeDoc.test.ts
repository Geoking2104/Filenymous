import { afterEach, describe, expect, it, vi } from "vitest";
import { META_KEY, TITLE_MARK, activeDocState, isUnexported, markTitle, setPdfUnsaved, subscribeActiveDoc, writeMeta } from "./activeDoc";

afterEach(() => {
  localStorage.clear();
  setPdfUnsaved(null);
});

describe("badge rule: only when changed since the last export", () => {
  it("isUnexported", () => {
    expect(isUnexported(null)).toBe(false);
    expect(isUnexported({ name: "a", updatedAt: 10 })).toBe(true);
    expect(isUnexported({ name: "a", updatedAt: 10, exportedAt: 10 })).toBe(false);
    expect(isUnexported({ name: "a", updatedAt: 10, exportedAt: 20 })).toBe(false);
    expect(isUnexported({ name: "a", updatedAt: 30, exportedAt: 20 })).toBe(true);
  });

  it("an exported document is still stored but shows no badge (no grey state)", () => {
    writeMeta({ name: "a", updatedAt: 1, exportedAt: 2 });
    const s = activeDocState();
    expect(s.stored?.name).toBe("a");
    expect(s.unexported).toBe(false);
    expect(s.name).toBeNull();
  });

  it("an unsaved PDF counts during the session", () => {
    setPdfUnsaved("plan.pdf");
    expect(activeDocState()).toMatchObject({ unexported: true, name: "plan.pdf" });
    setPdfUnsaved(null);
    expect(activeDocState().unexported).toBe(false);
  });
});

describe("sync", () => {
  it("notifies this tab on write and other tabs through the storage event", () => {
    const fn = vi.fn();
    const off = subscribeActiveDoc(fn);
    writeMeta({ name: "a", updatedAt: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent("storage", { key: META_KEY }));
    expect(fn).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    writeMeta(null);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("tab title", () => {
  it("adds and removes the mark idempotently", () => {
    expect(markTitle("Filenymous", true)).toBe(`${TITLE_MARK}Filenymous`);
    expect(markTitle(`${TITLE_MARK}Filenymous`, true)).toBe(`${TITLE_MARK}Filenymous`);
    expect(markTitle(`${TITLE_MARK}Filenymous`, false)).toBe("Filenymous");
  });
});
