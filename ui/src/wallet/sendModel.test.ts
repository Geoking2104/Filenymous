import { describe, expect, it } from "vitest";
import { buildSendConfirmation } from "./sendModel";

describe("buildSendConfirmation", () => {
  it("blocks mainnet sends unless mainnet is enabled", () => {
    expect(() =>
      buildSendConfirmation({
        chain: "eth",
        network: "eth-mainnet",
        mainnetEnabled: false,
        recipient: "0x0000000000000000000000000000000000000001",
        amount: "0.01",
        fee: "0.001",
      }),
    ).toThrow("Mainnet is locked");
  });

  it("builds a Sepolia confirmation without mainnet unlock", () => {
    const confirmation = buildSendConfirmation({
      chain: "eth",
      network: "eth-sepolia",
      mainnetEnabled: false,
      recipient: "0x0000000000000000000000000000000000000001",
      amount: "0.01",
      fee: "0.001",
    });

    expect(confirmation.total).toBe("0.011");
    expect(confirmation.irreversibleWarning).toContain("irreversible");
  });
});
