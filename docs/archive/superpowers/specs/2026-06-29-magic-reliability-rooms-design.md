# Magic UX + Reliability + Secure Rooms Design

## Goal

Make Filenymous unique through three staged product pillars:

1. **Magic Link UX**: a public one-screen transfer experience that feels obvious to non-technical users.
2. **Reliability moat**: resilient encrypted transfers with visible integrity, resume, and fallback paths when direct WebRTC fails.
3. **Secure Rooms**: ephemeral multi-person rooms for temporary file exchange, chat, expiry, and progressive media preview.

This design does not authorize a production deployment by itself. Each implementation release must pass tests, browser validation, and an explicit user approval before deployment.

## Product Principles

- Keep the public experience jargon-free. Iroh, Holochain, conductors, relays, and hashes appear only when useful or under Advanced.
- Prefer one primary action per screen. The default path is "add file, create code/link, share".
- Treat reliability as a trust feature, not a technical showcase. Users should see clear state, recovery, and verification without understanding the protocol.
- Preserve Filenymous as a web app first. No native installer becomes part of the public promise unless a later native architecture is explicitly validated.
- Build in phases so each release is usable on its own and can be deployed independently.

## Release 0.3: Magic Link UX

### Functional Scope

- Replace the public transfer path with a single transfer workspace:
  - add a file or folder;
  - create a one-time code, Magic Link, or QR;
  - show progress, speed, estimated time, and "keep this page open" guidance;
  - show a clear receive confirmation that explains where the downloaded file went.
- Hide advanced transport language from the primary path.
- Keep the current receive model: one input accepts a Filenymous link or one-time code.
- Support folder sharing where the browser allows directory selection.
- If folder selection is not available, explain the limitation and allow multi-file selection.
- Generate a ZIP locally for folder/multi-file fallback before encryption.

### Technical Design

- Add a small transfer state model shared by send and receive:
  - `idle`;
  - `selecting`;
  - `encrypting`;
  - `ready_to_share`;
  - `waiting_for_peer`;
  - `transferring`;
  - `verifying`;
  - `complete`;
  - `failed`;
  - `cancelled`.
- Introduce a `ShareArtifact` structure for UI output:
  - `kind`: `magic-link`, `one-time-code`, `qr`;
  - `url`;
  - `code`;
  - `expiresAt`;
  - `transportHint`;
  - `humanMessage`.
- Keep the static public app in `docs/demo/index.html` and the portable HTML in `filenymous-app.html` synchronized.
- Wrap QR, clipboard, and Web Share API behavior behind small helper functions so unsupported browsers degrade cleanly.
- Use the File System Access API only as progressive enhancement. The fallback is standard file input plus optional local ZIP packaging.

### Acceptance Criteria

- A non-technical user can send a small file from the first screen without seeing Iroh/Holochain terminology.
- A recipient can paste one link or enter one code and gets a localized confirmation after download.
- QR creation and clipboard fallback are covered by tests.
- Folder or multi-file selection has a clear supported and unsupported path.
- Existing anonymous web link and direct P2P flows remain writable without a local conductor.

## Release 0.4: Reliability Moat

### Functional Scope

- When WebRTC direct transfer fails, explain the issue in plain language and offer a fallback path.
- Add resumable transfer behavior for large files:
  - sender and receiver keep a local transfer ledger;
  - interrupted transfers can continue from completed chunks when possible;
  - stale transfer state can be cleared manually.
- Show visible integrity verification:
  - file fingerprint;
  - per-transfer verification state;
  - an optional "Verify" action for advanced users.
- Add a self-hosting path for power users and organizations:
  - Docker profile for signaling and relay support;
  - documented environment variables;
  - healthcheck endpoint;
  - basic operational checklist.

### Technical Design

- Introduce a `TransferManifest` for chunked large files:
  - `version`;
  - `fileName`;
  - `fileSize`;
  - `mimeType`;
  - `chunkSize`;
  - `chunkCount`;
  - `rootHash`;
  - `chunkHashes`;
  - `createdAt`;
  - `expiresAt`;
  - `encryption`;
  - `transport`.
- Use BLAKE3 for content-addressed integrity when available through a reviewed browser-compatible package or WASM bundle.
- Keep SHA-256/WebCrypto as a fallback only if BLAKE3 is unavailable and clearly label that state in Advanced.
- Store transfer ledgers in IndexedDB:
  - manifest id;
  - chunk index;
  - encrypted chunk hash;
  - received/sent status;
  - retry count;
  - last update.
- Define a `TransportAdapter` interface:
  - `canStart()`;
  - `createOffer()`;
  - `join()`;
  - `sendChunk()`;
  - `receiveChunk()`;
  - `close()`.
- First adapters:
  - `WebRtcDirectAdapter`;
  - `EncryptedRelayAdapter`;
  - `IrohReadyAdapter` as an integration boundary until the browser relay path is fully validated.
- Docker self-hosting starts with signaling plus encrypted relay. It must not store plaintext files.

### Acceptance Criteria

- A simulated WebRTC failure presents a user-readable fallback, not a silent failure.
- A large transfer can resume from an interrupted chunk ledger in tests.
- Integrity verification detects a corrupted chunk in tests.
- The self-host Docker profile starts locally and exposes a healthcheck.
- No fallback path stores plaintext files server-side.

## Release 0.5: Secure Rooms

### Functional Scope

- Add temporary rooms for small groups:
  - create room;
  - join with code or link;
  - see participants;
  - drop files into the room;
  - retrieve files before expiry;
  - send short ephemeral messages.
- Add room-level expiry and manual room closure.
- Support progressive preview for browser-supported media when enough verified chunks have arrived.
- Keep the default room experience simple; advanced identity and Holochain persistence remain optional.

### Technical Design

- Start with rooms over the existing signaling layer:
  - room id;
  - room key;
  - peer list;
  - event log;
  - file offers;
  - chat messages;
  - revocations;
  - expiry event.
- Use a per-room symmetric key for room metadata and message encryption.
- Use per-file keys for file content encryption.
- Store room state locally in IndexedDB with an explicit clear action.
- Model room events as append-only records:
  - `peer_joined`;
  - `peer_left`;
  - `message_posted`;
  - `file_offered`;
  - `file_accepted`;
  - `file_revoked`;
  - `room_closed`.
- Later Holochain/Holo Web Conductor integration may persist room coordination, but the public room must not require a local conductor.
- Progressive media preview uses verified chunks only. If MediaSource or format support is missing, the UI falls back to normal download.

### Acceptance Criteria

- Users can create and join a room without conductor setup.
- Multiple participants can see room file offers and messages in a local/browser test path.
- Room expiry removes access UI and prevents new transfers.
- Progressive preview is gated by verified chunks and degrades to download when unsupported.
- Room UI keeps advanced network terms out of the primary flow.

## Production Gate

Each release needs a separate approval before deployment:

1. Implementation plan approved.
2. Tests pass.
3. Browser QA passes on desktop and mobile widths.
4. GitHub Pages staging URL verified.
5. OVH deployment explicitly approved by the user.

No production deployment should happen automatically after implementation.

## Testing Strategy

- Unit tests for transfer state, manifest generation, chunk ledger, adapter selection, room model, and expiry.
- Static HTML tests for public copy and no-jargon guarantees.
- Browser tests for send, receive, QR, progress, and failed-transfer fallback.
- Relay tests for signaling and encrypted relay behavior.
- Rust/Holochain validation remains scoped to advanced Holochain modules and must not block public web-only transfer tests unless touched.

## Out of Scope

- Native `.exe`, `.dmg`, or `.AppImage` installers.
- Public plaintext server storage.
- Mandatory local Holochain conductor setup.
- App Store or Play Store distribution.
- Full browser-direct Iroh claims before the browser relay/direct behavior is validated.

## Open Decisions Resolved

- Delivery order is A, then B, then C.
- Magic Link UX is the lead public differentiator.
- Reliability work is part of the product promise, not only an Advanced panel feature.
- Secure Rooms are a second major product surface after one-to-one transfer is made obvious.
