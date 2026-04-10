#!/usr/bin/env bash
# =============================================================================
# Filenymous — Production server setup
# Tested on: Ubuntu 22.04 LTS (Hetzner CX22 or equivalent)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Geoking2104/Filenymous/main/deploy/setup.sh | bash
#
# What this script does:
#   1. Installs Docker + Docker Compose
#   2. Installs certbot (Let's Encrypt)
#   3. Obtains a TLS certificate for bootstrap.filenymous.eu
#   4. Pulls and starts the kitsune2 container
#   5. Sets up auto-renewal for TLS certs
# =============================================================================
set -euo pipefail

DOMAIN="bootstrap.filenymous.eu"
EMAIL="geoffroydelatournelle@gmail.com"   # change if needed
REPO="https://raw.githubusercontent.com/Geoking2104/Filenymous/main/deploy"

echo "=== Filenymous production setup ==="
echo "Domain : $DOMAIN"
echo ""

# ── 1. System update ──────────────────────────────────────────────────────────
apt-get update -y && apt-get upgrade -y

# ── 2. Docker ─────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "[1/5] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "[1/5] Docker already installed — skipping"
fi

# ── 3. Certbot ────────────────────────────────────────────────────────────────
echo "[2/5] Installing certbot..."
apt-get install -y certbot

# ── 4. TLS certificate ────────────────────────────────────────────────────────
echo "[3/5] Obtaining TLS certificate for $DOMAIN..."
echo "      → Port 80 must be reachable from the internet (firewall rule required)"

if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN"
else
  echo "      Certificate already exists — skipping"
fi

# Auto-renewal cron
echo "[3/5] Setting up auto-renewal..."
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && docker restart filenymous-kitsune2") | crontab -

# ── 5. Docker Compose ─────────────────────────────────────────────────────────
echo "[4/5] Downloading docker-compose.yml..."
mkdir -p /opt/filenymous
curl -fsSL "$REPO/docker-compose.yml" -o /opt/filenymous/docker-compose.yml

echo "[5/5] Pulling image and starting kitsune2..."
cd /opt/filenymous
docker compose pull
docker compose up -d

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setup complete ==="
echo ""
echo "  Bootstrap server : https://$DOMAIN"
echo "  WebRTC signal    : wss://$DOMAIN"
echo ""
echo "  Check status : docker compose -f /opt/filenymous/docker-compose.yml ps"
echo "  View logs    : docker logs -f filenymous-kitsune2"
echo ""
echo "  Next steps:"
echo "  1. Point DNS A record: $DOMAIN → $(curl -s ifconfig.me)"
echo "  2. Tag a release: git tag v0.1.0 && git push --tags"
echo "  3. Download .webhapp from GitHub Releases and install in Holochain Launcher"
