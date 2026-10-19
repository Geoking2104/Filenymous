# Deploying filenymous.eu

Verified facts (2026-07-14) — how the public site is actually hosted and updated.

## Hosting

- **filenymous.eu is served by OVH shared hosting** (mutualisé), service name
  `filenyb.cluster129.hosting.ovh.net`, offer "Free hosting 100 Mo", IPv4 `51.91.236.255`
  (= `cluster129.hosting.ovh.net`), Apache. Renewal: April 2028.
- **It is NOT hosted on the opendpe VPS.** Checked 2026-07-14: the VPS
  (`vps-088d27a3.vps.ovh.net`, `51.210.9.71`) returns 404 for `Host: filenymous.eu`,
  and DNS points to cluster129. An earlier session assumed VPS+SSH deployment — that
  assumption was wrong; ignore any VPS/scp deployment kit for this domain.
- Home directory of the hosting: `/home/filenyb`, web root: `/home/filenyb/www`.

## What gets deployed

- The site has two files since the 2026-07 redesign:
  - `docs/demo/index.html` (dark landing page) -> upload as `www/index.html`
  - `docs/demo/app/index.html` (the standalone app) -> upload as `www/app/index.html`
- The React app (`ui/`) is NOT what filenymous.eu serves.
- Mirror: GitHub Pages auto-publishes `docs/demo/` via `.github/workflows/pages.yml`
  on every push to `main` → https://geoking2104.github.io/Filenymous/

## How to update the site

1. Get the current `docs/demo/index.html` from `main`.
2. Connect with **SFTP** (recommended) or FTP:
   - Host: `ftp.cluster129.hosting.ovh.net` — SFTP port 22, FTP port 21
   - User: `filenyb`
   - Password: not stored anywhere; if lost, reset it in OVH Manager →
     Hébergements → filenymous.eu → FTP-SSH. (Alternative: OVH Manager "FTP Explorer" web UI.)
3. Back up the current remote `www/index.html` (download it) before overwriting.
4. Upload the new file as `www/index.html`. No cache layer — changes are live immediately.

## State as of 2026-07-14

- Production was last deployed from commit `f6b91cf` (2026-07-06, "Add live public room
  transfers", 261,300 bytes normalized) — 9+ commits behind `main`.
- `main` head: `ae37cef` (Contacts/Identity tabs in the React UI — does not change
  `docs/demo/index.html`; the standalone file gained the rooms UX fixes up to `c4635bb`).

## State as of 2026-10-09

- `filenymous.eu` (root **and** `/app/`) now serves the React UI build from
  `main@cf1de0d`+ — Argon2id password-protected links, browser-only
  self-contained sends, `#sl`/`#slp` deep links, on-chain expiry enforcement.
- Deployed over SFTP with `scripts/deploy-ovh-sftp.mjs` (Node +
  ssh2-sftp-client; no WinSCP/PowerShell 7 required): `/app/` via full-dir
  swap (previous dir kept as `app.bak-<ts>`), web root via per-file merge
  (overwritten files kept under `www.bak-<ts>`).
- OVH's web FTP client (Net2FTP "FTP Explorer") is discontinued — file
  management must go through FTP/SFTP with the main `filenyb` account
  (the Free hosting plan does not allow additional FTP users).

## Other OVH services of the account (context)

| Service | Domain | Cluster |
|---|---|---|
| filenyb | filenymous.eu | cluster129 |
| autonyz | autonymous.me | cluster029 (FTP via cluster129 history) |
| opendpn | opendpe.net | cluster121 |
| VPS vps-088d27a3 | opendpe VPS (51.210.9.71) | — |

## P2P signaling relay (QR / one-time codes)

- Endpoint: `wss://www.opendpe.net/filenymous-signal/` — served by the **opendpe VPS**
  (`vps-088d27a3.vps.ovh.net`, 51.210.9.71), NOT the shared hosting.
- Components on the VPS: systemd service `filenymous-signal` (node, port 8789,
  `/opt/filenymous-signal/app`) + nginx snippet
  `/etc/nginx/snippets/filenymous-signal-location.conf` included in the 443 blocks of
  `/etc/nginx/sites-enabled/opendpe.net`.
- `ALLOWED_ORIGIN=https://filenymous.eu,https://geoking2104.github.io` (exact origins). For the browser extension, append `,chrome-extension://*,moz-extension://*` (or `chrome-extension://<store id>` once published); see `extension/README.md`.
- **Known failure mode (happened 2026-07-07):** replacing/regenerating the opendpe.net
  vhost drops the `include snippets/filenymous-signal-location.conf;` lines → the relay
  returns 404 and every cross-device QR/code fails with "Unable to reach the P2P
  signaling server". After ANY change to the opendpe.net vhost, re-check:
  `curl -si https://www.opendpe.net/filenymous-signal/ | head -2` → expected **426**, not 404.
- Never leave `*.bak` files inside `/etc/nginx/sites-enabled/` (nginx loads them as
  vhosts); backups live in `/etc/nginx/vhost-backups/`.
- SSH access: key `opendpe_vps_ed25519` (user `root`) — works from Linux; Windows
  OpenSSH may fail silently on this key (ACL), use the sandbox/WSL if needed.

## Direct P2P transfer in the React UI, rollout checklist

The React UI (what filenymous.eu serves) now has its own direct-transfer path (`ui/src/p2p/`). It uses the same relay, `wss://www.opendpe.net/filenymous-signal/`. To ship it:

1. **Relay (VPS):** deploy the new `p2p-signal/server.js`. It adds `/health`, `/ice`, ws keepalive, proxy-aware rate limiting, and keeps the room alive while the sender stays connected. Install the updated unit (`TRUST_PROXY=1`, `www.filenymous.eu` origin, `EnvironmentFile=-/etc/filenymous-signal.env`), then `systemctl daemon-reload && systemctl restart filenymous-signal`.
2. **nginx snippet:** align `/etc/nginx/snippets/filenymous-signal-location.conf` with `p2p-signal/nginx-opendpe-location.conf` (3600 s read/send timeouts). Then run `nginx -t && systemctl reload nginx`.
3. **TURN:** configure coturn with `use-auth-secret`, and put `TURN_URLS` and `TURN_SECRET` in `/etc/filenymous-signal.env` (see `p2p-signal/README.md`). The standalone `docs/demo/app/index.html` still embeds a **static TURN username/password** for `51.210.9.71`. Once the TURN REST secret is in place, rotate that credential.
4. **Check:** `curl https://www.opendpe.net/filenymous-signal/health` should return `{"ok":true,...}`, and `curl -H 'Origin: https://filenymous.eu' https://www.opendpe.net/filenymous-signal/ice` should list a `turn:` entry.
5. **UI:** `cd ui && npm ci && npm run build`, then deploy `ui/dist` to `/app/` with `scripts/deploy-ovh-sftp.mjs` as usual. Smoke test: send from desktop with *Direct (P2P)*, scan the QR code with a phone on 4G, download.

## State as of 2026-10-14

- `https://filenymous.eu/app/` serves the single page (PRs #11 and #12): review step, optional password, pigeon progress, peer device, FR/EN legal footer. The previous multi-panel UI is still at `/app/#legacy`.
- UI deploys go through `scripts/deploy-ovh-sftp.mjs --dist ui/dist --remote /home/filenyb/www/app --merge` after `npm run build -- --base=/app/`. The `.ps1` / `.sh` OVH scripts are older alternatives.
- The signaling relay and coturn (TURN REST credentials via `/ice`) run on the VPS behind `www.opendpe.net/filenymous-signal/`. Setup is in `p2p-signal/README.md`.
- Archived: `docs/archive/` holds the deprecated v1 bridge, the Holochain-era design plans (`superpowers/`), the steward-node notes and the old standalone deploy script.

## Dropzone (100 % P2P) — relay settings

The Dropzone reuses `p2p-signal` (new message types `drop-join`, `drop-signal`, `drop-leave`); no file byte goes through the VPS. Optional environment variables:

- `DROP_MAX_TTL_MS` (default 30 days): upper bound for the expiry an owner can request.
- `DROP_DEFAULT_TTL_MS` (default 7 days): room TTL when the owner chose no expiry.
- `MAX_DROP_CONTRIBUTORS` (default 8): simultaneous contributors per Dropzone.
- `DROP_SWEEP_MS` (default 30 s): expiry sweep interval.

Relay tests: `cd p2p-signal && npm ci && npm test`. Restart `filenymous-signal.service` after deploying the new `server.js`.

## Sharewall (live sharing wall) — relay and nginx

Sharewall reuses `p2p-signal` on a dedicated WebSocket path, `wss://www.opendpe.net/filenymous-signal/wall` (new message types `wall-join`, `wall-signal`, `wall-close`, `wall-leave`). No content goes through the VPS: the relay only introduces each participant to the host's tab, never participants to each other, and never receives the key (it lives in the link fragment). **A relay redeploy is required.** Full design: [SHAREWALL.md](SHAREWALL.md). Sharewall v2 (chat, reactions, polls, live media, AI agents) adds no relay change: its protocol runs inside the sealed DataChannel, so the order below is unchanged. CLI 0.4.2 (`filenymous wall …`, shared notes; 0.4.0 can't join no-expiry walls) is published to npm separately, after merge.

Optional environment variables: `WALL_MAX_TTL_MS` (24 h + 60 s; cap for legacy walls whose link carries an expiry — new walls have none and close when their host leaves), `WALL_ORPHAN_MS` (1 h: a wall left without its host is closed anyway), `WALL_CLOSED_KEEP_MS` (7 days: a destroyed no-expiry wall id stays refused), `MAX_WALL_PEERS` (8), `WALL_HOST_GRACE_MS` (5000: delay before closing a "destroy on host leave" wall whose host disconnected), `WALL_SWEEP_MS` (15000). `/health` reports a `walls` count.

**No access log for walls.** The relay writes no per-connection line. Add to the opendpe.net `server` block (see `p2p-signal/nginx-opendpe-location.conf`):

```nginx
location = /filenymous-signal/wall {
    access_log off;
    error_log /var/log/nginx/filenymous-wall-error.log crit;
    proxy_pass http://127.0.0.1:8789;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;   # in-memory rate limit only, never logged
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
```

Order: (1) deploy `p2p-signal/server.js` with the openDPE relay workflow and restart `filenymous-signal`; (2) add the nginx block, `nginx -t && systemctl reload nginx`, open a wall and check `grep -c 'filenymous-signal/wall' /var/log/nginx/access.log` stays `0`; (3) only then deploy the UI (`deploy-ovh-ui.yml`), which also uploads the `.htaccess` with `/wall` and `/wall/new` → `https://filenymous.eu/app/#wall-new`, and run `ovh-htaccess.yml` in `verify` mode. The UI says the relay keeps no access log for walls: that is only true after step 2.

Tests: `cd p2p-signal && npm test` (includes `wall.test.mjs`).

## Secrets Vault (burn-after-reading) — VPS deployment

The Vault API is served by the same `p2p-signal` process (`vault.js`), under the existing nginx location: `https://www.opendpe.net/filenymous-signal/api/v1/secrets`. The static site on OVH calls it directly (CORS limited to `ALLOWED_ORIGIN`). Browsers encrypt with AES-256-GCM before upload; the key only lives in the link fragment (`#s:<id>/<key>`). The server stores ciphertext + `sha256(auth token)` only.

Endpoints:

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/secrets` | `{ v:1, ct, iv, salt?, pw, auth, ttl, reads }` → `201 { id, expiresAt }`. `reads`: `1` = burn after reading (default), `0` = readable until `ttl` (60 s to 7 days). |
| `GET` | `/api/v1/secrets/:id/meta` | Non-consuming: `{ pw, salt?, reads, expiresAt }` or `404`. Lets the page show "Afficher le secret" first (link previewers don't burn it). |
| `POST` | `/api/v1/secrets/:id/reveal` | `{ token }` → `{ ct, iv, burned }`; `403` wrong token/password (not burned); `404` gone. Atomic read-and-delete (Lua script on Redis). |

Every response carries `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, HSTS and `Cache-Control: no-store`.

### Steps on the VPS

1. Install Redis bound to localhost, without persistence:
   ```bash
   sudo apt install redis-server
   # /etc/redis/redis.conf
   #   bind 127.0.0.1 ::1
   #   protected-mode yes
   #   save ""
   #   appendonly no
   #   maxmemory 256mb
   #   maxmemory-policy noeviction
   sudo systemctl enable --now redis-server
   ```
2. Deploy the new `p2p-signal` files (`server.js`, `vault.js`, `package.json`, `package-lock.json`) to `/opt/filenymous-signal/app` and run `npm ci --omit=dev` there (adds the `redis` client).
3. Add to `/etc/filenymous-signal.env`:
   ```
   REDIS_URL=redis://127.0.0.1:6379
   ```
   Without `REDIS_URL` the relay falls back to an in-memory store (secrets lost on restart, single process only). That is fine for tests, not for production.
4. `sudo systemctl restart filenymous-signal` then check:
   `curl -si -X POST https://www.opendpe.net/filenymous-signal/api/v1/secrets -H 'content-type: application/json' -d '{}'` → `400 invalid-secret` with the security headers.
5. nginx: no change needed (the `/filenymous-signal/` location already proxies HTTP). Optionally add `client_max_body_size 128k;` in that location.

Optional tuning (env): `VAULT_MAX_TTL_S` (7 days), `VAULT_DEFAULT_TTL_S` (24 h), `VAULT_MAX_CT_CHARS` (90 000 ≈ 64 KiB plaintext), `VAULT_MAX_BODY_BYTES` (100 000), `VAULT_CREATE_PER_MIN` (20 per IP), `VAULT_READ_PER_MIN` (60 per IP), `VAULT_MAX_MEMORY_SECRETS` (in-memory fallback cap). Per-IP limits need `TRUST_PROXY=1` behind nginx (already set in the unit file).

## Canal de signalement (whistleblowing) — VPS deployment

Served by the same `p2p-signal` process (`reports.js`) under `https://www.opendpe.net/filenymous-signal/api/v1/reports`, with the same Redis (`REDIS_URL`) as the Vault. **A relay redeploy is required** (new module). Browsers seal reports to the organisation's ECDH P-256 public key; the server only stores ciphertext, `sha256` of the admin and follow-up tokens, a status and hour-rounded timestamps.

| Method | Path | Body → response |
|---|---|---|
| `POST` | `/api/v1/reports/mailboxes` | `{ v:1, pub, admin }` (raw P-256 key b64url, sha256 hex of the admin token) → `201 { id }` |
| `GET` | `/api/v1/reports/mailboxes/:id` | `{ pub }` (the reporter page checks it equals the key in the link) |
| `POST` | `/api/v1/reports/mailboxes/:id/reports` | `{ v:1, id, auth, sealed:{epk,iv,ct} }` → `201`; `409` if the id exists |
| `POST` | `/api/v1/reports/mailboxes/:id/{list,open,reply,status}` | `{ token, id?, msg?, status? }` (admin token in the body, never in the URL); `403` wrong token |
| `POST` | `/api/v1/reports/r/:id/{thread,followup}` | `{ token, sealed? }` (follow-up token); `403` for unknown id **and** wrong token |

Redis keys: `rmbox:<id>` (365 days, refreshed when the org opens its inbox), `rmbox:<id>:reports`, `rrep:<id>` and `rrep:<id>:thread` (`REPORT_TTL_S`, 90 days).

Tuning (env): `REPORT_TTL_S` (7 776 000), `REPORT_MAILBOX_TTL_S`, `REPORT_MAX_BODY_BYTES` (12 MiB; attachments are capped at 8 MiB in the browser), `REPORT_MAX_MSG_BYTES` (200 000), `REPORT_MAX_PER_MAILBOX` (500), `REPORT_MAX_THREAD` (200), `REPORT_CREATE_PER_MIN` (10), `REPORT_SUBMIT_PER_MIN` (6), `REPORT_READ_PER_MIN` (60), `REPORT_SUBMIT_PER_MAILBOX_HOUR` (60), `REPORT_RATE_KEY_ROTATE_MS` (10 min).

**No IP logging.** The application never stores or logs IPs, User-Agents or Referers for these endpoints: rate-limit buckets are `HMAC(in-memory key rotated every 10 min, ip)` kept one minute in RAM, and error lines carry no request data. nginx must not log them either. Add this block **inside the server, before** the generic `/filenymous-signal/` location (see `p2p-signal/nginx-opendpe-location.conf`):

```nginx
location /filenymous-signal/api/v1/reports/ {
    access_log off;
    error_log /var/log/nginx/filenymous-reports-error.log crit;  # crit only: no per-request client lines
    client_max_body_size 13m;
    proxy_pass http://127.0.0.1:8789;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;   # used only for the in-memory HMAC rate limit
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_request_buffering on;
}
```

Then `nginx -t && systemctl reload nginx`, and check that a request to `/filenymous-signal/api/v1/reports/mailboxes/xxx` adds no line to `/var/log/nginx/access.log`. Also make sure no upstream proxy/CDN in front of the VPS logs that path. Redis persistence (RDB/AOF) only contains ciphertext and token hashes.

Smoke test: `curl -si https://www.opendpe.net/filenymous-signal/api/v1/reports/mailboxes/AAAAAAAAAAAAAAAAAAAAAA` → `404 {"error":"gone"}` with the security headers.

Tests: `cd p2p-signal && npm test` (includes `reports.test.mjs`: API, limits, TTL, no IP stored or logged).

### Static site (OVH)

The reveal page adds a restrictive `<meta>` CSP at runtime (`object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'self' <vault API>`) and `referrer=no-referrer`. `frame-ancestors` cannot be set from a meta tag: to forbid framing, add to the OVH `.htaccess` (merge with any existing rules, do not overwrite):
```
Header always set X-Frame-Options "DENY"
Header always set Referrer-Policy "no-referrer"
Header always set X-Content-Type-Options "nosniff"
```
The front-end uses `VITE_VAULT_URL` if set at build time, otherwise the signal relay's HTTP base.

Tests: `cd p2p-signal && npm ci && npm test` (relay + vault, in-memory and, if `redis-server` is installed, Redis).
