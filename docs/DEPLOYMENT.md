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

- The site is the **standalone single-file app**: `docs/demo/index.html` from the repo,
  uploaded as `www/index.html`. Nothing else is required.
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
