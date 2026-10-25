import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A receiver that never finds a sender, unless the test pushes a new status.
const push: { fn?: (s: unknown) => void } = {};
vi.mock("./session", () => ({
  P2PReceiver: class {
    constructor(_code: string, _secret: string, onState: (s: unknown) => void) {
      push.fn = onState;
      onState({ status: "waiting-sender", files: [], receivedBytes: 0, totalBytes: 0, speed: 0 });
    }
    start() {
      return Promise.resolve();
    }
    close() {}
  },
}));
vi.mock("./config", () => ({ p2pSupported: () => true }));

const { default: P2PReceivePanel, isWaitingForSender, goEnterAnotherCode, NO_SENDER_HINT_MS } = await import("./P2PReceivePanel");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const HASH = "#p2p:123-456-ABC/abcdefghijklmnopqrstuv";

describe("receiver without a sender", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await i18n.changeLanguage("en");
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    vi.useRealTimers();
  });

  it("knows which statuses mean nobody is sending yet", () => {
    expect(isWaitingForSender("connecting")).toBe(true);
    expect(isWaitingForSender("waiting-sender")).toBe(true);
    expect(isWaitingForSender("receiving" as never)).toBe(false);
    expect(NO_SENDER_HINT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("explains and offers a way out after the delay, and hides it once the sender shows up", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<P2PReceivePanel hash={HASH} noSenderHintMs={1000} />));
    expect(q("p2p-no-sender")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1001);
    });
    expect(q("p2p-no-sender")?.getAttribute("role")).toBe("alert");
    expect(q("p2p-no-sender-retry")).not.toBeNull();
    expect(q("p2p-other-code")).not.toBeNull();
    await act(async () => {
      push.fn?.({ status: "ready", files: [], receivedBytes: 0, totalBytes: 0, speed: 0 });
    });
    expect(q("p2p-no-sender")).toBeNull();
  });

  it("“enter another code” clears the link and focuses the code field", async () => {
    history.replaceState(null, "", "/app/" + HASH);
    const input = document.createElement("input");
    input.id = "pz-home-code";
    input.scrollIntoView = () => undefined;
    document.body.appendChild(input);
    const seen = vi.fn();
    window.addEventListener("hashchange", seen);
    goEnterAnotherCode();
    vi.advanceTimersByTime(10);
    expect(location.hash).toBe("");
    expect(seen).toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    window.removeEventListener("hashchange", seen);
    input.remove();
  });
});
