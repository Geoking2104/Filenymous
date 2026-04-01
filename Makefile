# Filenymous — build commands
# Requires: Rust + wasm32-unknown-unknown target, hc CLI, npm
#
# M1 targets : build-wasm  build-dna  build-happ
# M4 targets : build-ui    build-webhapp
# Full stack  : make all   (hApp + webhapp)

WASM_TARGET  := wasm32-unknown-unknown
DNA_PATH     := dnas/filenymous
WORKDIR      := workdir
UI_DIR       := ui
UI_DIST      := $(UI_DIR)/dist

# Env vars passed to Vite at build time; override on the command line.
# Example: make build-ui VITE_HC_URL=ws://localhost:8888
VITE_HC_URL        ?= ws://localhost:8888
VITE_BRIDGE_URL    ?= http://localhost:3001
VITE_BRIDGE_SECRET ?= replace-in-production

.PHONY: all build-wasm build-dna build-happ build-ui build-webhapp tests check clean

all: build-webhapp

## ── 1. Compile all zomes to WASM ──────────────────────────────────────────
build-wasm:
	cargo build --release --target $(WASM_TARGET)

## ── 2. Pack the DNA ────────────────────────────────────────────────────────
build-dna: build-wasm
	mkdir -p $(WORKDIR)
	hc dna pack $(DNA_PATH) -o $(WORKDIR)/filenymous.dna

## ── 3. Pack the hApp ───────────────────────────────────────────────────────
build-happ: build-dna
	hc app pack . -o $(WORKDIR)/filenymous.happ
	@echo "✅ hApp ready: $(WORKDIR)/filenymous.happ"

## ── 4. Build the React UI and zip it for packaging ─────────────────────────
build-ui:
	cd $(UI_DIR) && npm ci
	cd $(UI_DIR) && \
		VITE_HC_URL=$(VITE_HC_URL) \
		VITE_BRIDGE_URL=$(VITE_BRIDGE_URL) \
		VITE_BRIDGE_SECRET=$(VITE_BRIDGE_SECRET) \
		npm run build
	@# Holochain Launcher expects the dist/ contents at zip root (index.html at /)
	cd $(UI_DIST) && zip -r ../../$(WORKDIR)/ui.zip .
	@echo "✅ UI zip ready: $(WORKDIR)/ui.zip"

## ── 5. Pack the .webhapp (M4 — Holochain Launcher bundle) ─────────────────
##   Combines filenymous.happ + ui.zip → single distributable file.
##   Install via Holochain Launcher: File → Install hApp → select .webhapp
build-webhapp: build-happ build-ui
	hc web-app pack . -o $(WORKDIR)/filenymous.webhapp
	@echo "✅ .webhapp ready: $(WORKDIR)/filenymous.webhapp"
	@echo "   → Open Holochain Launcher and install $(WORKDIR)/filenymous.webhapp"

## ── 6. Run integration tests ───────────────────────────────────────────────
tests: build-happ
	cd tests && npm install && npm test

## ── 7. Quick type-check (no WASM compilation) ─────────────────────────────
check:
	cargo check --target $(WASM_TARGET)
	cd $(UI_DIR) && npx tsc --noEmit

## ── 8. Clean ───────────────────────────────────────────────────────────────
clean:
	cargo clean
	rm -rf $(WORKDIR)
	rm -rf $(UI_DIST)
	rm -rf tests/node_modules
	rm -rf $(UI_DIR)/node_modules
