import type { Chain, WalletNetwork, WalletNetworkId } from "./types";

export const WALLET_NETWORKS: Record<WalletNetworkId, WalletNetwork> = {
  "btc-signet": { id: "btc-signet", chain: "btc", label: "Bitcoin Signet", mainnet: false },
  "btc-testnet": { id: "btc-testnet", chain: "btc", label: "Bitcoin Testnet", mainnet: false },
  "btc-mainnet": { id: "btc-mainnet", chain: "btc", label: "Bitcoin Mainnet", mainnet: true },
  "eth-sepolia": { id: "eth-sepolia", chain: "eth", label: "Ethereum Sepolia", mainnet: false },
  "eth-mainnet": { id: "eth-mainnet", chain: "eth", label: "Ethereum Mainnet", mainnet: true },
};

export function getNetwork(chain: Chain, mainnetEnabled: boolean): WalletNetwork {
  if (chain === "btc") return WALLET_NETWORKS[mainnetEnabled ? "btc-mainnet" : "btc-signet"];
  return WALLET_NETWORKS[mainnetEnabled ? "eth-mainnet" : "eth-sepolia"];
}

export function requiresMainnetUnlock(networkId: WalletNetworkId): boolean {
  return WALLET_NETWORKS[networkId].mainnet;
}
