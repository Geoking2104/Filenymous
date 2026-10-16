# Holochain-First Sharedrop Defense Design

## Goal

Build the next Filenymous functional revision as a Holochain/Holo Web Conductor first transfer room, with a ShareDrop-like send interface and Rocket.Chat-like room communication primitives.

The first-class mode uses Holochain/HWC for rooms, presence, transfer requests, status history, and encrypted room messages. A browser-only standalone mode remains available as a degraded mode for invitation links, direct WebRTC transfer, and local history.

## Confirmed Decisions

- Prioritize approach 2: Holochain/HWC is the center of gravity.
- Keep the interface as simple as ShareDrop: one room, visible peers, drag a file onto a peer, then accept or refuse.
- Include Rocket.Chat-like minimum communication: presence, accept/refuse workflow, mini-chat, and local history.
- Support both surfaces:
  - `docs/demo/index.html` for the deployed static web experience.
  - `ui/` for the React/Holochain application.
- Keep `p2p-signal` minimal. It may exchange room join data and WebRTC negotiation messages, but not chat contents, file contents, file keys, or long-lived history.
- Treat OrbitDB as a data-shape reference, not a required runtime dependency for the first implementation: append-only event logs plus local indexes.
- Target a defense-grade security posture. This is an engineering target, not a defense certification.

## Source Context

The current codebase already has:

- `docs/demo/index.html`: deployed static web app with standalone encrypted links and P2P direct mode.
- `p2p-signal/server.js`: minimal WebSocket room signaling based on one-time codes.
- `ui/`: React/Vite app with Holochain runtime detection and wallet modules.
- `dnas/filenymous/zomes/`: existing identity, transfer, storage, and parcel zome structure.
- `docs/superpowers/specs/2026-06-21-hwc-wallet-design.md`: prior HWC priority and locked wallet design.

External design references:

- ShareDrop: simple peer room UX, visible peers, drag/drop transfer.
- Rocket.Chat: rooms, presence, messages, and transfer-related conversation.
- OrbitDB: local-first append-only logs and indexes.
- Holochain frontend model: browser apps write through HWC or a local conductor, not through a plain static page alone.

## Architecture

### Runtime Modes

Filenymous must expose one stable product experience while clearly separating capability levels:

- `holo-web`: Holo Web Conductor available. Full Holochain room, presence, chat, transfer request, and status behavior.
- `websocket`: local conductor available. Same functional behavior as `holo-web` for development and desktop users.
- `web-standalone`: no HWC and no local conductor. Limited browser-only mode with code/link invitation, WebRTC transfer, local chat during an active peer connection, and encrypted local history.
- `detecting`: startup mode before runtime selection.

The UI must not claim full distributed Holochain features in `web-standalone`.

### Holochain hApp Layer

Add or extend zome responsibilities around rooms:

- `room`: create room, join room, leave room, invite code metadata, room expiry, access policy.
- `presence`: publish short-lived presence events and resolve active peers.
- `chat`: append encrypted room messages and read authorized room message history.
- `transfer`: keep existing transfer concepts, but add request lifecycle transitions for room-based direct transfer.
- `identity`: reuse or extend pseudonymous identity and public key publication.

The implementation may combine small zomes when that better matches the existing DNA structure, but the public API boundaries must stay clear.

### Direct Transfer Layer

File bytes move over WebRTC DataChannel when possible.

The Holochain layer records intent, authorization, status, and encrypted metadata. It does not need to store file bytes for this revision unless a later implementation explicitly enables DHT-backed encrypted chunk storage.

The transfer path is:

1. Sender drags a file onto a peer avatar.
2. Sender creates a `TransferRequest` through Holochain in full mode.
3. Receiver sees the request and accepts or refuses.
4. If accepted, peers negotiate WebRTC.
5. Browser creates a per-transfer session key.
6. Sender streams encrypted chunks over DataChannel.
7. Receiver verifies integrity before saving.
8. Final status is recorded locally and, in full mode, through Holochain.

### Signal Server Layer

`p2p-signal` remains a minimal rendezvous service:

- joins a room/code;
- relays WebRTC offer/answer/ICE payloads;
- announces peer arrival/departure when needed;
- rate-limits abusive join/signal behavior;
- rejects invalid, expired, or malformed room codes.

It must not persist or relay:

- file bytes;
- file plaintext metadata when avoidable;
- chat message contents;
- private keys or session keys;
- wallet data;
- long-lived room history.

## User Experience

### Main Room

The first screen is a transfer room, not a marketing page.

Required UI elements:

- local pseudonymous avatar;
- peer avatars with online/offline/connecting status;
- visible current room code or invite link;
- compact mini-chat panel;
- local history drawer or tab;
- one obvious drop target behavior: drag a file onto a peer.

The UX should feel like ShareDrop for file transfer, with the communication context of a small private chat room.

### Transfer Request

When a file is dropped onto a peer:

- sender sees pending state;
- receiver sees file name, size, sender pseudonym, and accept/refuse actions;
- receiver acceptance starts WebRTC negotiation;
- refusal records a final refused status;
- timeout records expired status.

### Chat

V1 chat is intentionally small:

- messages are short text messages inside a room;
- messages are encrypted before publication or direct send;
- messages can be displayed from local cache;
- user can clear local history;
- no account is required.

In `web-standalone`, chat exists only after a direct peer channel is established and is stored locally if the user allows local history.

### Local History

Local history includes:

- joined rooms;
- pseudonymous peers seen in those rooms;
- sent and received transfer requests;
- final transfer statuses;
- chat messages where local retention is enabled.

The user must be able to clear local history. The history storage must be encrypted when the local vault is locked.

## Data Model

The data model follows append-only event principles inspired by OrbitDB, implemented with Holochain entries and local IndexedDB indexes.

### Room

Fields:

- `room_id`: opaque random identifier or hash.
- `created_by`: agent public key or pseudonymous sender id.
- `created_at`: timestamp.
- `expires_at`: timestamp.
- `access_policy`: invitation-only for V1.
- `room_label_ciphertext`: optional encrypted label.

Validation:

- reject expired rooms for new joins;
- reject weak or malformed room ids;
- reject access policies outside the supported V1 set.

### PresenceEvent

Fields:

- `room_id`;
- `agent_or_peer_id`;
- `status`: `online | idle | leaving`;
- `avatar_seed_commitment`;
- `created_at`;
- `expires_at`.

Validation:

- presence has short TTL;
- author must match the advertised agent in Holochain modes;
- expired presence is ignored by clients.

### RoomMessage

Fields:

- `room_id`;
- `author_id`;
- `ciphertext`;
- `nonce`;
- `key_id`;
- `created_at`;
- `previous_message_hash`: optional append-only chain hint.

Validation:

- ciphertext size limit;
- valid room id;
- valid timestamp window;
- author is a room participant.

### TransferRequest

Fields:

- `transfer_id`;
- `room_id`;
- `sender_id`;
- `receiver_id`;
- `file_name_ciphertext` or sanitized clear name depending on mode policy;
- `file_size`;
- `file_type_ciphertext` when used;
- `manifest_hash`;
- `integrity_hash`;
- `created_at`;
- `expires_at`;
- `status`: `pending | accepted | refused | negotiating | transferring | done | revoked | expired | failed`.

Validation:

- only allowed state transitions are accepted;
- receiver can accept/refuse;
- sender can revoke;
- expired requests cannot be accepted;
- integrity hash format is enforced.

### LocalVault

Fields:

- encrypted local identity;
- encrypted room history;
- encrypted message cache;
- transfer receipts;
- wallet material from the existing wallet design.

Validation is client-side and test-driven:

- locked vault cannot reveal private material;
- wrong password fails generically;
- clearing history removes local records.

## Security Model

### Security Target

The design targets a defense-grade posture:

- zero-trust assumptions;
- least privilege;
- local-first key custody;
- minimal metadata;
- strict validation;
- minimized logs;
- deploy-time hardening.

It is not a defense certification without external audit, penetration testing, formal risk acceptance, and operational controls.

### Cryptography

Requirements:

- use WebCrypto or audited libraries only;
- create a fresh file session key per transfer;
- encrypt file chunks before network send;
- authenticate chunks with AEAD or explicit MAC;
- hash and verify the complete file manifest;
- rotate room/chat keys when room membership changes where feasible;
- never send decryption keys to `p2p-signal`;
- never store plaintext private keys in Holochain entries or server logs.

### Holochain Authorization

Requirements:

- use capability grants for sensitive zome calls;
- validate all entries and links in integrity zomes;
- enforce author-based permissions for room membership, transfer state transitions, and revocation;
- use countersigning for accept/refuse of sensitive transfer requests if the implementation can keep the UX simple;
- reject stale, replayed, or expired operations.

### Metadata Reduction

Requirements:

- default peers are pseudonymous;
- avatars are deterministic but not personally identifying;
- room labels are optional and encrypted when persisted;
- presence TTL is short;
- invite links expire;
- file names are encrypted where full Holochain mode can support it without breaking UX;
- server logs avoid content, keys, and long-lived identifiers.

### Web Hardening

Requirements:

- strict Content Security Policy for deployed pages;
- no unpinned remote script dependencies;
- no inline secret exposure;
- sanitize file names, room labels, and chat text;
- reject dangerous HTML in user-visible fields;
- secure WebSocket origin checks;
- rate limit signaling joins and relays;
- keep HTTPS mandatory for production.

### Local Storage Hardening

Requirements:

- IndexedDB stores encrypted vault data;
- decrypted keys live only in memory while unlocked;
- wallet local lock behavior remains preserved;
- user can clear history and room cache;
- local retention is explicit and visible.

## Error Handling

The app must degrade explicitly rather than fail silently.

Expected states:

- HWC unavailable: switch to `web-standalone` and show limited capability state.
- Local conductor unavailable: try HWC, then standalone.
- Signal server unavailable: allow Holochain room state, but show direct transfer negotiation unavailable.
- Peer offline: mark request expired or waiting.
- WebRTC negotiation failed: mark direct connection failed and allow retry.
- Integrity failure: reject file, do not save it automatically, record failed status.
- Expired room/code: reject join.
- Revoked transfer: block download and show revoked status.

Errors must not expose raw stack traces, secrets, wallet data, private keys, or decrypted message contents.

## Testing And Validation

### TypeScript Unit Tests

Required coverage:

- room id/code generation;
- room join state transitions;
- peer presence model;
- transfer status state machine;
- encrypted message model;
- local history clear;
- vault locked/unlocked behavior;
- fallback mode capability labels.

### Rust/Zome Tests

Required coverage:

- `Room` validation;
- `PresenceEvent` validation;
- `RoomMessage` validation;
- `TransferRequest` validation;
- expired entry rejection;
- invalid transition rejection;
- author permission checks;
- revocation checks;
- capability grant behavior.

### Signal Server Tests

Required coverage:

- invalid room/code rejected;
- expired code rejected;
- role/peer conflicts rejected;
- malformed JSON rejected;
- rate limit behavior;
- signaling messages do not allow chat or file payload types;
- secrets are not logged.

### UI Tests

Required coverage:

- room opens as the first useful screen;
- avatars render;
- drag/drop onto a peer starts request flow;
- receiver can accept/refuse;
- mini-chat displays and sanitizes messages;
- HWC absent fallback is clear;
- mobile layout does not overlap text or controls.

### Security Tests

Required coverage:

- XSS payloads in file names, room labels, and messages are displayed as text or rejected;
- replayed invitation or transfer transition is rejected;
- altered chunk fails integrity verification;
- keys are absent from logs;
- CSP blocks unauthorized script execution in production build where measurable.

### Deployment Validation

Before public deployment:

- run root tests;
- run `ui` tests;
- run `ui` build;
- run Rust tests where the toolchain is available;
- verify GitHub Pages;
- verify OVH;
- confirm public app text does not overstate full Holochain capability in standalone mode.

## Deployment Impact

The static deployment path remains required:

- GitHub Pages: `https://geoking2104.github.io/Filenymous/`
- OVH: `https://filenymous.eu/`

The first implementation should not require users to download a local conductor for basic transfer. Full Holochain behavior requires HWC or local conductor, and the UI must say that plainly.

`p2p-signal` deployment remains a separate infrastructure requirement for browser-to-browser direct transfer outside pure Holochain room coordination.

## Out Of Scope For V1

- Full Rocket.Chat feature parity.
- Public multi-tenant account system.
- Server-side file storage.
- Server-side message history.
- Custodial wallet behavior.
- Defense certification claims.
- Hardware wallet integration.
- Large organization policy management.
- OrbitDB runtime dependency in production.

## Acceptance Criteria

The revision is ready when:

- the first screen supports a ShareDrop-like room experience;
- full mode uses Holochain/HWC for room, presence, message, and transfer-request state;
- standalone mode remains usable and honestly labeled;
- chat and file bytes are never transported through `p2p-signal`;
- direct transfer uses encrypted chunks and verifies integrity;
- local history is encrypted or unavailable while the vault is locked;
- tests cover the state machines, zome validation, signal restrictions, UI flows, and security cases listed above;
- GitHub Pages and OVH deployments are verified after release.
