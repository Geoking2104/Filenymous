import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import "../i18n";
import { AgentsGuide } from "./AgentsGuide";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const LINK = "https://filenymous.eu/app/#wall:wall-000000000000000000000000/TESTKEYxxxxxxxxxxxxxxx/0/nh";
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });

describe("AgentsGuide", () => {
  it("masks the invite link by default, reveals on demand, copies the real link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<AgentsGuide open onClose={() => {}} inviteLink={LINK} agentsAllowed />));
    const next = [...host.querySelectorAll(".sw-guide-nav button")].pop()!;
    await click(next);
    expect(q("wall-agents-guide-cli").textContent).not.toContain("TESTKEY");
    expect(q("wall-agents-guide-mcp").textContent).not.toContain("TESTKEY");
    await click(q("wall-agents-guide-copy-link"));
    expect(writeText).toHaveBeenLastCalledWith(LINK);
    const copyCli = q("wall-agents-guide-cli").nextElementSibling!;
    await click(copyCli);
    expect(writeText.mock.calls.at(-1)![0]).toContain("TESTKEY");
    await click(q("wall-agents-guide-reveal"));
    expect(q("wall-agents-guide-cli").textContent).toContain("TESTKEY");
    await act(async () => root.unmount());
  });
});
