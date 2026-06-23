# Holochain Sharedrop Defense Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Holochain/Holo Web Conductor first transfer room with ShareDrop-style peer UX, encrypted mini-chat, local encrypted history, minimal signaling, and defense-grade validation.

**Architecture:** Add a focused `room_integrity`/`room` zome pair for rooms, presence, encrypted messages, and direct-transfer requests while keeping the existing `parcel` zome for stored parcel delivery. Add a testable TypeScript room/domain layer, then wire it into React and the static demo without moving chat or file bytes through `p2p-signal`.

**Tech Stack:** Holochain HDK/HDI Rust zomes, Tryorama/Vitest integration tests, React 18 + Vite + Zustand, WebCrypto, IndexedDB, Node WebSocket signaling.

---

## File Structure

Create:

- `ui/src/rooms/types.ts` - room, peer, message, transfer request, and history TypeScript contracts.
- `ui/src/rooms/roomModel.ts` - pure room helpers: ids, codes, TTL checks, sanitization, and state transitions.
- `ui/src/rooms/roomModel.test.ts` - unit tests for pure room behavior.
- `ui/src/rooms/historyVault.ts` - encrypted IndexedDB storage for room history.
- `ui/src/rooms/historyVault.test.ts` - encrypted history tests.
- `ui/src/rooms/directTransfer.ts` - DataChannel message model, allowlists, chunk envelopes, and integrity helpers.
- `ui/src/rooms/directTransfer.test.ts` - direct transfer protocol tests.
- `ui/src/holochain/room.ts` - TypeScript zome wrapper.
- `ui/src/holochain/room.test.ts` - wrapper tests using `setClientForTests`.
- `ui/src/components/RoomPanel.tsx` - main room screen.
- `ui/src/components/RoomPanel.test.tsx` - DOM smoke tests without adding a testing framework.
- `dnas/filenymous/zomes/integrity/room_integrity/Cargo.toml` - integrity zome crate manifest.
- `dnas/filenymous/zomes/integrity/room_integrity/src/lib.rs` - entry/link types and validation.
- `dnas/filenymous/zomes/coordinator/room/Cargo.toml` - coordinator zome crate manifest.
- `dnas/filenymous/zomes/coordinator/room/src/lib.rs` - room zome API.
- `tests/src/room_zome.test.ts` - Tryorama tests for room, presence, chat, and transfer-request state.
- `tests/src/p2p_signal_hardening.test.ts` - signal server allowlist and TTL tests.
- `tests/src/static_room_demo.test.ts` - static demo parity checks.

Modify:

- `Cargo.toml` - add room zome workspace members.
- `dnas/filenymous/dna.yaml` - add `room_integrity` and `room` zomes.
- `ui/src/holochain/types.ts` - export room-related interfaces used by wrappers and UI.
- `ui/src/store/useStore.ts` - add `room` tab and room state.
- `ui/src/App.tsx` - render `RoomPanel` as the first useful screen.
- `ui/src/components/Header.tsx` - expose room tab and keep wallet/privacy routes.
- `p2p-signal/server.js` - add TTL, payload allowlist, and rate limiting.
- `tests/src/p2p_signal_server.test.ts` - keep existing guarantees and assert old one-time-code API remains compatible.
- `docs/demo/index.html` - align static web mode with the room UX and standalone limits.

---

### Task 1: Room Domain Model

**Files:**
- Create: `ui/src/rooms/types.ts`
- Create: `ui/src/rooms/roomModel.ts`
- Create: `ui/src/rooms/roomModel.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/rooms/roomModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  canTransitionTransferStatus,
  createInviteCode,
  isPresenceActive,
  roomAvatarInitials,
  sanitizeRoomText,
} from "./roomModel";

describe("room model", () => {
  it("creates human-readable invite codes with enough entropy for V1 rooms", () => {
    const code = createInviteCode(new Uint8Array([0, 1, 2, 3, 4, 5]));
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("treats presence as active only before expiry", () => {
    expect(isPresenceActive({ expiresAtMs: 2_000 }, 1_999)).toBe(true);
    expect(isPresenceActive({ expiresAtMs: 2_000 }, 2_000)).toBe(false);
  });

  it("escapes visible room text and trims long messages", () => {
    expect(sanitizeRoomText("<img src=x onerror=alert(1)>", 80)).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(sanitizeRoomText("abcdef", 3)).toBe("abc");
  });

  it("allows only valid transfer request transitions", () => {
    expect(canTransitionTransferStatus("pending", "accepted", "receiver")).toBe(true);
    expect(canTransitionTransferStatus("pending", "refused", "receiver")).toBe(true);
    expect(canTransitionTransferStatus("pending", "revoked", "sender")).toBe(true);
    expect(canTransitionTransferStatus("done", "accepted", "receiver")).toBe(false);
    expect(canTransitionTransferStatus("pending", "done", "sender")).toBe(false);
  });

  it("derives stable avatar initials from a display name or peer id", () => {
    expect(roomAvatarInitials("Alice Martin", "peer-1")).toBe("AM");
    expect(roomAvatarInitials("", "peer-1")).toBe("PE");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/rooms/roomModel.test.ts
```

Expected: FAIL because `ui/src/rooms/roomModel.ts` does not exist.

- [ ] **Step 3: Add the room contracts**

Create `ui/src/rooms/types.ts`:

```ts
export type RoomRuntimeMode = "holo-web" | "websocket" | "web-standalone";

export type PresenceStatus = "online" | "idle" | "leaving";

export interface RoomPeer {
  peerId: string;
  displayName: string;
  avatarSeed: string;
  status: PresenceStatus;
  lastSeenMs: number;
  expiresAtMs: number;
}

export interface RoomMessage {
  messageId: string;
  roomId: string;
  authorId: string;
  ciphertextB64: string;
  nonceB64: string;
  keyId: string;
  createdAtMs: number;
}

export type TransferRequestStatus =
  | "pending"
  | "accepted"
  | "refused"
  | "negotiating"
  | "transferring"
  | "done"
  | "revoked"
  | "expired"
  | "failed";

export type TransferActor = "sender" | "receiver" | "system";

export interface RoomTransferRequest {
  transferId: string;
  roomId: string;
  senderId: string;
  receiverId: string;
  fileNameCiphertext: string;
  fileSize: number;
  manifestHash: string;
  integrityHash: string;
  status: TransferRequestStatus;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface RoomHistorySnapshot {
  rooms: Array<{ roomId: string; inviteCode: string; lastOpenedMs: number }>;
  peers: RoomPeer[];
  messages: RoomMessage[];
  transfers: RoomTransferRequest[];
}
```

- [ ] **Step 4: Add the pure room model implementation**

Create `ui/src/rooms/roomModel.ts`:

```ts
import type { TransferActor, TransferRequestStatus } from "./types";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createInviteCode(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(9))): string {
  let out = "";
  for (let i = 0; i < 12; i += 1) out += INVITE_ALPHABET[bytes[i % bytes.length] % INVITE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

export function normalizeInviteCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, "").replace(/(.{4})(?=.)/g, "$1-").slice(0, 14);
}

export function isPresenceActive(input: { expiresAtMs: number }, nowMs = Date.now()): boolean {
  return input.expiresAtMs > nowMs;
}

export function sanitizeRoomText(value: string, maxLength = 500): string {
  return value
    .slice(0, maxLength)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function canTransitionTransferStatus(
  from: TransferRequestStatus,
  to: TransferRequestStatus,
  actor: TransferActor,
): boolean {
  const allowed: Record<TransferRequestStatus, Partial<Record<TransferActor, TransferRequestStatus[]>>> = {
    pending: { receiver: ["accepted", "refused"], sender: ["revoked"], system: ["expired"] },
    accepted: { system: ["negotiating"], sender: ["revoked"] },
    refused: {},
    negotiating: { system: ["transferring", "failed"], sender: ["revoked"] },
    transferring: { system: ["done", "failed"], sender: ["revoked"] },
    done: {},
    revoked: {},
    expired: {},
    failed: { sender: ["pending"] },
  };
  return allowed[from][actor]?.includes(to) ?? false;
}

export function roomAvatarInitials(displayName: string, peerId: string): string {
  const base = (displayName.trim() || peerId).replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  const initials = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : base.slice(0, 2);
  return initials.toUpperCase().padEnd(2, "X");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:

```powershell
cd ui
npm test -- src/rooms/roomModel.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add ui/src/rooms/types.ts ui/src/rooms/roomModel.ts ui/src/rooms/roomModel.test.ts
git commit -m "feat: add room domain model"
```

---

### Task 2: Encrypted Local Room History

**Files:**
- Create: `ui/src/rooms/historyVault.ts`
- Create: `ui/src/rooms/historyVault.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/rooms/historyVault.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clearRoomHistory, decryptRoomHistory, encryptRoomHistory, loadRoomHistory, saveRoomHistory } from "./historyVault";
import type { RoomHistorySnapshot } from "./types";

const snapshot: RoomHistorySnapshot = {
  rooms: [{ roomId: "room-a", inviteCode: "ABCD-EFGH-JKLM", lastOpenedMs: 1 }],
  peers: [],
  messages: [],
  transfers: [],
};

describe("room history vault", () => {
  it("encrypts and decrypts a room history snapshot with the same password", async () => {
    const record = await encryptRoomHistory(snapshot, "vault-password");
    expect(record.ciphertextB64).not.toContain("room-a");
    await expect(decryptRoomHistory(record, "wrong")).rejects.toThrow("Unable to unlock room history");
    await expect(decryptRoomHistory(record, "vault-password")).resolves.toEqual(snapshot);
  });

  it("persists and clears encrypted room history", async () => {
    await clearRoomHistory();
    const record = await encryptRoomHistory(snapshot, "vault-password");
    await saveRoomHistory(record);
    expect((await loadRoomHistory())?.ciphertextB64).toBe(record.ciphertextB64);
    await clearRoomHistory();
    await expect(loadRoomHistory()).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/rooms/historyVault.test.ts
```

Expected: FAIL because `historyVault.ts` does not exist.

- [ ] **Step 3: Add encrypted history storage**

Create `ui/src/rooms/historyVault.ts`:

```ts
import type { RoomHistorySnapshot } from "./types";

const DB_NAME = "filenymous-room-history";
const DB_VERSION = 1;
const STORE = "history";
const KEY = "primary";
const KDF_ITERATIONS = 310_000;

export interface EncryptedRoomHistoryRecord {
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  saltB64: string;
  nonceB64: string;
  ciphertextB64: string;
  updatedAt: string;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromB64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", toBuffer(new TextEncoder().encode(password)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toBuffer(salt), iterations: KDF_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptRoomHistory(
  snapshot: RoomHistorySnapshot,
  password: string,
): Promise<EncryptedRoomHistoryRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: toBuffer(nonce) }, key, toBuffer(plaintext)));
  return {
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    saltB64: b64(salt),
    nonceB64: b64(nonce),
    ciphertextB64: b64(ciphertext),
    updatedAt: new Date().toISOString(),
  };
}

export async function decryptRoomHistory(
  record: EncryptedRoomHistoryRecord,
  password: string,
): Promise<RoomHistorySnapshot> {
  try {
    const key = await deriveKey(password, fromB64(record.saltB64));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBuffer(fromB64(record.nonceB64)) },
      key,
      toBuffer(fromB64(record.ciphertextB64)),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as RoomHistorySnapshot;
  } catch {
    throw new Error("Unable to unlock room history");
  }
}

function openDb(): Promise<IDBDatabase> {
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

export async function saveRoomHistory(record: EncryptedRoomHistoryRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadRoomHistory(): Promise<EncryptedRoomHistoryRecord | null> {
  const db = await openDb();
  const record = await new Promise<EncryptedRoomHistoryRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as EncryptedRoomHistoryRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return record;
}

export async function clearRoomHistory(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```powershell
cd ui
npm test -- src/rooms/historyVault.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add ui/src/rooms/historyVault.ts ui/src/rooms/historyVault.test.ts
git commit -m "feat: encrypt local room history"
```

---

### Task 3: Direct Transfer Protocol Guards

**Files:**
- Create: `ui/src/rooms/directTransfer.ts`
- Create: `ui/src/rooms/directTransfer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/rooms/directTransfer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assertAllowedSignalPayload,
  buildChunkEnvelope,
  computeSha256Hex,
  verifyChunkEnvelope,
} from "./directTransfer";

describe("direct transfer protocol", () => {
  it("allows only WebRTC negotiation payloads through the signal layer", () => {
    expect(() => assertAllowedSignalPayload({ kind: "offer", sdp: "x" })).not.toThrow();
    expect(() => assertAllowedSignalPayload({ kind: "answer", sdp: "x" })).not.toThrow();
    expect(() => assertAllowedSignalPayload({ kind: "ice", candidate: { candidate: "x" } })).not.toThrow();
    expect(() => assertAllowedSignalPayload({ kind: "chat", text: "secret" })).toThrow("unsupported signal payload");
    expect(() => assertAllowedSignalPayload({ kind: "chunk", bytes: [1, 2, 3] })).toThrow("unsupported signal payload");
  });

  it("detects altered chunk envelopes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const envelope = await buildChunkEnvelope("transfer-a", 0, bytes);
    await expect(verifyChunkEnvelope(envelope, bytes)).resolves.toBe(true);
    await expect(verifyChunkEnvelope(envelope, new Uint8Array([1, 2, 3, 5]))).resolves.toBe(false);
  });

  it("computes lowercase SHA-256 hex", async () => {
    await expect(computeSha256Hex(new Uint8Array([1, 2, 3]))).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/rooms/directTransfer.test.ts
```

Expected: FAIL because `directTransfer.ts` does not exist.

- [ ] **Step 3: Add protocol guards and chunk integrity helpers**

Create `ui/src/rooms/directTransfer.ts`:

```ts
export type SignalPayload =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: unknown };

export interface ChunkEnvelope {
  transferId: string;
  index: number;
  sha256Hex: string;
  byteLength: number;
}

export function assertAllowedSignalPayload(payload: unknown): asserts payload is SignalPayload {
  if (typeof payload !== "object" || payload === null || !("kind" in payload)) {
    throw new Error("unsupported signal payload");
  }
  const kind = (payload as { kind?: unknown }).kind;
  if (kind === "offer" && typeof (payload as { sdp?: unknown }).sdp === "string") return;
  if (kind === "answer" && typeof (payload as { sdp?: unknown }).sdp === "string") return;
  if (kind === "ice" && "candidate" in payload) return;
  throw new Error("unsupported signal payload");
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildChunkEnvelope(
  transferId: string,
  index: number,
  bytes: Uint8Array,
): Promise<ChunkEnvelope> {
  return {
    transferId,
    index,
    sha256Hex: await computeSha256Hex(bytes),
    byteLength: bytes.byteLength,
  };
}

export async function verifyChunkEnvelope(envelope: ChunkEnvelope, bytes: Uint8Array): Promise<boolean> {
  if (envelope.byteLength !== bytes.byteLength) return false;
  return envelope.sha256Hex === await computeSha256Hex(bytes);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```powershell
cd ui
npm test -- src/rooms/directTransfer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add ui/src/rooms/directTransfer.ts ui/src/rooms/directTransfer.test.ts
git commit -m "feat: add direct transfer protocol guards"
```

---

### Task 4: Room Zome Tryorama Tests

**Files:**
- Create: `tests/src/room_zome.test.ts`

- [ ] **Step 1: Write the failing Tryorama tests**

Create `tests/src/room_zome.test.ts`:

```ts
import { assert, describe, expect, test } from "vitest";
import { AppCallZomeRequest, ActionHash } from "@holochain/client";
import { dhtSync, Player, runScenario, Scenario } from "@holochain/tryorama";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HAPP_PATH = path.join(__dirname, "../../workdir/filenymous.happ");

async function zome<T>(player: Player, zome_name: string, fn_name: string, payload: unknown = null): Promise<T> {
  return player.appAgentWs.callZome({
    cap_secret: null,
    role_name: "filenymous",
    zome_name,
    fn_name,
    payload,
  } as AppCallZomeRequest) as Promise<T>;
}

describe("room zome", () => {
  test("creates a room and publishes presence", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();

      const room = await zome<{ room_id: string }>(alice, "room", "create_room", {
        room_id: "room-alpha",
        expires_at: 9_999_999_999_999,
        access_policy: "invitation_only",
        room_label_ciphertext: "",
      });
      expect(room.room_id).toBe("room-alpha");

      const presenceAh: ActionHash = await zome(alice, "room", "publish_presence", {
        room_id: "room-alpha",
        status: "online",
        avatar_seed_commitment: "avatar-a",
        expires_at: 9_999_999_999_999,
      });
      assert.ok(presenceAh);

      await dhtSync([alice], alice.cells[0].cell_id[0]);
      const snapshot = await zome<{ presences: unknown[] }>(alice, "room", "get_room_snapshot", "room-alpha");
      expect(snapshot.presences.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("stores encrypted room messages and transfer requests", async () => {
    await runScenario(async (scenario: Scenario) => {
      const alice = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      const bob = await scenario.addPlayerWithApp({ path: HAPP_PATH });
      await alice.conductor.startUp();
      await bob.conductor.startUp();
      await scenario.shareAllAgents();

      await zome(alice, "room", "create_room", {
        room_id: "room-beta",
        expires_at: 9_999_999_999_999,
        access_policy: "invitation_only",
        room_label_ciphertext: "",
      });
      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

      const messageAh: ActionHash = await zome(alice, "room", "send_room_message", {
        room_id: "room-beta",
        ciphertext: "ciphertext-b64",
        nonce: "nonce-b64",
        key_id: "room-key-1",
        previous_message_hash: null,
      });
      assert.ok(messageAh);

      const bobKey = await bob.appAgentWs.myPubKey();
      const request = await zome<{ transfer_id: string }>(alice, "room", "create_transfer_request", {
        transfer_id: "transfer-1",
        room_id: "room-beta",
        receiver: bobKey,
        file_name_ciphertext: "encrypted-name",
        file_size: 42,
        file_type_ciphertext: "",
        manifest_hash: "a".repeat(64),
        integrity_hash: "b".repeat(64),
        expires_at: 9_999_999_999_999,
      });
      expect(request.transfer_id).toBe("transfer-1");

      await zome(bob, "room", "update_transfer_request_status", {
        transfer_id: "transfer-1",
        room_id: "room-beta",
        status: "accepted",
      });

      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
      const snapshot = await zome<{ messages: unknown[]; transfer_requests: Array<{ status: string }> }>(bob, "room", "get_room_snapshot", "room-beta");
      expect(snapshot.messages.length).toBeGreaterThanOrEqual(1);
      expect(snapshot.transfer_requests[0].status).toBe("accepted");
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run after `make build-happ` or the existing hApp build command used by this repo:

```powershell
cd tests
npm test -- src/room_zome.test.ts
```

Expected: FAIL because the `room` zome is not in the hApp.

- [ ] **Step 3: Commit the failing test**

```powershell
git add tests/src/room_zome.test.ts
git commit -m "test: cover room zome behavior"
```

---

### Task 5: Room Integrity And Coordinator Zomes

**Files:**
- Create: `dnas/filenymous/zomes/integrity/room_integrity/Cargo.toml`
- Create: `dnas/filenymous/zomes/integrity/room_integrity/src/lib.rs`
- Create: `dnas/filenymous/zomes/coordinator/room/Cargo.toml`
- Create: `dnas/filenymous/zomes/coordinator/room/src/lib.rs`
- Modify: `Cargo.toml`
- Modify: `dnas/filenymous/dna.yaml`

- [ ] **Step 1: Add zome crates to the workspace**

Modify root `Cargo.toml` `members`:

```toml
  "dnas/filenymous/zomes/integrity/room_integrity",
  "dnas/filenymous/zomes/coordinator/room",
```

Place them after the identity zomes and before parcel zomes.

- [ ] **Step 2: Add the integrity crate manifest**

Create `dnas/filenymous/zomes/integrity/room_integrity/Cargo.toml`:

```toml
[package]
name = "room_integrity"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
hdi = { workspace = true }
serde = { workspace = true }
```

- [ ] **Step 3: Add integrity entries and validation**

Create `dnas/filenymous/zomes/integrity/room_integrity/src/lib.rs` with these public entry/link types and validation helpers:

```rust
use hdi::prelude::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PresenceStatus {
    Online,
    Idle,
    Leaving,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TransferRequestStatus {
    Pending,
    Accepted,
    Refused,
    Negotiating,
    Transferring,
    Done,
    Revoked,
    Expired,
    Failed,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct Room {
    pub room_id: String,
    pub created_by: AgentPubKey,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
    pub access_policy: String,
    pub room_label_ciphertext: String,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct PresenceEvent {
    pub room_id: String,
    pub agent: AgentPubKey,
    pub status: PresenceStatus,
    pub avatar_seed_commitment: String,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct RoomMessage {
    pub room_id: String,
    pub author: AgentPubKey,
    pub ciphertext: String,
    pub nonce: String,
    pub key_id: String,
    pub created_at: Timestamp,
    pub previous_message_hash: Option<EntryHash>,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct TransferRequest {
    pub transfer_id: String,
    pub room_id: String,
    pub sender: AgentPubKey,
    pub receiver: AgentPubKey,
    pub file_name_ciphertext: String,
    pub file_size: u64,
    pub file_type_ciphertext: String,
    pub manifest_hash: String,
    pub integrity_hash: String,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct TransferRequestStatusEvent {
    pub transfer_id: String,
    pub room_id: String,
    pub status: TransferRequestStatus,
    pub author: AgentPubKey,
    pub created_at: Timestamp,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    Room(Room),
    PresenceEvent(PresenceEvent),
    RoomMessage(RoomMessage),
    TransferRequest(TransferRequest),
    TransferRequestStatusEvent(TransferRequestStatusEvent),
}

#[hdk_link_types]
pub enum LinkTypes {
    RoomIdToRoom,
    RoomToPresence,
    RoomToMessage,
    RoomToTransferRequest,
    TransferRequestToStatus,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::StoreEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::Room(room) => validate_room(&room, &action.author),
            EntryTypes::PresenceEvent(event) => validate_presence(&event, &action.author),
            EntryTypes::RoomMessage(message) => validate_message(&message, &action.author),
            EntryTypes::TransferRequest(request) => validate_transfer_request(&request, &action.author),
            EntryTypes::TransferRequestStatusEvent(event) => validate_status_event(&event, &action.author),
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_room(room: &Room, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if room.room_id.len() < 8 || room.room_id.len() > 96 {
        return Ok(ValidateCallbackResult::Invalid("room_id length is invalid".into()));
    }
    if room.access_policy != "invitation_only" {
        return Ok(ValidateCallbackResult::Invalid("unsupported room access_policy".into()));
    }
    if &room.created_by != author {
        return Ok(ValidateCallbackResult::Invalid("Room.created_by must equal action author".into()));
    }
    if room.expires_at <= room.created_at {
        return Ok(ValidateCallbackResult::Invalid("room expires_at must be after created_at".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_presence(event: &PresenceEvent, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if event.room_id.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("presence room_id must not be empty".into()));
    }
    if &event.agent != author {
        return Ok(ValidateCallbackResult::Invalid("PresenceEvent.agent must equal action author".into()));
    }
    if event.expires_at <= event.created_at {
        return Ok(ValidateCallbackResult::Invalid("presence expires_at must be after created_at".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_message(message: &RoomMessage, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if message.room_id.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("message room_id must not be empty".into()));
    }
    if &message.author != author {
        return Ok(ValidateCallbackResult::Invalid("RoomMessage.author must equal action author".into()));
    }
    if message.ciphertext.is_empty() || message.ciphertext.len() > 4096 {
        return Ok(ValidateCallbackResult::Invalid("message ciphertext size is invalid".into()));
    }
    if message.nonce.is_empty() || message.key_id.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("message nonce and key_id are required".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_transfer_request(request: &TransferRequest, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &request.sender != author {
        return Ok(ValidateCallbackResult::Invalid("TransferRequest.sender must equal action author".into()));
    }
    if request.transfer_id.is_empty() || request.room_id.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("transfer_id and room_id are required".into()));
    }
    if request.file_size == 0 {
        return Ok(ValidateCallbackResult::Invalid("file_size must be greater than zero".into()));
    }
    if !is_hex_64(&request.manifest_hash) || !is_hex_64(&request.integrity_hash) {
        return Ok(ValidateCallbackResult::Invalid("manifest_hash and integrity_hash must be SHA-256 hex".into()));
    }
    if request.expires_at <= request.created_at {
        return Ok(ValidateCallbackResult::Invalid("transfer expires_at must be after created_at".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_status_event(event: &TransferRequestStatusEvent, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &event.author != author {
        return Ok(ValidateCallbackResult::Invalid("status event author must equal action author".into()));
    }
    if event.transfer_id.is_empty() || event.room_id.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("status event transfer_id and room_id are required".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn is_hex_64(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}
```

- [ ] **Step 4: Add the coordinator crate manifest**

Create `dnas/filenymous/zomes/coordinator/room/Cargo.toml`:

```toml
[package]
name = "room"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
hdk = { workspace = true }
serde = { workspace = true }
room_integrity = { path = "../../integrity/room_integrity" }
```

- [ ] **Step 5: Add coordinator API**

Create `dnas/filenymous/zomes/coordinator/room/src/lib.rs` with exported functions:

```rust
use hdk::prelude::*;
use room_integrity::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateRoomInput {
    pub room_id: String,
    pub expires_at: i64,
    pub access_policy: String,
    pub room_label_ciphertext: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PublishPresenceInput {
    pub room_id: String,
    pub status: PresenceStatus,
    pub avatar_seed_commitment: String,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SendRoomMessageInput {
    pub room_id: String,
    pub ciphertext: String,
    pub nonce: String,
    pub key_id: String,
    pub previous_message_hash: Option<EntryHash>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateTransferRequestInput {
    pub transfer_id: String,
    pub room_id: String,
    pub receiver: AgentPubKey,
    pub file_name_ciphertext: String,
    pub file_size: u64,
    pub file_type_ciphertext: String,
    pub manifest_hash: String,
    pub integrity_hash: String,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateTransferRequestStatusInput {
    pub transfer_id: String,
    pub room_id: String,
    pub status: TransferRequestStatus,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RoomSnapshot {
    pub rooms: Vec<Room>,
    pub presences: Vec<PresenceEvent>,
    pub messages: Vec<RoomMessage>,
    pub transfer_requests: Vec<TransferRequestWithStatus>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TransferRequestWithStatus {
    pub request: TransferRequest,
    pub status: TransferRequestStatus,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RoomOutput {
    pub room_id: String,
    pub action_hash: ActionHash,
}

#[hdk_extern]
pub fn create_room(input: CreateRoomInput) -> ExternResult<RoomOutput> {
    let agent = agent_info()?.agent_initial_pubkey;
    let room = Room {
        room_id: input.room_id.clone(),
        created_by: agent,
        created_at: sys_time()?,
        expires_at: Timestamp::from_micros(input.expires_at),
        access_policy: input.access_policy,
        room_label_ciphertext: input.room_label_ciphertext,
    };
    let action_hash = create_entry(EntryTypes::Room(room.clone()))?;
    create_link(room_anchor(&room.room_id)?, action_hash.clone(), LinkTypes::RoomIdToRoom, ())?;
    Ok(RoomOutput { room_id: room.room_id, action_hash })
}

#[hdk_extern]
pub fn publish_presence(input: PublishPresenceInput) -> ExternResult<ActionHash> {
    let agent = agent_info()?.agent_initial_pubkey;
    let event = PresenceEvent {
        room_id: input.room_id.clone(),
        agent,
        status: input.status,
        avatar_seed_commitment: input.avatar_seed_commitment,
        created_at: sys_time()?,
        expires_at: Timestamp::from_micros(input.expires_at),
    };
    let action_hash = create_entry(EntryTypes::PresenceEvent(event))?;
    create_link(room_anchor(&input.room_id)?, action_hash.clone(), LinkTypes::RoomToPresence, ())?;
    Ok(action_hash)
}

#[hdk_extern]
pub fn send_room_message(input: SendRoomMessageInput) -> ExternResult<ActionHash> {
    let message = RoomMessage {
        room_id: input.room_id.clone(),
        author: agent_info()?.agent_initial_pubkey,
        ciphertext: input.ciphertext,
        nonce: input.nonce,
        key_id: input.key_id,
        created_at: sys_time()?,
        previous_message_hash: input.previous_message_hash,
    };
    let action_hash = create_entry(EntryTypes::RoomMessage(message))?;
    create_link(room_anchor(&input.room_id)?, action_hash.clone(), LinkTypes::RoomToMessage, ())?;
    Ok(action_hash)
}

#[hdk_extern]
pub fn create_transfer_request(input: CreateTransferRequestInput) -> ExternResult<TransferRequestWithStatus> {
    let request = TransferRequest {
        transfer_id: input.transfer_id,
        room_id: input.room_id.clone(),
        sender: agent_info()?.agent_initial_pubkey,
        receiver: input.receiver,
        file_name_ciphertext: input.file_name_ciphertext,
        file_size: input.file_size,
        file_type_ciphertext: input.file_type_ciphertext,
        manifest_hash: input.manifest_hash,
        integrity_hash: input.integrity_hash,
        created_at: sys_time()?,
        expires_at: Timestamp::from_micros(input.expires_at),
    };
    let action_hash = create_entry(EntryTypes::TransferRequest(request.clone()))?;
    create_link(room_anchor(&input.room_id)?, action_hash, LinkTypes::RoomToTransferRequest, ())?;
    create_status_event(&request.transfer_id, &request.room_id, TransferRequestStatus::Pending)?;
    Ok(TransferRequestWithStatus { request, status: TransferRequestStatus::Pending })
}

#[hdk_extern]
pub fn update_transfer_request_status(input: UpdateTransferRequestStatusInput) -> ExternResult<ActionHash> {
    create_status_event(&input.transfer_id, &input.room_id, input.status)
}

#[hdk_extern]
pub fn get_room_snapshot(room_id: String) -> ExternResult<RoomSnapshot> {
    Ok(RoomSnapshot {
        rooms: collect_entries::<Room>(room_anchor(&room_id)?, LinkTypes::RoomIdToRoom)?,
        presences: collect_entries::<PresenceEvent>(room_anchor(&room_id)?, LinkTypes::RoomToPresence)?,
        messages: collect_entries::<RoomMessage>(room_anchor(&room_id)?, LinkTypes::RoomToMessage)?,
        transfer_requests: collect_transfer_requests(&room_id)?,
    })
}

fn create_status_event(transfer_id: &str, room_id: &str, status: TransferRequestStatus) -> ExternResult<ActionHash> {
    let event = TransferRequestStatusEvent {
        transfer_id: transfer_id.to_string(),
        room_id: room_id.to_string(),
        status,
        author: agent_info()?.agent_initial_pubkey,
        created_at: sys_time()?,
    };
    let action_hash = create_entry(EntryTypes::TransferRequestStatusEvent(event))?;
    create_link(status_anchor(transfer_id)?, action_hash.clone(), LinkTypes::TransferRequestToStatus, ())?;
    Ok(action_hash)
}

fn collect_transfer_requests(room_id: &str) -> ExternResult<Vec<TransferRequestWithStatus>> {
    let requests = collect_entries::<TransferRequest>(room_anchor(room_id)?, LinkTypes::RoomToTransferRequest)?;
    let mut out = Vec::new();
    for request in requests {
        out.push(TransferRequestWithStatus {
            status: latest_status(&request.transfer_id)?,
            request,
        });
    }
    Ok(out)
}

fn latest_status(transfer_id: &str) -> ExternResult<TransferRequestStatus> {
    let events = collect_entries::<TransferRequestStatusEvent>(status_anchor(transfer_id)?, LinkTypes::TransferRequestToStatus)?;
    Ok(events.last().map(|event| event.status.clone()).unwrap_or(TransferRequestStatus::Pending))
}

fn collect_entries<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(
    base: AnyLinkableHash,
    link_type: LinkTypes,
) -> ExternResult<Vec<T>> {
    let links = get_links(LinkQuery::try_new(base, link_type)?, GetStrategy::default())?;
    let mut out = Vec::new();
    for link in links {
        if let Ok(action_hash) = ActionHash::try_from(link.target) {
            if let Some(record) = get(action_hash, GetOptions::default())? {
                if let Some(entry) = record.entry().to_app_option::<T>().map_err(|e| wasm_error!(WasmErrorInner::Guest(format!("decode entry: {e}"))))? {
                    out.push(entry);
                }
            }
        }
    }
    Ok(out)
}

fn room_anchor(room_id: &str) -> ExternResult<AnyLinkableHash> {
    Ok(Path::from(format!("rooms.{room_id}")).path_entry_hash()?.into())
}

fn status_anchor(transfer_id: &str) -> ExternResult<AnyLinkableHash> {
    Ok(Path::from(format!("rooms.transfer_status.{transfer_id}")).path_entry_hash()?.into())
}
```

- [ ] **Step 6: Add zomes to DNA manifest**

Modify `dnas/filenymous/dna.yaml`.

Add to `integrity.zomes` after `identity_integrity`:

```yaml
    - name: room_integrity
      path: "../../target/wasm32-unknown-unknown/release/room_integrity.wasm"
```

Add to `coordinator.zomes` after `identity`:

```yaml
    - name: room
      path: "../../target/wasm32-unknown-unknown/release/room.wasm"
      dependencies:
        - name: room_integrity
```

- [ ] **Step 7: Build and run tests**

Run:

```powershell
cargo check --workspace
make build-happ
cd tests
npm test -- src/room_zome.test.ts
```

Expected: PASS for `room_zome.test.ts`.

- [ ] **Step 8: Commit**

```powershell
git add Cargo.toml dnas/filenymous/dna.yaml dnas/filenymous/zomes/integrity/room_integrity dnas/filenymous/zomes/coordinator/room
git commit -m "feat: add holochain room zome"
```

---

### Task 6: TypeScript Room Zome Adapter And Store

**Files:**
- Modify: `ui/src/holochain/types.ts`
- Create: `ui/src/holochain/room.ts`
- Create: `ui/src/holochain/room.test.ts`
- Modify: `ui/src/store/useStore.ts`

- [ ] **Step 1: Write wrapper tests**

Create `ui/src/holochain/room.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { resetClientForTests, setClientForTests } from "./client";
import { roomZome } from "./room";

describe("room zome wrapper", () => {
  afterEach(() => resetClientForTests());

  it("calls room zome functions through the active runtime", async () => {
    const calls: Array<{ zomeName: string; fnName: string; payload: unknown }> = [];
    setClientForTests({
      mode: "holo-web",
      canWrite: true,
      canReadDht: true,
      callZome: async <T,>(zomeName: string, fnName: string, payload: unknown) => {
        calls.push({ zomeName, fnName, payload });
        return { ok: true } as T;
      },
      webBridgeGet: async <T,>() => null as T,
      getMyPubKey: async () => new Uint8Array([1]),
      onSignal: () => undefined,
    });

    await roomZome.createRoom({
      room_id: "room-alpha",
      expires_at: 9_999_999_999,
      access_policy: "invitation_only",
      room_label_ciphertext: "",
    });

    expect(calls[0]).toEqual({
      zomeName: "room",
      fnName: "create_room",
      payload: {
        room_id: "room-alpha",
        expires_at: 9_999_999_999,
        access_policy: "invitation_only",
        room_label_ciphertext: "",
      },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/holochain/room.test.ts
```

Expected: FAIL because `ui/src/holochain/room.ts` does not exist.

- [ ] **Step 3: Add TypeScript room types**

Append to `ui/src/holochain/types.ts`:

```ts
export type HoloPresenceStatus = "online" | "idle" | "leaving";
export type HoloTransferRequestStatus =
  | "pending"
  | "accepted"
  | "refused"
  | "negotiating"
  | "transferring"
  | "done"
  | "revoked"
  | "expired"
  | "failed";

export interface CreateRoomInput {
  room_id: string;
  expires_at: number;
  access_policy: "invitation_only";
  room_label_ciphertext: string;
}

export interface PublishPresenceInput {
  room_id: string;
  status: HoloPresenceStatus;
  avatar_seed_commitment: string;
  expires_at: number;
}

export interface SendRoomMessageInput {
  room_id: string;
  ciphertext: string;
  nonce: string;
  key_id: string;
  previous_message_hash: EntryHash | null;
}

export interface CreateTransferRequestInput {
  transfer_id: string;
  room_id: string;
  receiver: AgentPubKey;
  file_name_ciphertext: string;
  file_size: number;
  file_type_ciphertext: string;
  manifest_hash: string;
  integrity_hash: string;
  expires_at: number;
}

export interface UpdateTransferRequestStatusInput {
  transfer_id: string;
  room_id: string;
  status: HoloTransferRequestStatus;
}
```

- [ ] **Step 4: Add the room zome wrapper**

Create `ui/src/holochain/room.ts`:

```ts
import type { ActionHash } from "@holochain/client";
import { callZome } from "./client";
import type {
  CreateRoomInput,
  CreateTransferRequestInput,
  PublishPresenceInput,
  SendRoomMessageInput,
  UpdateTransferRequestStatusInput,
} from "./types";

export const roomZome = {
  createRoom(input: CreateRoomInput): Promise<{ room_id: string; action_hash: ActionHash }> {
    return callZome("room", "create_room", input);
  },

  publishPresence(input: PublishPresenceInput): Promise<ActionHash> {
    return callZome("room", "publish_presence", input);
  },

  sendRoomMessage(input: SendRoomMessageInput): Promise<ActionHash> {
    return callZome("room", "send_room_message", input);
  },

  createTransferRequest(input: CreateTransferRequestInput): Promise<unknown> {
    return callZome("room", "create_transfer_request", input);
  },

  updateTransferRequestStatus(input: UpdateTransferRequestStatusInput): Promise<ActionHash> {
    return callZome("room", "update_transfer_request_status", input);
  },

  getRoomSnapshot(roomId: string): Promise<unknown> {
    return callZome("room", "get_room_snapshot", roomId);
  },
};
```

- [ ] **Step 5: Add room state to Zustand**

Modify `ui/src/store/useStore.ts`:

```ts
import type { RoomHistorySnapshot, RoomPeer, RoomTransferRequest } from "../rooms/types";
```

Change `Tab`:

```ts
export type Tab = "room" | "send" | "inbox" | "history" | "identity" | "privacy" | "wallet";
```

Add to `State`:

```ts
  roomId: string;
  inviteCode: string;
  peers: RoomPeer[];
  roomTransfers: RoomTransferRequest[];
  roomHistory: RoomHistorySnapshot | null;
  setRoom(room: { roomId: string; inviteCode: string }): void;
  setPeers(peers: RoomPeer[]): void;
  setRoomTransfers(transfers: RoomTransferRequest[]): void;
  setRoomHistory(history: RoomHistorySnapshot | null): void;
```

Add defaults/actions:

```ts
  tab: "room",
  roomId: "",
  inviteCode: "",
  peers: [],
  roomTransfers: [],
  roomHistory: null,
  setRoom: ({ roomId, inviteCode }) => set({ roomId, inviteCode }),
  setPeers: (peers) => set({ peers }),
  setRoomTransfers: (roomTransfers) => set({ roomTransfers }),
  setRoomHistory: (roomHistory) => set({ roomHistory }),
```

- [ ] **Step 6: Run tests**

Run:

```powershell
cd ui
npm test -- src/holochain/room.test.ts src/holochain/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add ui/src/holochain/types.ts ui/src/holochain/room.ts ui/src/holochain/room.test.ts ui/src/store/useStore.ts
git commit -m "feat: add room zome client adapter"
```

---

### Task 7: React Room Experience

**Files:**
- Create: `ui/src/components/RoomPanel.tsx`
- Create: `ui/src/components/RoomPanel.test.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/Header.tsx`

- [ ] **Step 1: Write a DOM smoke test**

Create `ui/src/components/RoomPanel.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import RoomPanel from "./RoomPanel";
import { useStore } from "../store/useStore";

let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
});

describe("RoomPanel", () => {
  it("renders the room as the first transfer surface", () => {
    useStore.setState({
      roomId: "room-alpha",
      inviteCode: "ABCD-EFGH-JKLM",
      peers: [
        { peerId: "peer-b", displayName: "Bob", avatarSeed: "b", status: "online", lastSeenMs: 1, expiresAtMs: Date.now() + 60_000 },
      ],
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(<RoomPanel />);

    expect(document.body.textContent).toContain("Salon de transfert");
    expect(document.body.textContent).toContain("ABCD-EFGH-JKLM");
    expect(document.body.textContent).toContain("Bob");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
cd ui
npm test -- src/components/RoomPanel.test.tsx
```

Expected: FAIL because `RoomPanel.tsx` does not exist.

- [ ] **Step 3: Add `RoomPanel`**

Create `ui/src/components/RoomPanel.tsx`:

```tsx
import { useMemo } from "react";
import { useStore } from "../store/useStore";
import { createInviteCode, roomAvatarInitials, sanitizeRoomText } from "../rooms/roomModel";

function fmtStatus(status: string): string {
  return status === "online" ? "En ligne" : status === "idle" ? "En attente" : "Deconnexion";
}

export default function RoomPanel() {
  const { inviteCode, peers, setRoom } = useStore();
  const effectiveCode = inviteCode || createInviteCode();
  const activePeers = useMemo(() => peers.filter((peer) => peer.status !== "leaving"), [peers]);

  const ensureRoom = () => {
    if (!inviteCode) setRoom({ roomId: `room-${effectiveCode.replace(/-/g, "").toLowerCase()}`, inviteCode: effectiveCode });
  };

  return (
    <section aria-label="Salon de transfert" onMouseEnter={ensureRoom}>
      <div className="card">
        <div className="card-label">Salon de transfert</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800 }}>Filenymous Room</div>
            <div style={{ color: "var(--muted)", fontSize: ".88rem" }}>Holochain/HWC prioritaire, WebRTC direct pour les fichiers.</div>
          </div>
          <code style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: ".55rem .75rem" }}>
            {effectiveCode}
          </code>
        </div>
      </div>

      <div className="card">
        <div className="card-label">Pairs presents</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: ".75rem" }}>
          {activePeers.length === 0 && (
            <div className="empty">Aucun pair dans ce salon pour le moment.</div>
          )}
          {activePeers.map((peer) => (
            <button
              key={peer.peerId}
              className="btn-ghost"
              aria-label={`Envoyer un fichier a ${sanitizeRoomText(peer.displayName || peer.peerId, 80)}`}
              style={{ minHeight: 120, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: ".45rem" }}
            >
              <span style={{ width: 48, height: 48, borderRadius: 24, display: "grid", placeItems: "center", background: "var(--grad-soft)", color: "var(--g2)", fontWeight: 800 }}>
                {roomAvatarInitials(peer.displayName, peer.peerId)}
              </span>
              <strong>{sanitizeRoomText(peer.displayName || peer.peerId, 80)}</strong>
              <span style={{ color: "var(--muted)", fontSize: ".76rem" }}>{fmtStatus(peer.status)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-label">Mini-chat chiffre</div>
        <div className="warn-box">Les messages de salon sont chiffres. En mode autonome, le chat existe seulement apres connexion directe.</div>
        <textarea aria-label="Message de salon" placeholder="Message court..." maxLength={500} />
        <button className="btn-primary btn-full" style={{ marginTop: ".75rem" }}>Envoyer</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Render RoomPanel first**

Modify `ui/src/App.tsx`:

```tsx
import RoomPanel from "./components/RoomPanel";
```

Render:

```tsx
{tab === "room" && <RoomPanel />}
```

Keep existing tabs after it.

- [ ] **Step 5: Add the room tab to Header**

Modify `ui/src/components/Header.tsx` to include a `room` tab as the first navigation item:

```tsx
{ key: "room", label: "Salon" }
```

Use the existing header tab pattern and do not remove wallet/privacy.

- [ ] **Step 6: Run tests and build**

Run:

```powershell
cd ui
npm test -- src/components/RoomPanel.test.tsx src/holochain/room.test.ts src/rooms/roomModel.test.ts
npm run build
```

Expected: tests PASS and build PASS.

- [ ] **Step 7: Commit**

```powershell
git add ui/src/components/RoomPanel.tsx ui/src/components/RoomPanel.test.tsx ui/src/App.tsx ui/src/components/Header.tsx
git commit -m "feat: add room-first transfer interface"
```

---

### Task 8: Minimal Signal Server Hardening

**Files:**
- Create: `tests/src/p2p_signal_hardening.test.ts`
- Modify: `p2p-signal/server.js`
- Modify: `tests/src/p2p_signal_server.test.ts`

- [ ] **Step 1: Write the failing hardening tests**

Create `tests/src/p2p_signal_hardening.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const serverPath = resolve(__dirname, "..", "..", "p2p-signal/server.js");

describe("P2P signal hardening", () => {
  it("limits signal payloads to WebRTC negotiation types", () => {
    const server = readFileSync(serverPath, "utf8");
    expect(server).toContain("validateSignalPayload");
    expect(server).toContain("unsupported-signal-payload");
    expect(server).toContain("offer");
    expect(server).toContain("answer");
    expect(server).toContain("ice");
    expect(server).not.toContain("chat");
    expect(server).not.toContain("fileBytes");
  });

  it("uses room TTL and rate limiting", () => {
    const server = readFileSync(serverPath, "utf8");
    expect(server).toContain("ROOM_TTL_MS");
    expect(server).toContain("RATE_LIMIT_WINDOW_MS");
    expect(server).toContain("rate-limited");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
npm test -- src/p2p_signal_hardening.test.ts src/p2p_signal_server.test.ts
```

Expected: FAIL because hardening symbols are absent.

- [ ] **Step 3: Harden `p2p-signal/server.js`**

Modify `p2p-signal/server.js`:

```js
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 10 * 60 * 1000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10_000);
const RATE_LIMIT_MAX_MESSAGES = Number(process.env.RATE_LIMIT_MAX_MESSAGES || 60);
const rateLimits = new Map();

function now() {
  return Date.now();
}

function validateSignalPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.kind === "offer") return typeof payload.sdp === "string" && payload.sdp.length < 64_000;
  if (payload.kind === "answer") return typeof payload.sdp === "string" && payload.sdp.length < 64_000;
  if (payload.kind === "ice") return typeof payload.candidate === "object" && JSON.stringify(payload.candidate).length < 16_000;
  return false;
}

function checkRateLimit(ws) {
  const key = ws._socket?.remoteAddress || "unknown";
  const current = now();
  const bucket = rateLimits.get(key) || { resetAt: current + RATE_LIMIT_WINDOW_MS, count: 0 };
  if (current > bucket.resetAt) {
    bucket.resetAt = current + RATE_LIMIT_WINDOW_MS;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateLimits.set(key, bucket);
  return bucket.count <= RATE_LIMIT_MAX_MESSAGES;
}
```

Change `roomFor(code)`:

```js
function roomFor(code) {
  const existing = rooms.get(code);
  if (existing && existing.expiresAt > now()) return existing;
  const room = { sender: null, receiver: null, createdAt: now(), expiresAt: now() + ROOM_TTL_MS };
  rooms.set(code, room);
  return room;
}
```

At the start of each `message` handler, after JSON parsing:

```js
    if (!checkRateLimit(ws)) {
      send(ws, { type: "error", error: "rate-limited" });
      return;
    }
```

Inside `msg.type === "signal"` before forwarding:

```js
      if (!validateSignalPayload(payload)) {
        send(ws, { type: "error", error: "unsupported-signal-payload" });
        return;
      }
```

Export:

```js
export { validateOneTimeCode, validateSignalPayload };
```

- [ ] **Step 4: Run the tests**

Run:

```powershell
npm test -- src/p2p_signal_hardening.test.ts src/p2p_signal_server.test.ts
node --check p2p-signal/server.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add p2p-signal/server.js tests/src/p2p_signal_hardening.test.ts tests/src/p2p_signal_server.test.ts
git commit -m "feat: harden p2p signaling"
```

---

### Task 9: Static Demo Room Parity

**Files:**
- Create: `tests/src/static_room_demo.test.ts`
- Modify: `docs/demo/index.html`

- [ ] **Step 1: Write static parity tests**

Create `tests/src/static_room_demo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const demoPath = resolve(__dirname, "..", "..", "docs/demo/index.html");

describe("static room demo", () => {
  it("presents room-first standalone transfer copy", () => {
    const html = readFileSync(demoPath, "utf8");
    expect(html).toContain("Salon de transfert");
    expect(html).toContain("Pairs presents");
    expect(html).toContain("mode autonome");
    expect(html).toContain("Holo Web Conductor");
  });

  it("does not claim full Holochain capability in standalone mode", () => {
    const html = readFileSync(demoPath, "utf8");
    expect(html).toContain("fonctions Holochain completes");
    expect(html).toContain("necessitent Holo Web Conductor");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
npm test -- src/static_room_demo.test.ts
```

Expected: FAIL because the static page still centers the old send/receive panels.

- [ ] **Step 3: Update `docs/demo/index.html` copy and layout markers**

In `docs/demo/index.html`, add a first room panel before the current send panel:

```html
<section id="panel-room" class="panel active">
  <div class="card">
    <p class="card-title">Salon de transfert</p>
    <p class="muted">Mode autonome disponible sans conducteur. Les fonctions Holochain completes necessitent Holo Web Conductor.</p>
    <div class="link-box" style="margin-top:12px">
      <code id="room-code">Code a usage unique</code>
      <button class="btn btn-secondary btn-sm" onclick="copyRoomCode()">Copier</button>
    </div>
  </div>
  <div class="card">
    <p class="card-title">Pairs presents</p>
    <div id="room-peers" class="empty">Aucun pair connecte pour le moment.</div>
  </div>
  <div class="card">
    <p class="card-title">Mini-chat chiffre</p>
    <p class="muted">En mode autonome, le chat passe seulement par la connexion directe WebRTC.</p>
    <textarea id="room-chat-input" maxlength="500" placeholder="Message court..."></textarea>
  </div>
</section>
```

Update nav so `Salon` is the active default:

```html
<button id="tab-room" class="active" onclick="showTab('room')">Salon</button>
```

Change the old send panel class from `panel active` to `panel`.

Add:

```js
window.copyRoomCode = () => {
  navigator.clipboard.writeText(document.getElementById('room-code').textContent).then(() => toast('Code copie !'));
};
```

- [ ] **Step 4: Run static tests**

Run:

```powershell
npm test -- src/static_room_demo.test.ts src/p2p_direct.test.ts src/web_mode_standalone.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add docs/demo/index.html tests/src/static_room_demo.test.ts
git commit -m "feat: add room-first static demo"
```

---

### Task 10: Full Verification And Deployment Readiness

**Files:**
- Modify only if a verification failure identifies a defect in files from prior tasks.

- [ ] **Step 1: Run UI tests and build**

Run:

```powershell
cd ui
npm test
npm run build
```

Expected: all tests PASS, build PASS.

- [ ] **Step 2: Run root tests**

Run:

```powershell
npm test
```

Expected: all root Vitest tests PASS.

- [ ] **Step 3: Run Rust checks**

Run:

```powershell
cargo check --workspace
```

Expected: PASS.

- [ ] **Step 4: Build hApp and run Tryorama room tests**

Run:

```powershell
make build-happ
cd tests
npm test -- src/room_zome.test.ts
```

Expected: PASS.

- [ ] **Step 5: Manual browser verification**

Start preview:

```powershell
cd ui
npm run build
npm run preview -- --host 127.0.0.1
```

Verify with browser automation:

- first useful screen is `Salon`;
- room code is visible;
- peers area is present;
- mini-chat text field is visible;
- no text overlap on mobile width;
- standalone copy does not claim full Holochain behavior.

- [ ] **Step 6: Commit verification fixes if any**

If verification required edits:

```powershell
git add <changed-files>
git commit -m "fix: complete room verification"
```

If no edits were required, do not create an empty commit.

- [ ] **Step 7: Deployment handoff**

Do not deploy until the user explicitly asks for GitHub/OVH publication for this implementation branch.

When deployment is requested:

```powershell
git push origin main
```

Then publish `docs/demo/index.html` to OVH using the established SFTP deployment procedure and verify:

```powershell
$r = Invoke-WebRequest -Uri 'https://filenymous.eu/?check=room-defense' -UseBasicParsing
[pscustomobject]@{
  Status = $r.StatusCode
  Room = ($r.Content -like '*Salon de transfert*')
  HwcCopy = ($r.Content -like '*Holo Web Conductor*')
}
```

Expected: `Status 200`, `Room True`, `HwcCopy True`.

---

## Self-Review

Spec coverage:

- ShareDrop-like room UX is covered in Tasks 1, 7, and 9.
- Holochain/HWC-first room, presence, chat, and transfer-request state is covered in Tasks 4, 5, and 6.
- Standalone mode and honest capability copy are covered in Tasks 7 and 9.
- Signal server minimality and no chat/file payloads are covered in Tasks 3 and 8.
- Local encrypted history is covered in Task 2.
- Tests and deployment verification are covered in Tasks 4 through 10.

Type consistency:

- TypeScript statuses match Rust `TransferRequestStatus` snake_case serialization and client-side string unions.
- `room` zome names match `roomZome` wrapper calls.
- The plan uses existing `parcel` for stored parcel delivery and adds `room` for room communication state.

Security checks:

- Chat/file bytes are blocked from signaling.
- Integrity hashes are mandatory for transfer requests.
- Local room history is encrypted in IndexedDB.
- Public UI copy distinguishes full Holochain modes from standalone mode.
