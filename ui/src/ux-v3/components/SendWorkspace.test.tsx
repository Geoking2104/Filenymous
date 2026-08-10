import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const mocks = vi.hoisted(() => ({
  sendTransfer: vi.fn(),
  addParcel: vi.fn(),
}));

vi.mock("../../transfer/sendTransfer", () => ({
  isValidContact: (value: string) => value === "alice@example.com",
  sendTransfer: mocks.sendTransfer,
}));

vi.mock("../../holochain/client", () => ({
  canWrite: () => true,
  initClient: async () => "websocket",
}));

vi.mock("../../store/useStore", () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      addressBook: [],
      selectedRecipient: "",
      setSelectedRecipient: vi.fn(),
      addParcel: mocks.addParcel,
      net: { mode: "websocket" },
    }),
}));

vi.mock("qrcode.react", async () => {
  const ReactModule = await import("react");
  return {
    QRCodeSVG: ({ value }: { value: string }) => (
      <svg data-testid="share-qr" data-value={value} />
    ),
    QRCodeCanvas: ReactModule.forwardRef<HTMLCanvasElement, { value: string }>(
      ({ value }, ref) => <canvas ref={ref} data-testid="share-qr-png" data-value={value} />,
    ),
  };
});

import SendWorkspace from "./SendWorkspace";

let root: Root | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("SendWorkspace", () => {
  it("encodes the complete download address in both QR renderers", async () => {
    const downloadUrl = "https://filenymous.eu/#parcel-123:aes-456";
    mocks.sendTransfer.mockResolvedValue({
      code: "AB·CD·EF",
      link: downloadUrl,
      parcelEhB64: "parcel-123",
      fileName: "secret.txt",
      totalSize: 6,
      mode: "agent",
      maxDownloads: 1,
    });

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<SendWorkspace />);
      await Promise.resolve();
    });

    const fileInput = document.querySelector("input[type='file']") as HTMLInputElement;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["secret"], "secret.txt", { type: "text/plain" })],
    });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));

    const recipientInput = document.querySelector("input[type='text']") as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(recipientInput, "alice@example.com");
    await act(async () => recipientInput.dispatchEvent(new Event("input", { bubbles: true })));

    const submit = document.querySelector("button.v3-btn-primary") as HTMLButtonElement;
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });

    expect(mocks.sendTransfer).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-testid='share-qr']")?.getAttribute("data-value")).toBe(downloadUrl);
    expect(document.querySelector("[data-testid='share-qr-png']")?.getAttribute("data-value")).toBe(downloadUrl);
    expect((document.querySelector(".v3-link-row input") as HTMLInputElement).value).toBe(downloadUrl);
  });
});
