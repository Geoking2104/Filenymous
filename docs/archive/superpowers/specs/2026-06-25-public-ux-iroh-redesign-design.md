# Public UX + Iroh Redesign Design

## Goal

Make Filenymous understandable to a non-technical public while preserving the existing encrypted file-transfer behavior. The first screen must answer three questions quickly: how to send, how to receive, and where files/history live.

## Product Shape

The public web app becomes task-first:

- Home: three actions, "Envoyer", "Recevoir", "Mes fichiers".
- Send: pick a file, create a one-time code or encrypted link, keep the page open for direct transfer.
- Receive: enter a one-time code or paste a Filenymous link.
- Files: local history plus a public directory area that exposes only links chosen by the user, not a server directory listing.
- Vault: local locked wallet and BTC/ETH guardrails.
- Security: plain-language privacy and defense posture.
- Advanced: Holochain, Holo Web Conductor, Iroh, and identity controls.

## Transport Strategy

Browser-first transfer remains WebRTC DataChannel because it can provide direct browser-to-browser transfer without requiring a local Holochain conductor.

Iroh is introduced as the preferred advanced transport direction:

- Iroh v1 for Rust/native and future server-assisted browser fallback.
- iroh-blobs for BLAKE3 verified file streaming, ranges, and resumable large-file transfer.
- Browser Iroh/WASM is treated as a relay-backed encrypted path until browser UDP/direct NAT traversal becomes available.
- Holochain/HWC remains the advanced coordination and identity layer.

## UX Principles

- Use progressive disclosure: technical details move behind "Avance".
- Keep one primary action per section.
- Preserve IDs and JavaScript entry points so existing tests and behavior remain stable.
- Avoid making OVH/GitHub expose raw directory listings. Public means user-selected public catalog, not open server browsing.
- Improve mobile and keyboard usability with larger touch targets and visible focus states.

## Acceptance

- Static page still includes room-first standalone copy for tests.
- P2P direct controls still expose "P2P direct", "Code a usage unique", `startP2PSend`, and `joinP2PReceive`.
- Web mode must not reintroduce read-only wording.
- Public page must mention Iroh and iroh-blobs without claiming full browser direct Iroh P2P.
- No destructive server-side public directory listing is added.
