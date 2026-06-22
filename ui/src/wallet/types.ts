export type Chain = "btc" | "eth";

export type WalletNetworkId =
  | "btc-signet"
  | "btc-testnet"
  | "btc-mainnet"
  | "eth-sepolia"
  | "eth-mainnet";

export interface WalletNetwork {
  id: WalletNetworkId;
  chain: Chain;
  label: string;
  mainnet: boolean;
}

export interface EncryptedVaultRecord {
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  saltB64: string;
  nonceB64: string;
  ciphertextB64: string;
  createdAt: string;
  updatedAt: string;
}

export interface WalletReceipt {
  id: string;
  chain: Chain;
  network: WalletNetworkId;
  txHash: string;
  amount: string;
  recipient: string;
  createdAt: string;
  status: "submitted" | "confirmed" | "failed";
}
