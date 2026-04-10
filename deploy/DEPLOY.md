# Filenymous — Production Deployment Guide

## Architecture overview

```
Users (browsers)
    │
    ├─── HTTPS/WSS ──► bootstrap.filenymous.eu:443   (kitsune2, your VPS)
    │                   ├─ Peer discovery (Bootstrap REST)
    │                   └─ WebRTC signaling (SBD relay)
    │
    └─── HTTPS ──────► geoking2104.github.io/Filenymous  (demo UI, GitHub Pages)
                        └─ Static HTML/JS — no server needed
```

P2P transfers happen **directly between users** — your server only handles discovery.

---

## Step 1 — Domain

You need a domain pointing to your server. Recommended: **Cloudflare Registrar** (cheapest renewal fees, free DNS management).

1. Go to [cloudflare.com/products/registrar](https://www.cloudflare.com/products/registrar/)
2. Search and register `filenymous.eu` (or any domain you own)
3. After server setup (Step 2), add a DNS A record:
   - **Name**: `bootstrap`
   - **Type**: `A`
   - **Value**: `<your server IP>`
   - **Proxy**: OFF (grey cloud — direct DNS, not proxied)

---

## Step 2 — Server

**Recommended: Hetzner CX22** — €3.79/month, ARM64, 2 vCPU, 4GB RAM, 40GB SSD, EU datacenter.

1. Create account at [hetzner.com/cloud](https://www.hetzner.com/cloud)
2. New Project → **Add Server**:
   - **Location**: Nuremberg or Falkenstein (EU)
   - **Image**: Ubuntu 22.04
   - **Type**: CX22 (Shared, ARM64)
   - **SSH key**: paste your public key (`cat ~/.ssh/id_rsa.pub`)
   - **Firewall**: allow ports 22 (SSH), 80 (certbot), 443 (kitsune2)
3. Note the server IP once created

---

## Step 3 — DNS record

In Cloudflare (or your registrar's DNS panel), add:

| Type | Name      | Value           | TTL  |
|------|-----------|-----------------|------|
| A    | bootstrap | `<server IP>`   | Auto |

Wait 5 minutes for propagation, then verify:
```bash
ping bootstrap.filenymous.eu
```

---

## Step 4 — Server setup (one command)

SSH into your server and run:

```bash
ssh root@<server-ip>
curl -fsSL https://raw.githubusercontent.com/Geoking2104/Filenymous/main/deploy/setup.sh | bash
```

This automatically:
- Installs Docker
- Gets a free TLS certificate (Let's Encrypt)
- Starts the kitsune2 container
- Sets up daily auto-renewal

**Check it's running:**
```bash
docker logs -f filenymous-kitsune2
curl https://bootstrap.filenymous.eu/health
```

---

## Step 5 — Publish the hApp release

From your local machine, in the `filenymous/` folder:

```powershell
cd "C:\Users\geoff\Documents\Claude\Projects\Filenymous\filenymous"
git tag v0.1.0
git push --tags
```

GitHub Actions (`release.yml`) will automatically:
1. Build `filenymous.happ` and `filenymous.webhapp`
2. Publish them to [github.com/Geoking2104/Filenymous/releases](https://github.com/Geoking2104/Filenymous/releases)

---

## Step 6 — Install as a user

1. Download [Holochain Launcher](https://github.com/holochain/launcher/releases) (Windows/Mac/Linux)
2. Open Launcher → **Install hApp from filesystem**
3. Select `filenymous.webhapp` from the GitHub Release
4. The app opens in the Launcher's built-in browser

---

## Ongoing maintenance

| Task | Command |
|------|---------|
| View server logs | `docker logs -f filenymous-kitsune2` |
| Restart server | `docker restart filenymous-kitsune2` |
| Update server image | Automatic via Watchtower (hourly check) |
| Renew TLS cert | Automatic via cron (daily at 3am) |
| Publish new version | `git tag v0.2.0 && git push --tags` |

---

## Cost summary

| Item | Provider | Cost |
|------|----------|------|
| Server (CX22) | Hetzner | €3.79/month |
| Domain | Cloudflare | ~€8/year |
| TLS certificate | Let's Encrypt | Free |
| UI hosting | GitHub Pages | Free |
| CI/CD | GitHub Actions | Free |
| **Total** | | **~€4/month** |
