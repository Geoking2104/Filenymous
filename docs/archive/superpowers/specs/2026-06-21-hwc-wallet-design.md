# HWC Priority and Locked Local Wallet Design

## Goal

Build the online Filenymous experience around Holo Web Conductor first, while preserving local conductor compatibility and adding a non-custodial BTC/ETH wallet whose keys stay encrypted locally.

## Decisions

- Holochain web mode is the primary runtime.
- The app prefers Holo Web Conductor plus Linker for write-capable browser use without a local Holochain conductor.
- The existing local Holochain conductor path remains supported for desktop and developer use.
- If HWC and local conductor are unavailable, the web app falls back to read-only gateway behavior or local-only state.
- The wallet is local and non-custodial.
- Testnet/Sepolia are the default networks.
- Mainnet is available only after an explicit unlock flow and per-send confirmation.

## Source Context

The current Holochain front-end docs describe `AppWebsocket.connect()` as a local WebSocket connection to a conductor. That remains correct for desktop/local conductor mode, but not sufficient for a pure online browser experience.

The Holo Web Conductor architecture splits the conductor job:

- browser-side agency: keys, signing, WASM execution, source-chain authorship;
- Linker-side network access: DHT reads, publishing signed actions, and relay to Holochain authorities.

This design follows that split. Filenymous must not claim full browser write access unless HWC and a Linker-compatible infrastructure are actually connected.

## Runtime Architecture

Create a runtime facade that hides the concrete Holochain transport from the rest of the UI.

Runtime modes:

- `holo-web`: Holo Web Conductor via `@holo-host/web-conductor-client`.
- `websocket`: local conductor via `@holochain/client`.
- `web-bridge`: HTTP gateway/read-only bridge.
- `local-only`: encrypted local browser storage with no Holochain writes.
- `detecting`: startup state before runtime selection completes.

The app initializes runtimes in this order:

1. Try HWC.
2. Try local conductor WebSocket.
3. Try HTTP web bridge/gateway.
4. Fall back to local-only.

The UI calls a stable `HoloRuntimeClient` interface:

```ts
export type RuntimeMode =
  | "detecting"
  | "holo-web"
  | "websocket"
  | "web-bridge"
  | "local-only";

export interface HoloRuntimeClient {
  readonly mode: RuntimeMode;
  readonly canWrite: boolean;
  readonly canReadDht: boolean;
  callZome<T>(zomeName: string, fnName: string, payload?: unknown): Promise<T>;
  webBridgeGet<T>(path: string): Promise<T>;
  getMyPubKey(): Promise<Uint8Array>;
  onSignal(handler: (signal: unknown) => void): void;
}
```

Only `holo-web` and `websocket` allow `callZome` writes. `web-bridge` may read public gateway data. `local-only` only allows local encrypted records and UI state.

## Holo Web Behavior

When HWC is available:

- the app connects through `@holo-host/web-conductor-client`;
- the user sees Holo Web as the active mode;
- sending files, receiving parcels, contact key publication, history, revoke, and expiry use zome calls;
- private file contents and AES keys remain encrypted before publication;
- app copy clearly says that the browser uses HWC and Linker, not a locally installed conductor.

When HWC is absent:

- the app tries the local conductor for desktop/dev users;
- if neither is available, write actions are disabled;
- read-only or local-only behavior remains visible and usable.

## Wallet Architecture

Add a new `Wallet` tab independent from file transfer flows.

Wallet views:

- `Vault`: create, import, unlock, lock, and destroy local wallet data.
- `Receive`: show BTC and ETH addresses for the selected network.
- `Send`: send BTC or ETH after validation and confirmation.

Wallet state is stored only in IndexedDB. Private material is encrypted before storage.

Recommended libraries:

- `ethers` for ETH account derivation, signing, JSON-RPC calls, and transaction broadcast.
- `@scure/btc-signer` for BTC transaction construction/signing.
- `@scure/bip39` or equivalent audited mnemonic support for seed generation/import.

The first implementation should use deterministic wallet derivation from one encrypted seed phrase:

- ETH path: `m/44'/60'/0'/0/0`.
- BTC testnet/signet path: `m/84'/1'/0'/0/0`.
- BTC mainnet path: `m/84'/0'/0'/0/0`.

## Wallet Security Model

The wallet is non-custodial:

- keys and seed phrase never leave the browser;
- Holochain never receives seed phrases, private keys, or wallet passwords;
- Filenymous servers never receive seed phrases, private keys, or wallet passwords;
- only public addresses, optional transaction hashes, or local receipts may be shown or stored.

Vault encryption:

- derive a wrapping key from the user's wallet password using PBKDF2 or Argon2id if a browser-safe audited implementation is added;
- encrypt seed material with AES-256-GCM;
- store salt, nonce, KDF parameters, encrypted seed, wallet metadata, and version in IndexedDB;
- never store the wallet password;
- keep decrypted seed material only in memory while unlocked;
- auto-lock after inactivity.

Mainnet guardrails:

- testnet/Sepolia are default;
- enabling BTC/ETH mainnet requires an explicit settings toggle;
- each mainnet send requires a confirmation screen;
- confirmation shows network, recipient, amount, fee estimate, total spend, and irreversible-send warning;
- BTC UTXO source and ETH RPC source must be configurable before mainnet is considered production-ready.

## Data Flow

Holochain send flow:

1. User selects a file and recipient.
2. Browser encrypts file locally with AES-GCM.
3. Browser wraps AES key for recipient.
4. Runtime facade selects HWC or local conductor.
5. App calls zomes through the active runtime.
6. DHT receives encrypted chunks/metadata only.

Wallet send flow:

1. User unlocks local vault.
2. App derives the selected chain account in memory.
3. User enters recipient and amount.
4. App estimates fee and builds unsigned transaction.
5. User confirms final send.
6. App signs locally.
7. App broadcasts through selected BTC/ETH provider.
8. App stores a local receipt with tx hash, network, timestamp, and status.

## Error Handling

Runtime detection failures are non-fatal. The app should always land in one mode and explain capability limits.

HWC errors:

- extension missing: show install/setup guidance;
- Linker unavailable: show network unavailable and keep local/read-only actions available;
- zome call rejected: show the zome/function name and safe message, not raw secrets or stack traces.

Wallet errors:

- wrong password: generic unlock failure;
- missing provider: send disabled until provider configured;
- insufficient funds: show balance and required total;
- fee estimation failure: allow retry, do not send;
- broadcast failure: keep signed transaction only in memory unless user explicitly exports it.

## Testing Strategy

Unit tests:

- runtime detection order and fallback behavior;
- `callZome` blocked in `web-bridge` and `local-only`;
- wallet vault encryption/decryption round trip;
- wrong password rejection;
- network guardrails for mainnet activation;
- send confirmation model validation.

Integration tests:

- existing local conductor mode still works with `@holochain/client`;
- HWC adapter can be mocked through the runtime facade;
- wallet IndexedDB persistence works in browser-like tests.

Manual/browser tests:

- HWC unavailable shows fallback;
- local conductor unavailable does not block the app;
- wallet create/unlock/lock flow works;
- testnet send path reaches confirmation without mainnet enabled.

## Deployment

The online build must keep the standalone `docs/demo/index.html` deploy path working for GitHub Pages and OVH.

Deployment rules:

- bundle dependencies for the React/Vite app where possible;
- keep the single-file static deploy path until a replacement deployment pipeline is explicit;
- do not publish mainnet wallet UI as default-enabled;
- verify both GitHub Pages and OVH after each deploy.

## Out of Scope For First Implementation

- Custodial wallet services.
- Server-side signing.
- Automatic mainnet provider selection without user visibility.
- Storing seed phrases or private keys in Holochain entries.
- Cross-device wallet sync.
- Multi-account wallet management beyond one BTC and one ETH account.
- Hardware wallet support.
