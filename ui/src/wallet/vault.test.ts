import { describe, expect, it } from "vitest";
import { decryptSeed, deleteVault, encryptSeed, loadVault, saveVault } from "./vault";

describe("wallet vault encryption", () => {
  it("decrypts a seed with the same password", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const record = await encryptSeed(seed, "correct horse battery staple");

    const decrypted = await decryptSeed(record, "correct horse battery staple");

    expect(Array.from(decrypted)).toEqual(Array.from(seed));
  });

  it("rejects the wrong password", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const record = await encryptSeed(seed, "correct horse battery staple");

    await expect(decryptSeed(record, "wrong password")).rejects.toThrow("Unable to unlock wallet");
  });

  it("stores and loads the encrypted vault record", async () => {
    await deleteVault();
    const record = await encryptSeed(new Uint8Array([1, 2, 3]), "pw");

    await saveVault(record);
    const loaded = await loadVault();

    expect(loaded?.ciphertextB64).toBe(record.ciphertextB64);
  });
});
