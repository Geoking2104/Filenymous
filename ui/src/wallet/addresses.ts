import { HDKey } from "@scure/bip32";
import { NETWORK, TEST_NETWORK, p2wpkh } from "@scure/btc-signer";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { ethers } from "ethers";

export interface WalletAddresses {
  ethSepolia: string;
  ethMainnet: string;
  btcSignet: string;
  btcTestnet: string;
  btcMainnet: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function derivePrivateKey(seed: Uint8Array, path: string): Uint8Array {
  const key = HDKey.fromMasterSeed(seed).derive(path).privateKey;
  if (!key) throw new Error(`Unable to derive private key for ${path}`);
  return key;
}

function deriveEthAddress(seed: Uint8Array): string {
  const privateKey = derivePrivateKey(seed, "m/44'/60'/0'/0/0");
  return new ethers.Wallet(bytesToHex(privateKey)).address;
}

function deriveBtcAddress(
  seed: Uint8Array,
  path: string,
  network: typeof TEST_NETWORK | typeof NETWORK,
): string {
  const privateKey = derivePrivateKey(seed, path);
  const publicKey = pubECDSA(privateKey, true);
  return p2wpkh(publicKey, network).address;
}

export async function deriveWalletAddresses(seed: Uint8Array): Promise<WalletAddresses> {
  const eth = deriveEthAddress(seed);
  return {
    ethSepolia: eth,
    ethMainnet: eth,
    btcSignet: deriveBtcAddress(seed, "m/84'/1'/0'/0/0", TEST_NETWORK),
    btcTestnet: deriveBtcAddress(seed, "m/84'/1'/0'/0/0", TEST_NETWORK),
    btcMainnet: deriveBtcAddress(seed, "m/84'/0'/0'/0/0", NETWORK),
  };
}
