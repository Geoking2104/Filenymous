# Filenymous — M1 (DNA fonctionnelle)

Transfert de fichiers P2P sur Holochain. Pas de serveur central, pas de base de données.

## Prérequis

```bash
# 1. Rust + target WASM
rustup target add wasm32-unknown-unknown

# 2. Holochain CLI (via holonix ou cargo)
cargo install holochain_cli

# 3. Node.js 20+ pour les tests tryorama
node --version  # >= 20
```

## Build complet

```bash
make all          # compile WASM → pack DNA → pack hApp
```

## Tests

```bash
make tests        # build + run integration tests tryorama
```

Tests individuels :
```bash
cd tests
npm install
npm test -- --reporter=verbose
```

## Structure du projet

```
filenymous/
├── Cargo.toml                     # Workspace Rust
├── happ.yaml                      # Manifest hApp
├── dnas/filenymous/
│   ├── dna.yaml                   # Manifest DNA
│   └── zomes/
│       ├── integrity/
│       │   ├── identity_integrity/  # ContactClaim entries + validation
│       │   ├── transfer_integrity/  # TransferManifest + StatusUpdate + validation
│       │   └── storage_integrity/   # FileChunk + ChunkManifest + validation
│       └── coordinator/
│           ├── identity/            # claim_contact, get_agent_for_contact, revoke
│           ├── transfer/            # create_transfer, get_transfer, revoke, record_download
│           └── storage/             # store_chunk, finalize_storage, get_chunks, delete_chunks
├── tests/
│   ├── package.json
│   ├── vitest.config.ts
│   └── src/filenymous.test.ts      # Tests tryorama (4 scénarios, 2 agents)
└── workdir/                        # Artefacts compilés (.dna, .happ) — gitignored
```

## Flux de transfert (résumé)

1. **Bob** appelle `identity::claim_contact(sha256("bob@example.com"))` → publie son ContactClaim sur le DHT
2. **Alice** appelle `identity::get_agent_for_contact(sha256("bob@example.com"))` → obtient la clé publique de Bob
3. **Alice** chiffre la clé AES avec la clé publique de Bob (ECIES/X25519 — côté UI)
4. **Alice** appelle `transfer::create_transfer(...)` → crée le TransferManifest sur le DHT
5. **Alice** appelle `storage::store_chunk(...)` × N → publie chaque chunk chiffré
6. **Alice** appelle `storage::finalize_storage(...)` → publie le ChunkManifest
7. **Bob** appelle `transfer::get_transfer(transfer_id)` → lit le manifest
8. **Bob** appelle `storage::get_chunks(transfer_id)` → récupère les chunks ordonnés
9. **Bob** déchiffre les chunks localement (WebCrypto dans le navigateur)
10. **Bob** appelle `transfer::record_download(...)` → met à jour le statut

## Prochaines étapes (M2)

- `notification_zome` + bridge email/SMS (FastAPI ou Node.js)
- Frontend React (`@holochain/client` WebSocket)
- Chiffrement AES-256-GCM réel (WebCrypto API) côté UI
- OTP pour la vérification des ContactClaims
