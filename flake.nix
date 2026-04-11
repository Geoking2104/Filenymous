{
  description = "Filenymous — P2P file transfer on Holochain";

  inputs = {
    nixpkgs.url     = "github:NixOS/nixpkgs/nixos-24.05";
    flake-utils.url = "github:numtide/flake-utils";

    # holonix — official Holochain dev environment (holochain, hc, lair-keystore)
    holonix = {
      url    = "github:holochain/holonix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, holonix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs        = import nixpkgs { inherit system; };
        holonixPkgs = holonix.packages.${system};
      in
      {
        # `nix develop` — full dev environment
        devShells.default = pkgs.mkShell {
          name = "filenymous-dev";

          buildInputs = [
            # ── Holochain toolchain (via holonix) ─────────────────────────
            holonixPkgs.holochain        # conductor binary
            holonixPkgs.hc               # CLI: dna/app/web-app pack + admin
            holonixPkgs.lair-keystore    # keystore daemon

            # ── Rust (WASM target added below) ────────────────────────────
            pkgs.cargo
            pkgs.rustc
            pkgs.rustfmt
            pkgs.clippy

            # ── Node.js (bridge + tryorama) ───────────────────────────────
            pkgs.nodejs_20
            pkgs.nodePackages.npm

            # ── Build utilities ───────────────────────────────────────────
            pkgs.gnumake
            pkgs.zip
            pkgs.cacert

            # ── Docker (for `make infra-*` targets) ──────────────────────
            pkgs.docker-compose
          ];

          shellHook = ''
            export CARGO_TARGET_DIR="$(pwd)/target"
            rustup target add wasm32-unknown-unknown 2>/dev/null || true
            echo ""
            echo "  ⟁ Filenymous dev shell"
            echo "  holochain  $(holochain --version 2>/dev/null || echo 'not found')"
            echo "  hc         $(hc --version 2>/dev/null || echo 'not found')"
            echo "  node       $(node --version)"
            echo "  cargo      $(cargo --version)"
            echo ""
            echo "  make build-happ      → compile + pack .happ"
            echo "  make tests           → tryorama integration tests"
            echo "  make infra-up        → start bootstrap + bridge"
            echo ""
          '';
        };
      }
    );
}
