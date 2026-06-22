import { describe, expect, it } from "vitest";
import { getNetwork, requiresMainnetUnlock } from "./networks";

describe("wallet networks", () => {
  it("defaults BTC and ETH to test networks", () => {
    expect(getNetwork("btc", false).id).toBe("btc-signet");
    expect(getNetwork("eth", false).id).toBe("eth-sepolia");
  });

  it("requires explicit unlock for mainnet networks", () => {
    expect(requiresMainnetUnlock("btc-mainnet")).toBe(true);
    expect(requiresMainnetUnlock("eth-mainnet")).toBe(true);
    expect(requiresMainnetUnlock("btc-signet")).toBe(false);
    expect(requiresMainnetUnlock("eth-sepolia")).toBe(false);
  });
});
