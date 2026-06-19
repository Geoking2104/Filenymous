# Filenymous — build commands v3
# Architecture : Holochain Kangaroo (Tauri desktop) + Holo Host (web fallback)
#
# Pré-requis :
#   - Rust + wasm32-unknown-unknown target
#   - hc CLI  (cargo install holochain_cli)
#   - npm ≥ 9
#   - Tauri CLI v1  (cargo install tauri-cli --version "^1")
#   - @tauri-apps/cli in src-tauri/..  (npm install in root or ui/)
#
# Cibles principales :
#   make all            → build-webhapp complet
#   make build-wasm     → compile les zomes Rust en WASM
#   make build-dna      → pack le DNA
#   make build-happ     → pack le hApp
#   make build-ui       → build l'UI React
#   make build-webhapp  → bundle .webhapp pour Holo Host
#   make pouch          → copie happ + ui.zip dans pouch/ (ressources Kangaroo)
#   make kangaroo       → build le desktop app Tauri (natif courant)
#   make kangaroo-dev   → lance Tauri en mode dev (hot-reload)
#   make release        → build cross-platform via cargo-tauri (CI only)
#   make tests          → tests d'intégration Tryorama
#   make check          → type-check Rust + TypeScript (rapide, sans WASM)
#   make clean          → supprime tous les artefacts compilés

WASM_TARGET  := wasm32-unknown-unknown
DNA_PATH     := dnas/filenymous
WORKDIR      := workdir
UI_DIR       := ui
UI_DIST      := $(UI_DIR)/dist
EXTERN_DIR   := $(DNA_PATH)/zomes/extern
POUCH_DIR    := pouch
TAURI_DIR    := src-tauri
WASM_RELEASE := target/$(WASM_TARGET)/release
WASM_DEPS    := $(WASM_RELEASE)/deps

# ── Variables d'environnement UI ──────────────────────────────────────────────
# Surchargeables sur la ligne de commande :
#   make build-ui VITE_HC_URL=ws://localhost:8888
VITE_HC_URL         ?= ws://localhost:8888
VITE_WEB_BRIDGE_URL ?= https://filenymous.holo.host/web-bridge
VITE_APP_ID         ?= filenymous

.PHONY: all build-external-zomes copy-external-zomes build-wasm build-dna build-happ \
        build-ui build-webhapp pouch kangaroo kangaroo-dev release \
        tests check clean dev dev-ui upload-holo

all: build-webhapp

# ── 0. Zomes externes (holochain-open-dev + ddd-mtl) ─────────────────────────
# Les crates externes (file_storage, delivery) sont compilées via des stubs
# qui les incluent comme dépendances — cargo build les compile en WASM.
# Cette cible est incluse dans build-wasm ; run manuellement si besoin.
build-external-zomes:
	@echo "→ Compilation des zomes externes (file_storage + delivery)…"
	cargo build --release --target $(WASM_TARGET) \
		-p file_storage_stub \
		-p delivery_stub

copy-external-zomes:
	@echo "-> Copie des zomes externes sous les noms attendus par dna.yaml..."
	@src=$$(ls -t $(WASM_DEPS)/hc_zome_file_storage_integrity-*.wasm | head -n 1); test -n "$$src"; cp "$$src" $(WASM_RELEASE)/hc_zome_file_storage_integrity.wasm
	@src=$$(ls -t $(WASM_DEPS)/hc_zome_file_storage_coordinator-*.wasm | head -n 1); test -n "$$src"; cp "$$src" $(WASM_RELEASE)/hc_zome_file_storage_coordinator.wasm
	@src=$$(ls -t $(WASM_DEPS)/zome_delivery_integrity-*.wasm | head -n 1); test -n "$$src"; cp "$$src" $(WASM_RELEASE)/zome_delivery_integrity.wasm
	@src=$$(ls -t $(WASM_DEPS)/delivery-*.wasm | head -n 1); test -n "$$src"; cp "$$src" $(WASM_RELEASE)/delivery.wasm
	@echo "OK zomes externes copies dans $(WASM_RELEASE)"
	@echo "✅ Zomes externes compilées"

# ── 1. Compiler TOUS les zomes en WASM ───────────────────────────────────────
build-wasm: build-external-zomes
	@echo "→ Compilation de tous les zomes…"
	cargo build --release --target $(WASM_TARGET)
	$(MAKE) copy-external-zomes
	@echo "✅ Zomes compilées : target/wasm32-unknown-unknown/release/"

# ── 2. Pack du DNA ────────────────────────────────────────────────────────────
build-dna: build-wasm
	mkdir -p $(WORKDIR)
	hc dna pack $(DNA_PATH) -o $(WORKDIR)/filenymous.dna
	@echo "✅ DNA packagé : $(WORKDIR)/filenymous.dna"

# ── 3. Pack du hApp ───────────────────────────────────────────────────────────
build-happ: build-dna
	hc app pack . -o $(WORKDIR)/filenymous.happ
	@echo "✅ hApp prêt : $(WORKDIR)/filenymous.happ"

# ── 4. Build de l'UI (single-file HTML) ──────────────────────────────────────
# L'UI est filenymous-app.html — standalone, pas de build step.
# Holochain Launcher + Holo Host attendent index.html à la racine du zip.
HTML_SRC := filenymous-app.html

build-ui:
	@echo "→ Packaging UI single-file HTML → $(WORKDIR)/ui.zip…"
	mkdir -p $(WORKDIR)
	@if [ ! -f "$(HTML_SRC)" ]; then echo "❌ $(HTML_SRC) introuvable"; exit 1; fi
	cp $(HTML_SRC) /tmp/index.html
	cd /tmp && zip -j $(CURDIR)/$(WORKDIR)/ui.zip index.html
	rm -f /tmp/index.html
	@echo "✅ UI zip prête : $(WORKDIR)/ui.zip"

# ── 5. Pack du .webhapp (Holo Host) ──────────────────────────────────────────
# Le .webhapp combine filenymous.happ + ui.zip pour déploiement Holo Host.
# Pour le desktop : utiliser `make kangaroo` (voir ci-dessous).
build-webhapp: build-happ build-ui
	hc web-app pack . -o $(WORKDIR)/filenymous.webhapp
	@echo "✅ .webhapp prêt : $(WORKDIR)/filenymous.webhapp"
	@echo "   → Holo Host : make upload-holo"

# ── 5b. Pouch — ressources Kangaroo ──────────────────────────────────────────
# Kangaroo attend happ + ui.zip dans pouch/ pour les bundler dans le .app/.exe.
# Le répertoire pouch/ n'est pas versionné (gitignored).
pouch: build-happ build-ui
	@echo "→ Préparation du pouch Kangaroo…"
	mkdir -p $(POUCH_DIR)
	cp $(WORKDIR)/filenymous.happ $(POUCH_DIR)/filenymous.happ
	cp $(WORKDIR)/ui.zip          $(POUCH_DIR)/ui.zip
	@echo "✅ Pouch prêt : $(POUCH_DIR)/"

# ── 6a. Kangaroo desktop build (plateforme courante) ─────────────────────────
# Produit : src-tauri/target/release/bundle/{dmg|exe|AppImage}/
# Pré-requis : les binaires holochain + lair-keystore doivent être dans
#   src-tauri/binaries/holochain-<triple> et lair-keystore-<triple>
#   Télécharger via : scripts/download-binaries.sh
kangaroo: pouch
	@echo "→ Build Kangaroo (Tauri desktop)…"
	cd $(TAURI_DIR) && cargo tauri build
	@echo "✅ Installeur prêt dans $(TAURI_DIR)/target/release/bundle/"

# ── 6b. Kangaroo dev (hot-reload) ────────────────────────────────────────────
kangaroo-dev:
	@echo "→ Kangaroo dev (hot-reload Vite + Holochain local)…"
	cd $(TAURI_DIR) && cargo tauri dev

# ── 6c. Release cross-platform (CI GitHub Actions) ───────────────────────────
# Ne pas lancer en local : utilise les runners macOS/Windows/Linux de GitHub CI.
# Voir .github/workflows/release.yml
release:
	@echo "La cible 'release' est réservée au CI GitHub Actions."
	@echo "Poussez un tag git pour déclencher le workflow :"
	@echo "  git tag v0.1.0 && git push origin v0.1.0"
	@exit 1

# ── 6. Tests d'intégration Tryorama ──────────────────────────────────────────
tests: build-happ
	cd tests && npm install && npm test

# ── 7. Type-check rapide (sans compilation WASM) ─────────────────────────────
check:
	cargo check --target $(WASM_TARGET)
	cd $(UI_DIR) && npx tsc --noEmit

# ── 8. Développement local ───────────────────────────────────────────────────
# Lance le conductor Holochain local + l'UI Vite en mode watch.
# Pré-requis : holochain binaire installé, lair-keystore démarré séparément.
dev:
	@echo "Démarrez d'abord lair-keystore puis le conductor :"
	@echo "  lair-keystore --lair-root ./conductor-data/dev/ks serve --piped &"
	@echo "  holochain -c conductor-config.dev.yaml &"
	@echo "Puis :"
	@echo "  make dev-ui"

dev-ui:
	cd $(UI_DIR) && npm run dev

# ── 9. Upload Holo Host ───────────────────────────────────────────────────────
# Nécessite holo-host CLI et une authentification active.
# Installe : npm install -g @holo-host/cli
upload-holo: build-webhapp
	@echo "→ Upload vers Holo Host…"
	holo-host upload $(WORKDIR)/filenymous.webhapp
	@echo "✅ Upload terminé — vérifiez le dashboard Holo Host"

# ── 10. Nettoyage ────────────────────────────────────────────────────────────
clean:
	cargo clean
	cd $(TAURI_DIR) && cargo clean
	rm -rf $(WORKDIR)
	rm -rf $(POUCH_DIR)
	rm -rf $(UI_DIST)
	rm -rf tests/node_modules
	rm -rf $(UI_DIR)/node_modules
	rm -rf conductor-data
