import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import RoomPanel from "./RoomPanel";
import { useStore } from "../store/useStore";

let root: Root | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  document.body.innerHTML = "";
  useStore.setState({
    tab: "rooms",
    roomId: "",
    inviteCode: "",
    peers: [],
    roomTransfers: [],
    roomHistory: null,
  });
});

describe("RoomPanel", () => {
  it("renders a public room workflow with invite link and participants", async () => {
    useStore.setState({
      roomId: "room-alpha",
      inviteCode: "ABCD-EFGH-JKLM",
      peers: [
        {
          peerId: "peer-b",
          displayName: "Bob",
          avatarSeed: "b",
          status: "online",
          lastSeenMs: 1,
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const mountedRoot = createRoot(host);
    root = mountedRoot;

    await act(async () => {
      mountedRoot.render(<RoomPanel />);
    });

    expect(document.body.textContent).toContain("room-alpha");
    const inviteTab = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Invitation"),
    );
    expect(inviteTab).toBeTruthy();
    await act(async () => inviteTab?.click());
    expect((document.querySelector("[aria-label='Lien d’invitation']") as HTMLInputElement).value).toContain(
      "/#/room/room-alpha?key=ABCD-EFGH-JKLM",
    );
    const peopleTab = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Participants"),
    );
    expect(peopleTab).toBeTruthy();
    await act(async () => peopleTab?.click());
    expect(document.body.textContent).toContain("Bob");
    expect(document.body.textContent).toContain("Bibliothèque");
  });
});
