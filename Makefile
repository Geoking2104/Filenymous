# Filenymous — M1 build commands
# Requires: Rust + wasm32-unknown-unknown target, hc CLI, npm

WASM_TARGET := wasm32-unknown-unknown
DNA_PATH    := dnas/filenymous
WORKDIR     := workdir

.PHONY: all build-wasm build-dna build-happ tests clean

all: build-happ

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
	@echo "\n✅ hApp ready: $(WORKDIR)/filenymous.happ"

## ── 4. Run integration tests ───────────────────────────────────────────────
tests: build-happ
	cd tests && npm install && npm test

## ── 5. Quick type-check (no compilation) ──────────────────────────────────
check:
	cargo check --target $(WASM_TARGET)

## ── 6. Clean ───────────────────────────────────────────────────────────────
clean:
	cargo clean
	rm -rf $(WORKDIR)
	rm -rf tests/node_modules
