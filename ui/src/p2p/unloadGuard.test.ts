import { afterEach, describe, expect, it, vi } from "vitest";
import { holdUnloadGuard, releaseUnloadGuard, unloadGuardActive } from "./unloadGuard";

function fireBeforeUnload(): boolean {
  const ev = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

describe("unload guard", () => {
  afterEach(() => {
    releaseUnloadGuard("a");
    releaseUnloadGuard("b");
  });

  it("blocks tab close while at least one reason is held", () => {
    expect(fireBeforeUnload()).toBe(false);
    holdUnloadGuard("a");
    holdUnloadGuard("b");
    expect(unloadGuardActive()).toBe(true);
    expect(fireBeforeUnload()).toBe(true);
    releaseUnloadGuard("a");
    expect(fireBeforeUnload()).toBe(true);
    releaseUnloadGuard("b");
    expect(unloadGuardActive()).toBe(false);
    expect(fireBeforeUnload()).toBe(false);
  });

  it("installs a single listener and removes it when released", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    holdUnloadGuard("a");
    holdUnloadGuard("a");
    holdUnloadGuard("b");
    expect(add.mock.calls.filter((c) => c[0] === "beforeunload")).toHaveLength(1);
    releaseUnloadGuard("a");
    releaseUnloadGuard("b");
    releaseUnloadGuard("b");
    expect(remove.mock.calls.filter((c) => c[0] === "beforeunload")).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });
});
