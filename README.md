# Filenymous

P2P web app for sending and receiving encrypted files without an account, without a native installer, and without requiring a local Holochain conductor.

- OVH site: https://filenymous.eu/ (landing) - app at https://filenymous.eu/app/
- GitHub Pages mirror: https://geoking2104.github.io/Filenymous/ (landing) - app at https://geoking2104.github.io/Filenymous/app/
- Releases: https://github.com/Geoking2104/Filenymous/releases/latest

## Positioning

Filenymous remains a web application. The Windows, macOS, and Linux files published in releases are portable web archives that contain `Filenymous.html`; they open in a modern browser.

The project no longer publishes `.exe`, `.dmg`, or `.AppImage` files while the native architecture is not necessary and stable again.

## How It Works

1. The sender selects a file in the browser.
2. The file is encrypted locally with WebCrypto.
3. Filenymous creates a one-time code, a self-contained encrypted link (optionally password-protected with Argon2id), a WebRTC P2P session, or a temporary Room invite.
4. The recipient opens the link or enters the code.
5. Decryption stays local in the recipient's browser.

For small files, the self-contained link remains the simplest path. For larger files, the direct P2P flow keeps both browsers open during the transfer.

## Direct transfer (file.pizza-style)

The **⚡ Direct (P2P)** path in *Send* streams files straight from the sender's browser to the recipient's, with nothing stored anywhere:

1. Pick one or more files (any size) and choose **Direct (P2P)**. Browser-only mode switches to it automatically when files are too large or too many for a self-contained link.
2. Filenymous shows a short code (`123-456-ABC`), a share link `…/app/#p2p:123-456-ABC/<secret>` and its **QR code** (plus copy and the native share sheet).
3. The recipient opens the link or scans the QR code. The page connects on its own, lists the files and offers **Download**. They can also type the code or use **📷 Scan a QR code** in *Receive*, which reuses the optical-transfer camera scanner.
4. **The sender keeps the tab open.** It serves the files to one recipient at a time, as many times as needed, until the sender clicks *Stop sharing* or closes the tab.

How it works:

- **Signaling:** `p2p-signal/` (WebSocket) only relays SDP offers, answers and ICE candidates for the one-time code room. It reconnects automatically and keeps the room alive while the sender stays connected.
- **Transport:** an ordered `RTCDataChannel` carries 64 KiB chunks with backpressure (`bufferedAmountLowThreshold`). Files are read with `File.slice()`, so they are never loaded whole into memory.
- **End-to-end encryption:** on top of DTLS, each chunk is sealed with AES-256-GCM. The key is derived (HKDF) from a 128-bit secret that only exists in the URL fragment. Each chunk gets a unique IV, and its position goes into the AAD, so a reordered or swapped chunk fails to decrypt. A recipient who typed only the code gets the secret over the DataChannel, wrapped with a PBKDF2 key derived from the code.
- **Saving:** in Chromium the browser streams to disk with the File System Access API (`showSaveFilePicker`, or `showDirectoryPicker` for several files). Elsewhere it falls back to Blob downloads and warns before very large files.
- **NAT traversal:** STUN by default. Strict NATs or corporate firewalls need a **TURN** relay: the web app gets short-lived TURN credentials from `GET <signal>/ice` (see `p2p-signal/README.md`). Without TURN, those networks show "Direct connection failed".

Code: `ui/src/p2p/` (protocol, signaling client, sender and receiver sessions, sinks, UI panels). Tests: `ui/src/p2p/protocol.test.ts` and `ui/e2e/p2p-direct.spec.ts`. The e2e test runs a real two-browser transfer through a local relay.

## Public Product Modes

- **Send**: pick files, then either start a live **Direct (P2P)** transfer (link + QR code, keep the tab open) or create a Magic Link to share by email, copy-paste, or QR code.
- **Receive**: paste a Filenymous link, enter the one-time code, or scan a QR code with the camera. The browser explains where the downloaded file is saved.
- **Rooms**: create a temporary private room for group sharing. The current web UI generates an invite link, lists participants, queues room files locally, and provides a lightweight room chat surface.
- **History**: local browser history for transfers the user explicitly created or received.
- **Advanced**: network, identity, privacy, wallet, Holochain, and Iroh details. The public path does not require users to understand this section.

## Target Architecture

- **WebCrypto**: local AES-256-GCM encryption.
- **WebRTC DataChannel**: browser-to-browser transfer when peers can reach each other.
- **Web signaling**: minimal rendezvous exchange, without storing the plaintext file.
- **Mode ROOM**: E2E-room-ready model for multiple participants, file queues, room messages, expiration, and future revocation.
- **Iroh / iroh-blobs**: path for verifiable large files and encrypted relays.
- **Holochain / Holo Web Conductor**: advanced option for identity, contacts, DHT, and coordination without forcing the general public to run a local conductor.

## Downloads

GitHub releases publish web packages only:

- `filenymous-public-web.zip`
- `filenymous-windows-web.zip`
- `filenymous-macos-web.zip`
- `filenymous-linux-web.zip`
- `ui.zip`

The platform-specific archives contain the same web application with a short README adapted to the platform.

## Development

```bash
cd ui
npm install
npm run dev
```

Direct transfers in dev need a local relay (the UI uses `ws://127.0.0.1:8789` on localhost):

```bash
cd p2p-signal && npm install && npm start
```

Override at build time with `VITE_P2P_SIGNAL_URL` (WebSocket URL) and optionally `VITE_P2P_ICE_SERVERS` (JSON `RTCIceServer[]`, which skips `/ice`).

Tests:

```bash
cd ui && npm test && npx playwright test        # unit + e2e (incl. two-browser P2P)
cd tests && npm test                            # repo-level suite (Tryorama tests need a Holochain conductor)
```

To build the Vite UI:

```bash
cd ui
npm run build
```

Holochain artifacts remain in the repository for advanced modules and Rust validation, but they are no longer the public installation mode.

## Security

- Local encryption before transfer.
- Optional password protection on links (Argon2id-derived key wrapping, zero-knowledge).
- No account required.
- One-time code for receive sessions.
- History and keys stored locally in the browser.
- No server-side storage of the plaintext file.
- Local BTC/ETH wallet locked by default.

## License

MIT.
