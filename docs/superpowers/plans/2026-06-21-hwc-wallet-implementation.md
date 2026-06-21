# HWC Priority and Locked Local Wallet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Filenymous web-first with Holo Web Conductor as the preferred runtime and add a locked local BTC/ETH wallet with testnet defaults and guarded mainnet sends.

**Architecture:** Introduce a runtime facade in `ui/src/holochain/client.ts` so the UI talks to a stable interface while adapters handle HWC, local WebSocket, HTTP gateway, and local-only fallback. Add wallet code under `ui/src/wallet/` with encrypted IndexedDB vault storage, deterministic BTC/ETH derivation, guarded send confirmation models, and a new `WalletPanel` tab.

**Tech Stack:** React 18, Vite, TypeScript, Zustand, Vitest, IndexedDB, WebCrypto, `@holo-host/web-conductor-client`, `@holochain/client`, `ethers`, `@scure/btc-signer`, `@scure/bip39`, `@scure/bip32`.

---

## File Map

- Modify `ui/package.json`: add runtime and wallet dependencies plus test dependencies.
- Modify `ui/src/holochain/client.ts`: replace single local-conductor client with runtime facade and adapters.
- Create `ui/src/holochain/runtime.ts`: runtime mode/types and shared request shape.
- Create `ui/src/holochain/runtime.test.ts`: runtime detection/fallback tests.
- Modify `ui/src/store/useStore.ts`: add `wallet` tab and expanded runtime mode type.
- Modify `ui/src/App.tsx`: render `WalletPanel` and treat HWC as connected.
- Modify `ui/src/components/Header.tsx`: add Wallet tab and runtime labels.
- Modify `ui/src/components/SendPanel.tsx`: replace `hasConductor()` logic with `canWrite()`.
- Create `ui/src/wallet/types.ts`: wallet/network/vault/receipt types.
- Create `ui/src/wallet/vault.ts`: IndexedDB vault storage and WebCrypto encryption.
- Create `ui/src/wallet/vault.test.ts`: vault encryption/decryption tests.
- Create `ui/src/wallet/networks.ts`: BTC/ETH network descriptors and mainnet guard helpers.
- Create `ui/src/wallet/networks.test.ts`: network guard tests.
- Create `ui/src/wallet/addresses.ts`: derive BTC/ETH addresses from decrypted seed material.
- Create `ui/src/wallet/addresses.test.ts`: deterministic address tests.
- Create `ui/src/wallet/sendModel.ts`: send form validation and confirmation model.
- Create `ui/src/wallet/sendModel.test.ts`: validation/confirmation tests.
- Create `ui/src/components/WalletPanel.tsx`: vault, receive, and send UI.
- Modify `docs/demo/index.html` and `filenymous-app.html`: keep standalone deployment aligned after React build strategy is confirmed.

## Task 1: Dependencies and Test Harness

**Files:**
- Modify: `ui/package.json`
- Create: `ui/src/test/setup.ts`
- Modify: `ui/vitest.config.ts` if it exists; otherwise create it

- [ ] **Step 1: Add dependency declarations**

Add these dependencies to `ui/package.json`:

```json
{
  "dependencies": {
    "@holo-host/web-conductor-client": "^0.1.0",
    "@scure/bip32": "^1.7.0",
    "@scure/bip39": "^1.6.0",
    "@scure/btc-signer": "^2.2.0",
    "ethers": "^6.17.0"
  },
  "devDependencies": {
    "fake-indexeddb": "^6.0.0",
    "vitest": "^1.6.0"
  }
}
```

Keep existing versions unless `npm install` resolves newer patch versions.

- [ ] **Step 2: Install dependencies**

Run:

```powershell
cd ui
npm install
```

Expected: `package-lock.json` updates and install exits `0`.

- [ ] **Step 3: Add test setup**

Create `ui/src/test/setup.ts`:

```ts
import "fake-indexeddb/auto";
```

- [ ] **Step 4: Ensure UI Vitest config exists**

If `ui/vitest.config.ts` does not exist, create:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

If it exists, add `environment: "jsdom"` and the setup file.

- [ ] **Step 5: Verify test command**

Add this script to `ui/package.json`:

```json
{
  "scripts": {
    "test": "vitest run"
  }
}
```

Run:

```powershell
cd ui
npm test -- --runInBand
```

Expected: no tests found or pass. If Vitest rejects `--runInBand`, run `npm test`.

- [ ] **Step 6: Commit**

```powershell
git add ui/package.json ui/package-lock.json ui/src/test/setup.ts ui/vitest.config.ts
git commit -m "test: add ui test harness"
```

## Task 2: Runtime Facade Types

**Files:**
- Create: `ui/src/holochain/runtime.ts`
- Create: `ui/src/holochain/runtime.test.ts`
- Modify: `ui/src/holochain/client.ts`

- [ ] **Step 1: Write failing tests for mode capability**

Create `ui/src/holochain/runtime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { modeCapabilities } from "./runtime";

describe("modeCapabilities", () => {
  it("allows zome writes only for holo-web and websocket modes", () => {
    expect(modeCapabilities("holo-web").canWrite).toBe(true);
    expect(modeCapabilities("websocket").canWrite).toBe(true);
    expect(modeCapabilities("web-bridge").canWrite).toBe(false);
    expect(modeCapabilities("local-only").canWrite).toBe(false);
  });

  it("allows DHT reads for holo-web, websocket, and web-bridge", () => {
    expect(modeCapabilities("holo-web").canReadDht).toBe(true);
    expect(modeCapabilities("websocket").canReadDht).toBe(true);
    expect(modeCapabilities("web-bridge").canReadDht).toBe(true);
    expect(modeCapabilities("local-only").canReadDht).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/holochain/runtime.test.ts
```

Expected: fail because `./runtime` does not exist.

- [ ] **Step 3: Implement runtime types**

Create `ui/src/holochain/runtime.ts`:

```ts
export type RuntimeMode =
  | "detecting"
  | "holo-web"
  | "websocket"
  | "web-bridge"
  | "local-only";

export interface RuntimeCapabilities {
  canWrite: boolean;
  canReadDht: boolean;
}

export interface HoloRuntimeClient extends RuntimeCapabilities {
  readonly mode: RuntimeMode;
  callZome<T>(zomeName: string, fnName: string, payload?: unknown): Promise<T>;
  webBridgeGet<T>(path: string): Promise<T>;
  getMyPubKey(): Promise<Uint8Array>;
  onSignal(handler: (signal: unknown) => void): void;
}

export function modeCapabilities(mode: RuntimeMode): RuntimeCapabilities {
  return {
    canWrite: mode === "holo-web" || mode === "websocket",
    canReadDht: mode === "holo-web" || mode === "websocket" || mode === "web-bridge",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
cd ui
npm test -- src/holochain/runtime.test.ts
```

Expected: pass.

- [ ] **Step 5: Re-export mode type from client**

Modify `ui/src/holochain/client.ts` so `ClientMode` aliases `RuntimeMode`:

```ts
import type { RuntimeMode } from "./runtime";

export type ClientMode = RuntimeMode;
```

Do not remove existing behavior yet.

- [ ] **Step 6: Commit**

```powershell
git add ui/src/holochain/runtime.ts ui/src/holochain/runtime.test.ts ui/src/holochain/client.ts
git commit -m "feat: add Holo runtime facade types"
```

## Task 3: Runtime Detection Order

**Files:**
- Modify: `ui/src/holochain/client.ts`
- Modify: `ui/src/holochain/runtime.test.ts`

- [ ] **Step 1: Add failing tests for detection order**

Extend `ui/src/holochain/runtime.test.ts`:

```ts
import { createRuntimeDetector } from "./client";

describe("createRuntimeDetector", () => {
  it("selects HWC before local websocket", async () => {
    const detector = createRuntimeDetector({
      createHoloWebClient: async () => ({ mode: "holo-web" as const }),
      createWebsocketClient: async () => ({ mode: "websocket" as const }),
      createWebBridgeClient: async () => ({ mode: "web-bridge" as const }),
      createLocalOnlyClient: () => ({ mode: "local-only" as const }),
    });

    const client = await detector();

    expect(client.mode).toBe("holo-web");
  });

  it("falls back to websocket when HWC fails", async () => {
    const detector = createRuntimeDetector({
      createHoloWebClient: async () => {
        throw new Error("missing HWC");
      },
      createWebsocketClient: async () => ({ mode: "websocket" as const }),
      createWebBridgeClient: async () => ({ mode: "web-bridge" as const }),
      createLocalOnlyClient: () => ({ mode: "local-only" as const }),
    });

    const client = await detector();

    expect(client.mode).toBe("websocket");
  });

  it("falls back to local-only when all network runtimes fail", async () => {
    const detector = createRuntimeDetector({
      createHoloWebClient: async () => {
        throw new Error("missing HWC");
      },
      createWebsocketClient: async () => {
        throw new Error("missing websocket");
      },
      createWebBridgeClient: async () => {
        throw new Error("missing bridge");
      },
      createLocalOnlyClient: () => ({ mode: "local-only" as const }),
    });

    const client = await detector();

    expect(client.mode).toBe("local-only");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/holochain/runtime.test.ts
```

Expected: fail because `createRuntimeDetector` is not exported.

- [ ] **Step 3: Implement detection factory**

In `ui/src/holochain/client.ts`, add:

```ts
import { modeCapabilities, type HoloRuntimeClient, type RuntimeMode } from "./runtime";

type MinimalRuntime = Pick<HoloRuntimeClient, "mode">;

export interface RuntimeFactories<T extends MinimalRuntime = HoloRuntimeClient> {
  createHoloWebClient(): Promise<T>;
  createWebsocketClient(): Promise<T>;
  createWebBridgeClient(): Promise<T>;
  createLocalOnlyClient(): T;
}

export function createRuntimeDetector<T extends MinimalRuntime>(
  factories: RuntimeFactories<T>,
): () => Promise<T> {
  return async () => {
    try {
      return await factories.createHoloWebClient();
    } catch {
      try {
        return await factories.createWebsocketClient();
      } catch {
        try {
          return await factories.createWebBridgeClient();
        } catch {
          return factories.createLocalOnlyClient();
        }
      }
    }
  };
}
```

Resolve duplicate imports by keeping one `RuntimeMode` import.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
cd ui
npm test -- src/holochain/runtime.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add ui/src/holochain/client.ts ui/src/holochain/runtime.test.ts
git commit -m "feat: prefer Holo Web runtime detection"
```

## Task 4: HWC Adapter

**Files:**
- Modify: `ui/src/holochain/client.ts`
- Modify: `ui/src/holochain/runtime.test.ts`

- [ ] **Step 1: Add failing adapter test**

Add to `ui/src/holochain/runtime.test.ts`:

```ts
import { createHoloWebRuntime } from "./client";

describe("createHoloWebRuntime", () => {
  it("wraps a HWC-compatible client as holo-web runtime", async () => {
    const calls: unknown[] = [];
    const runtime = await createHoloWebRuntime(async () => ({
      myPubKey: new Uint8Array([1, 2, 3]),
      callZome: async (request: unknown) => {
        calls.push(request);
        return "ok";
      },
      on: () => undefined,
    }));

    const result = await runtime.callZome("identity", "claim_contact", { contact_hash: "abc" });

    expect(runtime.mode).toBe("holo-web");
    expect(runtime.canWrite).toBe(true);
    expect(result).toBe("ok");
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/holochain/runtime.test.ts
```

Expected: fail because `createHoloWebRuntime` does not exist.

- [ ] **Step 3: Implement HWC runtime**

In `ui/src/holochain/client.ts`, define a HWC-compatible interface:

```ts
type SignalHandler = (signal: unknown) => void;

interface HwcCompatibleClient {
  myPubKey?: Uint8Array;
  callZome<T>(request: unknown, timeoutMs?: number): Promise<T>;
  on?(eventName: "signal", handler: SignalHandler): void;
}

export async function createHoloWebRuntime(
  loadClient: () => Promise<HwcCompatibleClient>,
): Promise<HoloRuntimeClient> {
  const hwc = await loadClient();
  const caps = modeCapabilities("holo-web");
  return {
    mode: "holo-web",
    ...caps,
    callZome<T>(zomeName, fnName, payload = null) {
      return hwc.callZome<T>(
        {
          role_name: ROLE,
          zome_name: zomeName,
          fn_name: fnName,
          payload,
        },
        ZOME_TIMEOUT,
      );
    },
    async webBridgeGet<T>(path: string) {
      return webBridgeGet<T>(path);
    },
    async getMyPubKey() {
      if (!hwc.myPubKey) throw new Error("AgentPubKey non disponible via Holo Web Conductor.");
      return hwc.myPubKey;
    },
    onSignal(handler) {
      hwc.on?.("signal", handler);
    },
  };
}
```

Add production loader:

```ts
async function loadDefaultHoloWebClient(): Promise<HwcCompatibleClient> {
  const mod = await import("@holo-host/web-conductor-client");
  const ClientCtor = (mod as { default?: new (options: unknown) => HwcCompatibleClient }).default;
  if (!ClientCtor) throw new Error("Holo Web Conductor client export missing.");
  return new ClientCtor({ appId: __HC_APP_ID__ });
}
```

Add `declare const __HC_APP_ID__: string;` near the other Vite constants.

- [ ] **Step 4: Run tests**

Run:

```powershell
cd ui
npm test -- src/holochain/runtime.test.ts
```

Expected: pass. If TypeScript complains about the HWC package types, add `ui/src/types/holo-web-conductor-client.d.ts` with a minimal module declaration and include it in the commit.

- [ ] **Step 5: Commit**

```powershell
git add ui/src/holochain/client.ts ui/src/holochain/runtime.test.ts ui/src/types/holo-web-conductor-client.d.ts
git commit -m "feat: add Holo Web Conductor adapter"
```

## Task 5: Activate Runtime Facade in the App

**Files:**
- Modify: `ui/src/holochain/client.ts`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/Header.tsx`
- Modify: `ui/src/components/SendPanel.tsx`
- Modify: `ui/src/store/useStore.ts`

- [ ] **Step 1: Add failing tests for write capability helper**

Add to `ui/src/holochain/runtime.test.ts`:

```ts
import { canWrite, resetClientForTests, setClientForTests } from "./client";

describe("client write helper", () => {
  it("returns true for holo-web runtime", () => {
    setClientForTests({
      mode: "holo-web",
      canWrite: true,
      canReadDht: true,
      callZome: async () => null,
      webBridgeGet: async () => null,
      getMyPubKey: async () => new Uint8Array(),
      onSignal: () => undefined,
    });

    expect(canWrite()).toBe(true);
    resetClientForTests();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/holochain/runtime.test.ts
```

Expected: fail because helpers do not exist.

- [ ] **Step 3: Replace internal client state**

In `ui/src/holochain/client.ts`, migrate `_client` from `AppClient | null` to `HoloRuntimeClient | null`.

Add:

```ts
export function canWrite(): boolean {
  return _client?.canWrite ?? false;
}

export function canReadDht(): boolean {
  return _client?.canReadDht ?? false;
}

export function setClientForTests(client: HoloRuntimeClient): void {
  _client = client;
  _mode = client.mode;
}

export function resetClientForTests(): void {
  _client = null;
  _mode = "detecting";
  _connecting = null;
}
```

Update `callZome`, `webBridgeGet`, `getMyPubKey`, and `onSignal` to delegate to `_client`.

- [ ] **Step 4: Update UI connected state**

In `ui/src/App.tsx`, change:

```ts
if (alive) setNet({ connected: mode === "websocket", mode, peers: 0 });
```

to:

```ts
if (alive) setNet({ connected: mode === "holo-web" || mode === "websocket", mode, peers: 0 });
```

- [ ] **Step 5: Update header labels**

In `ui/src/components/Header.tsx`, use:

```ts
const modeLabel =
  net.mode === "holo-web" ? "Holo Web"
  : net.mode === "websocket" ? "Holochain local"
  : net.mode === "web-bridge" ? "Holo Web Bridge"
  : net.mode === "local-only" ? "Local"
  : "Connexion...";
```

Use green for `holo-web` and `websocket`, amber for `web-bridge`, gray for `local-only` and `detecting`.

- [ ] **Step 6: Update SendPanel guard**

In `ui/src/components/SendPanel.tsx`, replace:

```ts
import { hasConductor } from "../holochain/client";
```

with:

```ts
import { canWrite } from "../holochain/client";
```

Replace:

```ts
if (!hasConductor()) {
  alert("Envoi impossible en mode Web Bridge. Installez Holochain Launcher.");
  return;
}
```

with:

```ts
if (!canWrite()) {
  alert("Envoi impossible sans Holo Web Conductor ou conducteur Holochain local.");
  return;
}
```

- [ ] **Step 7: Run tests and build**

Run:

```powershell
cd ui
npm test -- src/holochain/runtime.test.ts
npm run build
```

Expected: both pass.

- [ ] **Step 8: Commit**

```powershell
git add ui/src/holochain/client.ts ui/src/holochain/runtime.test.ts ui/src/App.tsx ui/src/components/Header.tsx ui/src/components/SendPanel.tsx ui/src/store/useStore.ts
git commit -m "feat: activate Holo runtime facade"
```

## Task 6: Wallet Types and Network Guardrails

**Files:**
- Create: `ui/src/wallet/types.ts`
- Create: `ui/src/wallet/networks.ts`
- Create: `ui/src/wallet/networks.test.ts`
- Modify: `ui/src/store/useStore.ts`

- [ ] **Step 1: Write failing network tests**

Create `ui/src/wallet/networks.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/wallet/networks.test.ts
```

Expected: fail because wallet modules do not exist.

- [ ] **Step 3: Implement wallet types**

Create `ui/src/wallet/types.ts`:

```ts
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
```

- [ ] **Step 4: Implement network guards**

Create `ui/src/wallet/networks.ts`:

```ts
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
```

- [ ] **Step 5: Add wallet tab type**

In `ui/src/store/useStore.ts`, change:

```ts
export type Tab = "send" | "inbox" | "history" | "identity" | "privacy";
```

to:

```ts
export type Tab = "send" | "inbox" | "history" | "identity" | "privacy" | "wallet";
```

- [ ] **Step 6: Run tests**

Run:

```powershell
cd ui
npm test -- src/wallet/networks.test.ts
npm run build
```

Expected: pass.

- [ ] **Step 7: Commit**

```powershell
git add ui/src/wallet/types.ts ui/src/wallet/networks.ts ui/src/wallet/networks.test.ts ui/src/store/useStore.ts
git commit -m "feat: add wallet network guardrails"
```

## Task 7: Encrypted Wallet Vault

**Files:**
- Create: `ui/src/wallet/vault.ts`
- Create: `ui/src/wallet/vault.test.ts`

- [ ] **Step 1: Write failing vault tests**

Create `ui/src/wallet/vault.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decryptSeed, encryptSeed } from "./vault";

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/wallet/vault.test.ts
```

Expected: fail because vault module does not exist.

- [ ] **Step 3: Implement encryption functions**

Create `ui/src/wallet/vault.ts`:

```ts
import type { EncryptedVaultRecord } from "./types";

const KDF_ITERATIONS = 310_000;

function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function b64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveWrappingKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: KDF_ITERATIONS },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSeed(seed: Uint8Array, password: string): Promise<EncryptedVaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWrappingKey(password, salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, seed));
  const now = new Date().toISOString();
  return {
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    saltB64: bytesToB64(salt),
    nonceB64: bytesToB64(nonce),
    ciphertextB64: bytesToB64(encrypted),
    createdAt: now,
    updatedAt: now,
  };
}

export async function decryptSeed(record: EncryptedVaultRecord, password: string): Promise<Uint8Array> {
  try {
    const salt = b64ToBytes(record.saltB64);
    const nonce = b64ToBytes(record.nonceB64);
    const ciphertext = b64ToBytes(record.ciphertextB64);
    const key = await deriveWrappingKey(password, salt);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  } catch {
    throw new Error("Unable to unlock wallet");
  }
}
```

- [ ] **Step 4: Run vault tests**

Run:

```powershell
cd ui
npm test -- src/wallet/vault.test.ts
```

Expected: pass.

- [ ] **Step 5: Add IndexedDB persistence**

Extend `vault.ts` with:

```ts
const DB_NAME = "filenymous-wallet";
const DB_VERSION = 1;
const STORE = "vault";
const VAULT_KEY = "primary";

function openWalletDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveVault(record: EncryptedVaultRecord): Promise<void> {
  const db = await openWalletDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record, VAULT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadVault(): Promise<EncryptedVaultRecord | null> {
  const db = await openWalletDb();
  const result = await new Promise<EncryptedVaultRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(VAULT_KEY);
    req.onsuccess = () => resolve((req.result as EncryptedVaultRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function deleteVault(): Promise<void> {
  const db = await openWalletDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(VAULT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
```

- [ ] **Step 6: Add persistence test**

Add to `vault.test.ts`:

```ts
import { deleteVault, loadVault, saveVault } from "./vault";

it("stores and loads the encrypted vault record", async () => {
  await deleteVault();
  const record = await encryptSeed(new Uint8Array([1, 2, 3]), "pw");

  await saveVault(record);
  const loaded = await loadVault();

  expect(loaded?.ciphertextB64).toBe(record.ciphertextB64);
});
```

- [ ] **Step 7: Run tests and commit**

Run:

```powershell
cd ui
npm test -- src/wallet/vault.test.ts
```

Expected: pass.

Commit:

```powershell
git add ui/src/wallet/vault.ts ui/src/wallet/vault.test.ts
git commit -m "feat: add encrypted wallet vault"
```

## Task 8: Deterministic Addresses

**Files:**
- Create: `ui/src/wallet/addresses.ts`
- Create: `ui/src/wallet/addresses.test.ts`

- [ ] **Step 1: Write failing address tests**

Create `ui/src/wallet/addresses.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { deriveWalletAddresses } from "./addresses";

describe("deriveWalletAddresses", () => {
  it("derives stable ETH and BTC receive addresses from a seed", async () => {
    const seed = mnemonicToSeedSync("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");

    const addresses = await deriveWalletAddresses(seed);

    expect(addresses.ethSepolia).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(addresses.ethMainnet).toBe(addresses.ethSepolia);
    expect(addresses.btcSignet).toMatch(/^(tb1|bcrt1|[mn2])[a-zA-Z0-9]+$/);
    expect(addresses.btcMainnet).toMatch(/^(bc1|[13])[a-zA-Z0-9]+$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/wallet/addresses.test.ts
```

Expected: fail because addresses module does not exist.

- [ ] **Step 3: Implement ETH and BTC address derivation**

Create `ui/src/wallet/addresses.ts`:

```ts
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
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

function deriveBtcAddress(seed: Uint8Array, path: string, network: typeof btc.TEST_NETWORK | typeof btc.NETWORK): string {
  const privateKey = derivePrivateKey(seed, path);
  const publicKey = btc.utils.pubSchnorr(privateKey);
  return btc.p2wpkh(publicKey, network).address!;
}

export async function deriveWalletAddresses(seed: Uint8Array): Promise<WalletAddresses> {
  const eth = deriveEthAddress(seed);
  return {
    ethSepolia: eth,
    ethMainnet: eth,
    btcSignet: deriveBtcAddress(seed, "m/84'/1'/0'/0/0", btc.TEST_NETWORK),
    btcTestnet: deriveBtcAddress(seed, "m/84'/1'/0'/0/0", btc.TEST_NETWORK),
    btcMainnet: deriveBtcAddress(seed, "m/84'/0'/0'/0/0", btc.NETWORK),
  };
}
```

If `@scure/btc-signer` exposes a different compressed public key helper in the installed version, inspect its package types and replace `btc.utils.pubSchnorr` with the package-supported compressed secp256k1 public key helper. Keep the test assertions unchanged.

- [ ] **Step 4: Run tests**

Run:

```powershell
cd ui
npm test -- src/wallet/addresses.test.ts
```

Expected: pass after matching installed BTC signer API.

- [ ] **Step 5: Commit**

```powershell
git add ui/src/wallet/addresses.ts ui/src/wallet/addresses.test.ts
git commit -m "feat: derive local wallet addresses"
```

## Task 9: Wallet Send Confirmation Model

**Files:**
- Create: `ui/src/wallet/sendModel.ts`
- Create: `ui/src/wallet/sendModel.test.ts`

- [ ] **Step 1: Write failing tests**

Create `ui/src/wallet/sendModel.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/wallet/sendModel.test.ts
```

Expected: fail because send model does not exist.

- [ ] **Step 3: Implement send model**

Create `ui/src/wallet/sendModel.ts`:

```ts
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

function parsePositiveDecimal(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

export function buildSendConfirmation(draft: SendDraft): SendConfirmation {
  if (requiresMainnetUnlock(draft.network) && !draft.mainnetEnabled) {
    throw new Error("Mainnet is locked");
  }
  if (!draft.recipient.trim()) throw new Error("Recipient is required");
  const amount = parsePositiveDecimal(draft.amount, "Amount");
  const fee = parsePositiveDecimal(draft.fee, "Fee");
  return {
    chain: draft.chain,
    network: draft.network,
    recipient: draft.recipient.trim(),
    amount: draft.amount,
    fee: draft.fee,
    total: String(amount + fee),
    irreversibleWarning: "Crypto transactions are irreversible after broadcast.",
  };
}
```

- [ ] **Step 4: Run tests and commit**

Run:

```powershell
cd ui
npm test -- src/wallet/sendModel.test.ts
```

Expected: pass.

Commit:

```powershell
git add ui/src/wallet/sendModel.ts ui/src/wallet/sendModel.test.ts
git commit -m "feat: add wallet send confirmation model"
```

## Task 10: Wallet UI Tab

**Files:**
- Create: `ui/src/components/WalletPanel.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/Header.tsx`

- [ ] **Step 1: Add Wallet panel skeleton**

Create `ui/src/components/WalletPanel.tsx`:

```tsx
import { useState } from "react";
import { generateMnemonic, mnemonicToSeedSync, wordlist } from "@scure/bip39";
import { deriveWalletAddresses } from "../wallet/addresses";
import { decryptSeed, encryptSeed, loadVault, saveVault } from "../wallet/vault";

type VaultState = "locked" | "unlocked";

export default function WalletPanel() {
  const [password, setPassword] = useState("");
  const [state, setState] = useState<VaultState>("locked");
  const [addresses, setAddresses] = useState<{ ethSepolia: string; btcSignet: string } | null>(null);
  const [message, setMessage] = useState("");

  async function createVault() {
    if (password.length < 10) {
      setMessage("Mot de passe wallet trop court.");
      return;
    }
    const mnemonic = generateMnemonic(wordlist);
    const seed = mnemonicToSeedSync(mnemonic);
    const record = await encryptSeed(seed, password);
    await saveVault(record);
    const derived = await deriveWalletAddresses(seed);
    setAddresses({ ethSepolia: derived.ethSepolia, btcSignet: derived.btcSignet });
    setState("unlocked");
    setMessage("Coffre cree. Notez la phrase de recuperation maintenant, elle ne sera pas affichee a nouveau.");
  }

  async function unlockVault() {
    const record = await loadVault();
    if (!record) {
      setMessage("Aucun coffre local.");
      return;
    }
    const seed = await decryptSeed(record, password);
    const derived = await deriveWalletAddresses(seed);
    setAddresses({ ethSepolia: derived.ethSepolia, btcSignet: derived.btcSignet });
    setState("unlocked");
    setMessage("Coffre deverrouille.");
  }

  return (
    <div>
      <div className="card">
        <div className="card-label">Wallet local verrouille</div>
        <div className="warn-box">
          Les cles restent chiffrees dans ce navigateur. Testnet/Sepolia sont actifs par defaut; mainnet reste verrouille.
        </div>
        <div className="form-row">
          <label className="form-label">Mot de passe du coffre</label>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        <div style={{ display: "flex", gap: ".75rem" }}>
          <button className="btn-primary" onClick={createVault}>Creer coffre</button>
          <button className="btn-ghost" onClick={unlockVault}>Deverrouiller</button>
          <button className="btn-ghost" onClick={() => { setState("locked"); setAddresses(null); }}>Verrouiller</button>
        </div>
        {message && <p style={{ marginTop: ".8rem", color: "var(--muted)" }}>{message}</p>}
      </div>

      {state === "unlocked" && addresses && (
        <div className="card">
          <div className="card-label">Recevoir</div>
          <div className="form-row">
            <label className="form-label">Ethereum Sepolia</label>
            <input readOnly value={addresses.ethSepolia} />
          </div>
          <div className="form-row">
            <label className="form-label">Bitcoin Signet/Testnet</label>
            <input readOnly value={addresses.btcSignet} />
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-label">Envoyer</div>
        <div className="info-box">
          L'envoi signe et diffuse sera ajoute apres validation des providers testnet et des confirmations mainnet.
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add Wallet tab to Header**

In `ui/src/components/Header.tsx`, add:

```ts
{ id: "wallet", label: "Wallet", icon: "W" }
```

Use ASCII icon `W` or a local icon pattern. Do not introduce new emoji if the file encoding is already corrupted.

- [ ] **Step 3: Render WalletPanel**

In `ui/src/App.tsx`, import:

```ts
import WalletPanel from "./components/WalletPanel";
```

Add in the main tab render block:

```tsx
{tab === "wallet" && <WalletPanel />}
```

- [ ] **Step 4: Run build**

Run:

```powershell
cd ui
npm run build
```

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add ui/src/components/WalletPanel.tsx ui/src/App.tsx ui/src/components/Header.tsx
git commit -m "feat: add locked wallet tab"
```

## Task 11: Wallet Send UI Guardrails

**Files:**
- Modify: `ui/src/components/WalletPanel.tsx`
- Modify: `ui/src/wallet/sendModel.ts`
- Modify: `ui/src/wallet/sendModel.test.ts`

- [ ] **Step 1: Extend tests for BTC/ETH recipient validation**

Add tests:

```ts
it("rejects empty recipient", () => {
  expect(() =>
    buildSendConfirmation({
      chain: "btc",
      network: "btc-signet",
      mainnetEnabled: false,
      recipient: "",
      amount: "0.001",
      fee: "0.00001",
    }),
  ).toThrow("Recipient is required");
});
```

- [ ] **Step 2: Run test**

Run:

```powershell
cd ui
npm test -- src/wallet/sendModel.test.ts
```

Expected: pass if current model already covers it; otherwise fix.

- [ ] **Step 3: Add send form to WalletPanel**

In `WalletPanel.tsx`, add state:

```tsx
const [chain, setChain] = useState<"btc" | "eth">("eth");
const [mainnetEnabled, setMainnetEnabled] = useState(false);
const [recipient, setRecipient] = useState("");
const [amount, setAmount] = useState("");
const [fee, setFee] = useState("");
const [confirmation, setConfirmation] = useState<string>("");
```

Use `getNetwork` and `buildSendConfirmation` to show a confirmation text. Do not broadcast transactions in this task.

- [ ] **Step 4: Add guarded confirmation handler**

In `WalletPanel.tsx`, implement:

```tsx
function prepareSend() {
  try {
    const network = getNetwork(chain, mainnetEnabled);
    const model = buildSendConfirmation({
      chain,
      network: network.id,
      mainnetEnabled,
      recipient,
      amount,
      fee,
    });
    setConfirmation(`${network.label}: envoyer ${model.amount}, frais ${model.fee}, total ${model.total} vers ${model.recipient}. ${model.irreversibleWarning}`);
  } catch (error) {
    setConfirmation("");
    setMessage(error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 5: Run build and tests**

Run:

```powershell
cd ui
npm test -- src/wallet/sendModel.test.ts
npm run build
```

Expected: pass.

- [ ] **Step 6: Commit**

```powershell
git add ui/src/components/WalletPanel.tsx ui/src/wallet/sendModel.ts ui/src/wallet/sendModel.test.ts
git commit -m "feat: add wallet send guardrails"
```

## Task 12: Standalone Demo Alignment

**Files:**
- Modify: `filenymous-app.html`
- Modify: `docs/demo/index.html`

- [ ] **Step 1: Decide build source**

If the deployed OVH/GitHub site must continue using `docs/demo/index.html` as a single static file, port the user-facing HWC mode labels and Wallet tab copy into `filenymous-app.html`, then copy it to `docs/demo/index.html`.

If the Vite build becomes the deployment artifact, update the deployment workflow before modifying `docs/demo/index.html`.

For the first implementation, keep the existing single-file path.

- [ ] **Step 2: Add static Wallet copy**

In `filenymous-app.html`, add a `Wallet` tab and panel matching the React UI copy. The static wallet panel may show:

```html
<p class="card-title">Wallet local verrouille</p>
<p>Version web: coffre local chiffre, testnet/Sepolia par defaut, mainnet verrouille.</p>
```

Do not add incomplete real wallet signing logic to the standalone file in this task.

- [ ] **Step 3: Copy standalone file**

Run:

```powershell
Copy-Item -LiteralPath filenymous-app.html -Destination docs/demo/index.html -Force
```

- [ ] **Step 4: Verify static file markers**

Run:

```powershell
Select-String -Path docs/demo/index.html -Pattern "Wallet local verrouille","holoDeployed","Filenymous"
```

Expected: all three markers present.

- [ ] **Step 5: Commit**

```powershell
git add filenymous-app.html docs/demo/index.html
git commit -m "feat: align standalone web wallet copy"
```

## Task 13: Full Verification

**Files:**
- No edits expected

- [ ] **Step 1: Run UI tests**

```powershell
cd ui
npm test
```

Expected: all UI tests pass.

- [ ] **Step 2: Run UI build**

```powershell
cd ui
npm run build
```

Expected: TypeScript and Vite build pass.

- [ ] **Step 3: Run Rust checks**

```powershell
cargo fmt --all -- --check
cargo check --workspace --target wasm32-unknown-unknown
cargo clippy --workspace --target wasm32-unknown-unknown --all-targets -- -D warnings
```

Expected: pass. If Holochain external zomes require copied WASMs, run the existing Makefile target before checking packaging.

- [ ] **Step 4: Run existing integration tests if local binaries exist**

```powershell
cd tests
npm test
```

Expected: pass only if `hc` and required Holochain services are installed. If missing, record the missing binary output.

- [ ] **Step 5: Browser smoke test**

Run:

```powershell
cd ui
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

Open `http://127.0.0.1:4173/` and verify:

- Header shows Holo Web, Holochain local, Holo Web Bridge, Local, or Connecting without layout break.
- Wallet tab appears.
- Creating a wallet vault works.
- Lock/unlock works.
- Receive addresses appear.
- Send confirmation blocks mainnet until enabled.

- [ ] **Step 6: Commit verification-only fixes**

If verification required fixes, commit the exact files changed by those fixes. For example, if the runtime facade needed a TypeScript correction, run:

```powershell
git add ui/src/holochain/client.ts ui/src/holochain/runtime.ts
git commit -m "fix: complete HWC wallet verification"
```

## Task 14: GitHub and OVH Deployment

**Files:**
- Modify only if deployment config needs changes

- [ ] **Step 1: Push main**

```powershell
git status --short --branch
git push origin main
```

Expected: push succeeds.

- [ ] **Step 2: Verify GitHub Pages**

```powershell
$r = Invoke-WebRequest -Uri "https://geoking2104.github.io/Filenymous/?check=$(Get-Date -UFormat %s)" -UseBasicParsing
$r.StatusCode
$r.Content.Contains("Filenymous")
$r.Content.Contains("Wallet")
```

Expected: `200`, `True`, `True`.

- [ ] **Step 3: Deploy to OVH via SFTP**

Use the already validated SFTP path:

- host: `ftp.cluster129.hosting.ovh.net`
- user: `filenyb`
- remote file: `/home/filenyb/www/index.html`

Upload `docs/demo/index.html` and verify remote size equals local size.

- [ ] **Step 4: Verify OVH**

```powershell
$r = Invoke-WebRequest -Uri "https://filenymous.eu/?check=$(Get-Date -UFormat %s)" -UseBasicParsing
$r.StatusCode
$r.Content.Contains("Filenymous")
$r.Content.Contains("Wallet")
```

Expected: `200`, `True`, `True`.

## Self-Review

- Spec coverage: HWC priority, local conductor compatibility, web-bridge/local-only fallback, wallet vault, testnet defaults, mainnet guardrails, and deployment are covered.
- Placeholder scan: no incomplete implementation instructions are present. The only conditional step is the explicit standalone-vs-Vite deployment decision, resolved to keep the existing single-file path for first implementation.
- Type consistency: runtime modes use `holo-web`, `websocket`, `web-bridge`, `local-only`, and `detecting` consistently. Wallet network ids match `WalletNetworkId`.
