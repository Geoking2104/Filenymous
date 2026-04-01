# Contribuer à Filenymous

## Pré-requis

### 1. Nix (recommandé)

```bash
# macOS / Linux
sh <(curl -L https://nixos.org/nix/install) --daemon

# Activer les flakes (optionnel mais recommandé)
echo 'experimental-features = nix-command flakes' >> ~/.config/nix/nix.conf
```

### 2. Sans Nix (manuel)

```bash
# Rust + cible WASM
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
rustup component add rustfmt clippy

# Holochain CLI
cargo install holochain --locked
cargo install hc --locked

# Node.js 20+
node --version   # >= 20
```

## Variables d'environnement

### Bridge (`bridge/.env`)

```bash
cd bridge
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `BRIDGE_SECRET` | Secret HMAC partagé avec le conducteur (≥ 32 chars en prod) |
| `SENDGRID_API_KEY` | Clé API SendGrid (laisser vide → Ethereal en dev) |
| `FROM_EMAIL` | Adresse expéditeur |
| `TWILIO_ACCOUNT_SID` | SID Twilio (laisser vide → console.warn en dev) |
| `TWILIO_AUTH_TOKEN` | Token Twilio |
| `TWILIO_FROM` | Numéro Twilio (+E.164) |

### UI (`ui/.env`)

```bash
cd ui
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `VITE_HC_URL` | WebSocket du conducteur Holochain (`ws://localhost:8888`) |
| `VITE_BRIDGE_URL` | URL du bridge (`http://localhost:3001`) |
| `VITE_BRIDGE_SECRET` | Même secret que `BRIDGE_SECRET` dans bridge/.env |

## Workflow de développement

```bash
# Terminal 1 — compilation Rust + shell Nix (M5: flake.nix)
nix develop          # installe holochain, hc, lair-keystore, cargo, node
make build-happ

# Terminal 2 — infrastructure réseau locale (bootstrap + signal + bridge)
make infra-up        # docker compose --profile dev up -d
# ou manuellement :  cd bridge && npm run dev

# Terminal 3 — conducteur Holochain (pointe vers infra locale)
holochain -c conductor-config.dev.yaml

# Terminal 4 — UI
cd ui && npm run dev
```

### Nix flake (M5)

Le fichier `flake.nix` remplace `shell.nix` et pin les versions exactes de Holochain.

```bash
nix develop          # dev shell complet
nix develop --command make build-webhapp   # build CI-style
```

### Configuration conducteur (exemple minimal)

Créer `conductor-config.yaml` à la racine :

```yaml
---
environment_path: ./conductor-data
keystore:
  type: lair_server_in_proc
admin_interfaces:
  - driver:
      type: websocket
      port: 9000
```

Puis installer la hApp :

```bash
hc app install --app-id filenymous filenymous.happ
# Ouvrir un port WebSocket app
hc admin add-agent-info
```

> **M4 — voie recommandée** : utiliser le [Holochain Launcher](https://github.com/holochain/launcher) avec le `.webhapp`.
>
> ```bash
> make build-webhapp   # → workdir/filenymous.webhapp
> # Puis dans le Launcher : File → Install hApp from filesystem
> ```

## Tests

```bash
# Tryorama (intégration DNA)
make tests

# Ou directement
cd tests && npm install && npm test -- --reporter=verbose
```

## Linting & typage

```bash
# Rust
cargo fmt --all
cargo clippy --all-targets

# Bridge
cd bridge && npx tsc --noEmit

# UI
cd ui && npx tsc --noEmit
```

## Conventions de commit

Format : `type(scope): message`

| Type | Usage |
|------|-------|
| `feat` | Nouvelle fonctionnalité |
| `fix` | Correction de bug |
| `zome` | Changement DNA/zome |
| `ui` | Changement interface |
| `bridge` | Changement bridge |
| `infra` | Bootstrap / signal / docker-compose |
| `ci` | Workflow GitHub Actions |
| `docs` | Documentation |

Exemple : `feat(storage): add chunk TTL enforcement on DHT`

## Release

```bash
git tag v0.3.0
git push origin v0.3.0
# → GitHub Actions release.yml se déclenche automatiquement
# → Release créée avec filenymous.happ + UI build
```
