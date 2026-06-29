# Filenymous

P2P web app for sending and receiving encrypted files without an account, without a native installer, and without requiring a local Holochain conductor.

- OVH site: https://filenymous.eu/
- GitHub Pages: https://geoking2104.github.io/Filenymous/
- Releases: https://github.com/Geoking2104/Filenymous/releases/latest

## Positioning

Filenymous remains a web application. The Windows, macOS, and Linux files published in releases are portable web archives that contain `Filenymous.html`; they open in a modern browser.

The project no longer publishes `.exe`, `.dmg`, or `.AppImage` files while the native architecture is not necessary and stable again.

## How It Works

1. The sender selects a file in the browser.
2. The file is encrypted locally with WebCrypto.
3. Filenymous creates a one-time code, a self-contained encrypted link, or a WebRTC P2P session.
4. The recipient opens the link or enters the code.
5. Decryption stays local in the recipient's browser.

For small files, the self-contained link remains the simplest path. For larger files, the direct P2P flow keeps both browsers open during the transfer.

## Public app features

- **Folder & multi-file sharing**: select a whole folder or several files; Filenymous packs them into a single `.zip` in the browser before encrypting and sending.
- **Magic-link QR**: any share link can be shown as a QR code generated locally in the browser; the link and key never leave the page.
- **Live progress**: send and receive show the percentage, transfer speed, and an estimated time remaining.
- **Integrity verification**: every transfer exposes a SHA-256 content fingerprint. The sender can share it and the recipient can paste it and click **Verify** to confirm the file is intact. (BLAKE3, the Iroh hash, will replace SHA-256 once the Iroh transport lands.)
- **Installable PWA**: Filenymous can be installed on iOS, Android, and desktop from the browser ("Add to Home Screen"), with no app store, and its shell opens offline.
- **Plain-language UI**: the home and send screens avoid networking jargon; the technical transports (WebRTC, Iroh, Holochain/HWC, BLAKE3) are tucked behind an **Advanced** disclosure.

### PWA assets

The installable/offline experience relies on three static files served next to the app HTML: `manifest.webmanifest`, `sw.js`, and `icon.svg`. The raster app icons (192px, 512px, and a maskable 512px) are embedded directly inside the manifest as `data:` URIs, so no separate PNG files are needed. These files are kept in `docs/demo/` (GitHub Pages) and mirrored at the repository root next to `filenymous-app.html`. When deploying to a custom host (for example OVH), upload these three files alongside the HTML so install and offline mode keep working.

## Target Architecture

- **WebCrypto**: local AES-256-GCM encryption.
- **WebRTC DataChannel**: browser-to-browser transfer when peers can reach each other.
- **Web signaling**: minimal rendezvous exchange, without storing the plaintext file.
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
