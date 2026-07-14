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
3. Filenymous creates a one-time code, a self-contained encrypted link, a WebRTC P2P session, or a temporary Room invite.
4. The recipient opens the link or enters the code.
5. Decryption stays local in the recipient's browser.

For small files, the self-contained link remains the simplest path. For larger files, the direct P2P flow keeps both browsers open during the transfer.

## Public Product Modes

- **Send**: the simplest path. Pick files, create the Magic Link number, then share by email, copy-paste, or QR code.
- **Receive**: paste a Filenymous link or enter the one-time code. The browser explains where the downloaded file is saved.
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

To build the Vite UI:

```bash
cd ui
npm run build
```

Holochain artifacts remain in the repository for advanced modules and Rust validation, but they are no longer the public installation mode.

## Security

- Local encryption before transfer.
- No account required.
- One-time code for receive sessions.
- History and keys stored locally in the browser.
- No server-side storage of the plaintext file.
- Local BTC/ETH wallet locked by default.

## License

MIT.
