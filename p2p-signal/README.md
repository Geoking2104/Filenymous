# Filenymous P2P signal

Small WebSocket relay used only for WebRTC negotiation. It stores no files. It relays room joins and WebRTC offer/answer/ICE payloads, plus the encrypted Room events. File bytes move directly between the browsers' `RTCDataChannel`s.

## Run locally

```bash
npm install
npm start          # ws://127.0.0.1:8789, http://127.0.0.1:8789/health
```

## Endpoints

| Path | Purpose |
|---|---|
| `ws(s)://…/` | Signaling (`join`, `signal`, `leave`, `room-*`). Origin checked against `ALLOWED_ORIGIN`. |
| `GET /health` | `{ ok, rooms, roomSessions, turn }`, for monitoring. |
| `GET /ice` | `{ iceServers }` for `RTCPeerConnection`: STUN plus short-lived TURN credentials. CORS is limited to `ALLOWED_ORIGIN`. |

The `/filenymous-signal` prefix is stripped, so `https://www.opendpe.net/filenymous-signal/health` works behind nginx.

## Environment

- `PORT` (8789)
- `ALLOWED_ORIGIN`: comma-separated exact origins, e.g. `https://filenymous.eu,https://www.filenymous.eu,https://geoking2104.github.io`. Empty means any origin, for dev only.
- `TRUST_PROXY=1`: rate-limit per client using `X-Real-IP` / `X-Forwarded-For`. **Required behind nginx**, otherwise every user shares the 127.0.0.1 bucket (60 msgs/10 s).
- `STUN_URLS`: comma-separated, default `stun:stun.l.google.com:19302`. Set it to an empty string to disable.
- `TURN_URLS`: comma-separated `turn:`/`turns:` URLs, e.g. `turn:turn.filenymous.eu:3478?transport=udp,turn:turn.filenymous.eu:3478?transport=tcp,turns:turn.filenymous.eu:5349?transport=tcp`.
- `TURN_SECRET`: the coturn `static-auth-secret` (TURN REST API). Each `/ice` call gets a credential valid `TURN_TTL_S` seconds (3600 by default), so nothing static ships in the web app.
- `TURN_USERNAME` / `TURN_CREDENTIAL`: static fallback (discouraged).
- `ROOM_TTL_MS`, `RATE_LIMIT_*`, `MAX_*`, `PING_INTERVAL_MS` (25 s WebSocket keepalive).

Keep secrets in `/etc/filenymous-signal.env` (loaded by `filenymous-signal.service` via `EnvironmentFile=`). Never commit them.

## Production deployment (www.opendpe.net)

1. Copy `server.js`, `package.json` and `package-lock.json` to `/opt/filenymous-signal/app`, then run `npm ci --omit=dev`.
2. Install `filenymous-signal.service` in `/etc/systemd/system/`, create `/etc/filenymous-signal.env` (mode 0640, owned by root:filenymous-signal) with `TURN_URLS` and `TURN_SECRET`, then run `systemctl daemon-reload && systemctl restart filenymous-signal`.
3. Make sure the nginx snippet `filenymous-signal-location.conf` matches `nginx-opendpe-location.conf`: WebSocket upgrade headers, `X-Real-IP`, and 3600 s timeouts. Then run `nginx -t && systemctl reload nginx`.
4. Check it: `curl https://www.opendpe.net/filenymous-signal/health` and `curl -H 'Origin: https://filenymous.eu' https://www.opendpe.net/filenymous-signal/ice`.

### TURN (coturn)

Without TURN, roughly 10–20 % of pairs (symmetric NAT, mobile carriers, corporate networks) can't connect. A minimal `/etc/turnserver.conf`:

```
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=<same value as TURN_SECRET>
realm=filenymous.eu
cert=/etc/letsencrypt/live/turn.filenymous.eu/fullchain.pem
pkey=/etc/letsencrypt/live/turn.filenymous.eu/privkey.pem
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
total-quota=200
bps-capacity=0
```

Open 3478/udp+tcp, 5349/tcp and the relay range (49152–65535/udp) in the firewall. TURN only relays already-encrypted DTLS traffic.
