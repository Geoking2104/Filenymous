# Filenymous P2P signal

Small WebSocket relay used only for WebRTC negotiation.

It stores no files and relays only room joins plus WebRTC offer/answer/ICE payloads. File bytes move directly through the browser `RTCDataChannel`.

## Run locally

```bash
npm install
npm start
```

Default port: `8789`.

Optional environment variables:

- `PORT`: WebSocket port.
- `ALLOWED_ORIGIN`: exact browser origin to accept, for example `https://filenymous.eu`.

For production, deploy this service on a Node-capable host and point `CFG.p2pSignalUrl` in `docs/demo/index.html` to its public `wss://` URL.

