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
- `ALLOWED_ORIGIN=https://filenymous.eu,https://geoking2104.github.io` (exact origins).
- **Known failure mode (happened 2026-07-07):** replacing/regenerating the opendpe.net
  vhost drops the `include snippets/filenymous-signal-location.conf;` lines → the relay
  returns 404 and every cross-device QR/code fails with "Unable to reach the P2P
  signaling server". After ANY change to the opendpe.net vhost, re-check:
  `curl -si https://www.opendpe.net/filenymous-signal/ | head -2` → expected **426**, not 404.
- Never leave `*.bak` files inside `/etc/nginx/sites-enabled/` (nginx loads them as
  vhosts); backups live in `/etc/nginx/vhost-backups/`.
- SSH access: key `opendpe_vps_ed25519` (user `root`) — works from Linux; Windows
  OpenSSH may fail silently on this key (ACL), use the sandbox/WSL if needed.
