import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { focusableIn, useModal } from "./useModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;

function Dialog({ name, onClose, canClose, trap }: { name: string; onClose: () => void; canClose?: boolean; trap?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose, { canClose, trap });
  return (
    <div ref={ref} role="dialog" data-testid={name}>
      <button data-testid={`${name}-a`}>a</button>
      <button data-testid={`${name}-b`} disabled>disabled</button>
      <button data-testid={`${name}-c`}>c</button>
    </div>
  );
}

function Harness({ onClose, second, canClose }: { onClose?: () => void; second?: boolean; canClose?: boolean }) {
  const [open, setOpen] = useState(false);
  const close = () => {
    onClose?.();
    setOpen(false);
  };
  return (
    <>
      <button data-testid="opener" onClick={() => setOpen(true)}>open</button>
      {open && <Dialog name="d1" onClose={close} canClose={canClose} />}
      {open && second && <Dialog name="d2" onClose={() => undefined} />}
    </>
  );
}

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

function key(k: string, shift = false) {
  const e = new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

describe("useModal", () => {
  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
  });

  it("focuses the first control on open, closes on Escape and gives focus back to the opener", async () => {
    const onClose = vi.fn();
    await mount(<Harness onClose={onClose} />);
    q("opener").focus();
    await act(async () => q("opener").click());
    expect(document.activeElement).toBe(q("d1-a"));
    let e!: KeyboardEvent;
    await act(async () => {
      e = key("Escape");
    });
    expect(e.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="d1"]')).toBeNull();
    expect(document.activeElement).toBe(q("opener"));
  });

  it("keeps Tab inside the dialog and skips disabled controls", async () => {
    await mount(<Harness />);
    await act(async () => q("opener").click());
    q("d1-c").focus();
    const e = key("Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q("d1-a"));
    const e2 = key("Tab", true);
    expect(e2.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q("d1-c"));
    expect(focusableIn(q("d1")).map((el) => el.dataset.testid)).toEqual(["d1-a", "d1-c"]);
  });

  it("ignores Escape while it cannot close", async () => {
    const onClose = vi.fn();
    await mount(<Harness onClose={onClose} canClose={false} />);
    await act(async () => q("opener").click());
    await act(async () => {
      key("Escape");
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("only the top-most dialog reacts when two are open", async () => {
    const onClose = vi.fn();
    await mount(<Harness onClose={onClose} second />);
    await act(async () => q("opener").click());
    expect(document.activeElement).toBe(q("d2-a"));
    await act(async () => {
      key("Escape");
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
