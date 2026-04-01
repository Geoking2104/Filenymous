# Infrastructure réseau Filenymous (M5)

Le réseau Holochain nécessite deux services d'infrastructure pour fonctionner sur internet :

| Service | Rôle | Port |
|---------|------|------|
| **Bootstrap** (`kitsune2-bootstrap-srv`) | Registre de pairs — les agents publient leur adresse réseau pour être découverts | 8787 |
| **Signal / SBD** (`kitsune2-sbd-server`) | Relay WebRTC — permet aux pairs derrière NAT de s'atteindre | 8788 |

## Déploiement rapide (VPS / fly.io)

```bash
# Depuis la racine du projet
docker compose -f docker-compose.yml up -d bootstrap signal
```

Ensuite pointer le conducteur vers ces services dans `conductor-config.prod.yaml`.

## TLS (obligatoire en production)

Les deux services doivent être servis en HTTPS/WSS pour les navigateurs.
Option recommandée : **Caddy** comme reverse proxy avec Let's Encrypt automatique.

```
bootstrap.filenymous.app → 127.0.0.1:8787
signal.filenymous.app    → 127.0.0.1:8788 (WebSocket upgrade)
```

Exemple `Caddyfile` :

```
bootstrap.filenymous.app {
    reverse_proxy localhost:8787
}

signal.filenymous.app {
    reverse_proxy localhost:8788 {
        header_up Connection {>Connection}
        header_up Upgrade {>Upgrade}
    }
}
```

## Hébergement sur fly.io

```bash
# Bootstrap
cd network/bootstrap
fly launch --name filenymous-bootstrap --region cdg
fly deploy

# Signal
cd ../signal
fly launch --name filenymous-signal --region cdg
fly deploy
```
