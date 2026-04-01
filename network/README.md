# Filenymous — Infrastructure réseau (M5)

## Architecture

```
VPS / fly.io  (une seule IP)
│
├── bootstrap.filenymous.app:443  ← kitsune2-bootstrap-srv (TLS interne rustls)
│     • HTTPS   → découverte de pairs (bootstrap REST)
│     • WSS     → signaling WebRTC (SBD relay)
│     Même binaire, même port, même hôte.
│
└── bridge.filenymous.app:443     ← Caddy → bridge:3001 (Fastify)
      • HTTPS   → notifications OTP / email / SMS
```

### Principe clé

`kitsune2-bootstrap-srv` compilé avec `--features sbd` est un **binaire unique** qui gère :
- La découverte de pairs (bootstrap) via HTTP/HTTPS REST
- Le relay WebRTC (SBD signal) via WS/WSS

Il gère son propre TLS en interne (rustls). **Ne pas le mettre derrière Caddy ou nginx.**

Caddy est uniquement utilisé pour le service `bridge`.

---

## Prérequis serveur

- VPS Ubuntu 22.04+ avec accès root
- Docker + Docker Compose v2
- Deux sous-domaines DNS pointant vers la même IP :
  - `bootstrap.filenymous.app` → port 443 (kitsune2)
  - `bridge.filenymous.app` → port 443 (Caddy → bridge)
- Un certificat TLS pour `bootstrap.filenymous.app` (Let's Encrypt / certbot standalone)

---

## Obtenir les certificats TLS

kitsune2 gère son TLS en interne mais a besoin de fichiers PEM :

```bash
# Installer certbot
apt install certbot

# Obtenir le cert (port 80 libre)
certbot certonly --standalone -d bootstrap.filenymous.app

# Copier vers le volume Docker
mkdir -p /opt/filenymous/kitsune2-certs
cp /etc/letsencrypt/live/bootstrap.filenymous.app/fullchain.pem \
   /opt/filenymous/kitsune2-certs/cert.pem
cp /etc/letsencrypt/live/bootstrap.filenymous.app/privkey.pem \
   /opt/filenymous/kitsune2-certs/key.pem
chmod 600 /opt/filenymous/kitsune2-certs/*.pem
```

---

## Démarrage production

```bash
cd /opt/filenymous
git clone https://github.com/filenymous/filenymous.git .

# Variables d'environnement bridge
cp .env.compose.example .env.compose
# Éditer : BRIDGE_SECRET, SENDGRID_API_KEY, TWILIO_*

# Lancer
docker compose --profile prod up -d

# Vérifier
docker compose ps
docker compose logs kitsune2 --tail=50
docker compose logs bridge   --tail=50
docker compose logs caddy    --tail=50
```

---

## Démarrage dev (local, sans TLS)

```bash
# Lance kitsune2 sur http://localhost:8787 (bootstrap + signal)
# Lance bridge sur http://localhost:3001
make infra-up

curl http://localhost:8787/health
curl http://localhost:3001/health
```

---

## Configuration du conducteur Holochain

### Dev
```yaml
network:
  bootstrap_service: "http://localhost:8787"
  signal_url:        "ws://localhost:8787"
  transport_pool:
    - type: webrtc
      signal_url: "ws://localhost:8787"
```

### Production
```yaml
network:
  bootstrap_service: "https://bootstrap.filenymous.app"
  signal_url:        "wss://bootstrap.filenymous.app"
  transport_pool:
    - type: webrtc
      signal_url: "wss://bootstrap.filenymous.app"
      ice_servers_override:
        - urls:
            - "stun:stun.l.google.com:19302"
            - "stun:stun1.l.google.com:19302"
```

Bootstrap et signal utilisent le **même hôte et le même port (443)**. kitsune2 route les requêtes HTTP vers le handler bootstrap et les WebSocket vers le handler SBD.

---

## Renouvellement automatique des certificats

```bash
# /etc/letsencrypt/renewal-hooks/deploy/filenymous.sh
#!/bin/bash
cp /etc/letsencrypt/live/bootstrap.filenymous.app/fullchain.pem \
   /opt/filenymous/kitsune2-certs/cert.pem
cp /etc/letsencrypt/live/bootstrap.filenymous.app/privkey.pem \
   /opt/filenymous/kitsune2-certs/key.pem
docker compose -f /opt/filenymous/docker-compose.yml restart kitsune2
```

```bash
chmod +x /etc/letsencrypt/renewal-hooks/deploy/filenymous.sh
```

---

## Images Docker (GHCR)

```
ghcr.io/filenymous/filenymous-kitsune2:latest   # bootstrap + signal (rustls TLS)
ghcr.io/filenymous/filenymous-bridge:latest      # Fastify OTP/email/SMS
```

Publiées automatiquement à chaque push sur `main` via `.github/workflows/docker.yml`.
