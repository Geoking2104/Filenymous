import { describe, expect, it } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { deriveWalletAddresses } from "./addresses";

describe("deriveWalletAddresses", () => {
  it("derives stable ETH and BTC receive addresses from a seed", async () => {
    const seed = mnemonicToSeedSync(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );

    const addresses = await deriveWalletAddresses(seed);

    expect(addresses.ethSepolia).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(addresses.ethMainnet).toBe(addresses.ethSepolia);
    expect(addresses.btcSignet).toMatch(/^(tb1|bcrt1|[mn2])[a-zA-Z0-9]+$/);
    expect(addresses.btcMainnet).toMatch(/^(bc1|[13])[a-zA-Z0-9]+$/);
  });
});
