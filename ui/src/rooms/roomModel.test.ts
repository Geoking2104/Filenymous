import { describe, expect, it } from "vitest";
import {
  canTransitionTransferStatus,
  createInviteCode,
  isPresenceActive,
  normalizeInviteCode,
  roomAvatarInitials,
  sanitizeRoomText,
} from "./roomModel";

describe("room model", () => {
  it("creates human-readable invite codes with enough entropy for V1 rooms", () => {
    const code = createInviteCode(new Uint8Array([0, 1, 2, 3, 4, 5]));
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("uses one random byte per invite code symbol by default", () => {
    const originalGetRandomValues = crypto.getRandomValues;
    let requestedBytes = 0;
    crypto.getRandomValues = ((array: Uint8Array) => {
      requestedBytes = array.length;
      return originalGetRandomValues.call(crypto, array);
    }) as Crypto["getRandomValues"];

    try {
      createInviteCode();
    } finally {
      crypto.getRandomValues = originalGetRandomValues;
    }

    expect(requestedBytes).toBe(12);
  });

  it("normalizes invite codes using only the generator alphabet", () => {
    expect(normalizeInviteCode("IO10-ABCD-EFGH-JKLM")).toBe("ABCD-EFGH-JKLM");
    expect(normalizeInviteCode("abcd efgh jklm")).toBe("ABCD-EFGH-JKLM");
  });

  it("treats presence as active only before expiry", () => {
    expect(isPresenceActive({ expiresAtMs: 2_000 }, 1_999)).toBe(true);
    expect(isPresenceActive({ expiresAtMs: 2_000 }, 2_000)).toBe(false);
  });

  it("escapes visible room text and trims long messages", () => {
    expect(sanitizeRoomText("<img src=x onerror=alert(1)>", 80)).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(sanitizeRoomText("abcdef", 3)).toBe("abc");
  });

  it("allows only valid transfer request transitions", () => {
    expect(canTransitionTransferStatus("pending", "accepted", "receiver")).toBe(true);
    expect(canTransitionTransferStatus("pending", "refused", "receiver")).toBe(true);
    expect(canTransitionTransferStatus("pending", "revoked", "sender")).toBe(true);
    expect(canTransitionTransferStatus("done", "accepted", "receiver")).toBe(false);
    expect(canTransitionTransferStatus("pending", "done", "sender")).toBe(false);
  });

  it("derives stable avatar initials from a display name or peer id", () => {
    expect(roomAvatarInitials("Alice Martin", "peer-1")).toBe("AM");
    expect(roomAvatarInitials("", "peer-1")).toBe("PE");
  });
});
