import { requiresMainnetUnlock } from "./networks";
import type { Chain, WalletNetworkId } from "./types";

export interface SendDraft {
  chain: Chain;
  network: WalletNetworkId;
  mainnetEnabled: boolean;
  recipient: string;
  amount: string;
  fee: string;
}

export interface SendConfirmation {
  chain: Chain;
  network: WalletNetworkId;
  recipient: string;
  amount: string;
  fee: string;
  total: string;
  irreversibleWarning: string;
}

function parsePositiveDecimal(value: string, label: string): void {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) throw new Error(`${label} must be positive`);
  if (Number(value) <= 0) throw new Error(`${label} must be positive`);
}

function addDecimals(a: string, b: string): string {
  const [aInt, aFrac = ""] = a.split(".");
  const [bInt, bFrac = ""] = b.split(".");
  const width = Math.max(aFrac.length, bFrac.length);
  const aUnits = BigInt(aInt + aFrac.padEnd(width, "0"));
  const bUnits = BigInt(bInt + bFrac.padEnd(width, "0"));
  const total = String(aUnits + bUnits).padStart(width + 1, "0");
  if (width === 0) return total;
  const whole = total.slice(0, -width);
  const frac = total.slice(-width).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function buildSendConfirmation(draft: SendDraft): SendConfirmation {
  if (requiresMainnetUnlock(draft.network) && !draft.mainnetEnabled) {
    throw new Error("Mainnet is locked");
  }
  if (!draft.recipient.trim()) throw new Error("Recipient is required");
  const amount = draft.amount.trim();
  const fee = draft.fee.trim();
  parsePositiveDecimal(amount, "Amount");
  parsePositiveDecimal(fee, "Fee");
  return {
    chain: draft.chain,
    network: draft.network,
    recipient: draft.recipient.trim(),
    amount,
    fee,
    total: addDecimals(amount, fee),
    irreversibleWarning: "Crypto transactions are irreversible after broadcast.",
  };
}
