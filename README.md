# ⟁ Filenymous

> Transfert de fichiers P2P chiffré de bout en bout — sans serveur central, sans compte, sans traçage.

[![CI](https://github.com/filenymous/filenymous/actions/workflows/build.yml/badge.svg)](https://github.com/filenymous/filenymous/actions/workflows/build.yml)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Navigateur expéditeur          Navigateur destinataire      │
│  ┌─────────────────────┐        ┌─────────────────────────┐  │
│  │  React UI (Vite)    │        │  React UI (Vite)        │  │
│  │  WebCrypto AES-256  │        │  WebCrypto AES-256      │  │
│  └────────┬────────────┘        └──────────┬──────────────┘  │
│           │ WebSocket                       │ WebSocket       │
└───────────┼─────────────────────────────────┼────────────────┘
            │                                 │
    ┌───────▼──────────────────────────────────▼───────┐
    │             Holochain Conductor                   │
    │   DNA filenymous — 3 zomes (identity/transfer/   │
    │   storage) — DHT P2P — aucun serveur maître      │
    └────────────────────────┬─────────────────────────┘
                             │ HTTP + HMAC-SHA256
                    ┌────────▼────────┐
                    │  Bridge (3001)  │
                    │  Fastify        │
                    │  OTP · Email    │
                    │  SMS (Twilio)   │
                    └─────────────────┘
```

## Pré-requis

| Outil | Version |
|-------|---------|
| Nix | ≥ 2.18 (multi-user) |
| Node | ≥ 20 LTS |
| Rust | via Nix (nightly ciblé WASM) |

## Démarrage rapide

```bash
# 1. Cloner
git clone https://github.com/filenymous/filenymous.git
cd filenymous

# 2. Entrer dans le shell Nix (installe Holochain + Rust automatiquement)
nix develop

# 3. Compiler les zomes + DNA + hApp
make build-happ

# 4. Lancer le bridge (autre terminal)
cd bridge
cp .env.example .env   # renseigner les clés API
npm install && npm run dev

# 5. Lancer l'UI (autre terminal)
cd ui
cp .env.example .env
npm install && npm run dev
# → http://localhost:5173
```

## Structure du projet

```
filenymous/
├── dnas/filenymous/          # DNA manifest + zome manifests
├── zomes/
│   ├── integrity/
│   │   ├── identity_integrity/   # ContactClaim (hash email/tel → AgentPubKey)
│   │   ├── transfer_integrity/   # TransferManifest + statuts
│   │   └── storage_integrity/    # FileChunk + ChunkManifest
│   └── coordinator/
│       ├── identity/             # claim_contact, get_agent_for_contact
│       ├── transfer/             # create/get/revoke/expire transfers
│       └── storage/              # store_chunk, finalize, get_chunks, delete
├── tests/                    # tryorama integration tests (Node + TypeScript)
├── ui/                       # React 18 + Vite + @holochain/client
│   └── src/
│       ├── crypto/           # WebCrypto: AES-256-GCM, chunker, contact hash
│       ├── holochain/        # zome call wrappers + types
│       ├── store/            # Zustand
│       └── components/       # Send / Receive / History / Identity / Privacy
├── bridge/                   # Fastify micro-service: OTP · Email · SMS
│   └── src/
│       ├── auth.ts           # HMAC-SHA256 verification
│       ├── otp.ts            # TOTP in-memory (single-use, 10 min TTL)
│       └── notify.ts         # SendGrid + Twilio
├── .github/workflows/
│   ├── build.yml             # CI : fmt · clippy · WASM · tryorama · tsc · vite
│   └── release.yml           # CD : tag → GitHub Release avec artefacts
├── Cargo.toml                # Workspace Rust
├── Makefile                  # build-wasm | build-dna | build-happ | tests
└── happ.yaml                 # hApp manifest
```

## Flux de transfert

1. **Bob** → `identity::claim_contact(sha256("bob@example.com"))` — publie son ContactClaim sur le DHT
2. **Alice** → `identity::get_agent_for_contact(...)` — résout la clé publique de Bob
3. **Alice** génère une clé AES-256 dans le navigateur (WebCrypto)
4. **Alice** → `transfer::create_transfer(...)` — crée le TransferManifest
5. **Alice** → `storage::store_chunk(...)` × N — publie chaque chunk chiffré
6. **Alice** → bridge `/notify/email` — envoie le lien de téléchargement à Bob
7. **Bob** ouvre le lien, déchiffre les chunks localement
8. **Bob** → `transfer::record_download(...)` — met à jour le statut

## Sécurité

- **Chiffrement E2E** : AES-256-GCM dans le navigateur. Ni le bridge ni les nœuds ne voient les données en clair.
- **Contacts pseudonymisés** : seul le SHA-256(email|téléphone) est publié sur le DHT.
- **Bridge authentifié** : chaque requête est signée par HMAC-SHA256 (partagé entre conducteur et bridge).
- **Expiration cryptographique** : la `DeleteAction` Holochain force les nœuds à effacer les chunks.

## Roadmap

| Milestone | Status |
|-----------|--------|
| M1 — DNA Holochain (6 zomes) + tryorama | ✅ |
| M2 — React UI + bridge notifications | ✅ |
| M3 — ECIES/X25519 wrapping de la clé AES | 🔜 |
| M4 — Launcher Holochain + packaging desktop | 🔜 |
| M5 — Réseau public + nœuds bootstrap | 🔜 |

## Licence

MIT — voir [LICENSE](LICENSE).
