import { describe, expect, it } from "vitest";
import { clearRoomHistory, decryptRoomHistory, encryptRoomHistory, loadRoomHistory, saveRoomHistory } from "./historyVault";
import type { EncryptedRoomHistoryRecord } from "./historyVault";
import type { RoomHistorySnapshot } from "./types";

const snapshot: RoomHistorySnapshot = {
  rooms: [{ roomId: "room-a", inviteCode: "ABCD-EFGH-JKLM", lastOpenedMs: 1 }],
  peers: [],
  messages: [],
  transfers: [],
};

describe("room history vault", () => {
  it("encrypts and decrypts a room history snapshot with the same password", async () => {
    const record = await encryptRoomHistory(snapshot, "vault-password");

    expect(JSON.stringify(record)).not.toContain("room-a");
    await expect(decryptRoomHistory(record, "wrong")).rejects.toThrow("Unable to unlock room history");
    await expect(decryptRoomHistory(record, "vault-password")).resolves.toEqual(snapshot);
  });

  it("uses fresh salt and nonce for each encrypted history record", async () => {
    const first = await encryptRoomHistory(snapshot, "vault-password");
    const second = await encryptRoomHistory(snapshot, "vault-password");

    expect(first.saltB64).not.toBe(second.saltB64);
    expect(first.nonceB64).not.toBe(second.nonceB64);
    expect(first.ciphertextB64).not.toBe(second.ciphertextB64);
  });

  it("persists and clears encrypted room history", async () => {
    await clearRoomHistory();
    const record = await encryptRoomHistory(snapshot, "vault-password");

    await saveRoomHistory(record);
    expect((await loadRoomHistory())?.ciphertextB64).toBe(record.ciphertextB64);

    await clearRoomHistory();
    await expect(loadRoomHistory()).resolves.toBeNull();
  });

  it("rejects malformed records with the same unlock error", async () => {
    const malformed = {
      version: 1,
      kdf: "PBKDF2-SHA256",
      iterations: 1,
      saltB64: "",
      nonceB64: "",
      ciphertextB64: "",
      updatedAt: new Date().toISOString(),
    } as EncryptedRoomHistoryRecord;

    await expect(decryptRoomHistory(malformed, "vault-password")).rejects.toThrow("Unable to unlock room history");
  });
});
