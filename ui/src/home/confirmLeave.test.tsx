import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../i18n";
import { ConfirmDialogHost, confirmLeave, useLeaveGuard } from "./confirmLeave";
import { unloadGuardActive } from "../p2p/unloadGuardCore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Guarded({ onLeave }: { onLeave: () => void }) {
  const [active] = useState(true);
  useLeaveGuard(active, { onLeave, detail: "leave.wallHost" });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

async function ask(): Promise<{ p: Promise<boolean> }> {
  let p!: Promise<boolean>;
  await act(async () => {
    p = confirmLeave();
  });
  return { p }; // wrapped: an async function would otherwise wait for the answer
}

describe("shared leave confirmation", () => {
  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
  });

  it("does not ask when nothing would be lost", async () => {
    await mount(<ConfirmDialogHost />);
    await expect(confirmLeave()).resolves.toBe(true);
    expect(q("leave-dialog")).toBeNull();
  });

  it("asks while a guard is held: Cancel keeps it, Quitter runs onLeave and releases everything", async () => {
    await i18n.changeLanguage("fr");
    const onLeave = vi.fn();
    await mount(
      <>
        <Guarded onLeave={onLeave} />
        <ConfirmDialogHost />
      </>,
    );
    expect(unloadGuardActive()).toBe(true);
    let { p } = await ask();
    expect(q("leave-message")?.textContent).toBe(
      "Vous êtes sur le point de fermer la fenêtre. Cela fera disparaître les informations de celle-ci. Confirmez-vous ?",
    );
    expect(q("leave-detail")?.textContent).toBe("Le mur sera détruit pour tous les participants.");
    expect(q("leave-cancel")?.textContent).toBe("Annuler");
    expect(q("leave-confirm")?.textContent).toBe("Quitter");
    await act(async () => q("leave-cancel")!.click());
    await expect(p).resolves.toBe(false);
    expect(q("leave-dialog")).toBeNull();
    expect(onLeave).not.toHaveBeenCalled();
    expect(unloadGuardActive()).toBe(true);

    ({ p } = await ask());
    await act(async () => q("leave-confirm")!.click());
    await expect(p).resolves.toBe(true);
    expect(onLeave).toHaveBeenCalledOnce();
    expect(unloadGuardActive()).toBe(false);
    // Nothing left: the next close does not ask.
    await expect(confirmLeave()).resolves.toBe(true);
  });

  it("Escape cancels", async () => {
    await mount(
      <>
        <Guarded onLeave={() => undefined} />
        <ConfirmDialogHost />
      </>,
    );
    const { p } = await ask();
    expect(q("leave-dialog")).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await expect(p).resolves.toBe(false);
  });
});
