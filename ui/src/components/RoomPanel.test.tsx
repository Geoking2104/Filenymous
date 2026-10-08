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
  it("renders a running room with invite link and participants", async () => {
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

    // Room identity renders (language-independent check).
    expect(document.body.textContent).toContain("room-alpha");

    // Open the invitation tab and verify the invite link input.
    const invitationTab = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Invitation"),
    );
    expect(invitationTab, "invitation tab should exist").toBeTruthy();
    await act(async () => {
      invitationTab!.click();
    });

    const inviteInput = Array.from(document.querySelectorAll("input")).find((i) =>
      i.value.includes("room-alpha"),
    );
    expect(inviteInput, "invite link input should be rendered").toBeTruthy();
    expect(inviteInput!.value).toContain("/#/room/room-alpha?key=ABCD-EFGH-JKLM");
  });
});
