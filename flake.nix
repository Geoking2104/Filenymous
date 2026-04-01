{
  description = "Filenymous — P2P file transfer on Holochain";

  inputs = {
    nixpkgs.url     = "github:NixOS/nixpkgs/nixos-24.05";
    flake-utils.url = "github:numtide/flake-utils";

    # Holochain's own Nix flake — pins exact versions of holochain, hc, lair-keystore
    holochain-flake = {
      url    = "github:holochain/holochain";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, holochain-flake }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        holochainPkgs = holochain-flake.packages.${system};
      in
      {
        # `nix develop` — full dev environment
        devShells.default = pkgs.mkShell {
          name = "filenymous-dev";

          buildInputs = [
            # ── Holochain toolchain ────────────────────────────────────────
            holochainPkgs.holochain        # conductor binary
            holochainPkgs.hc               # CLI: dna/app/web-app pack + admin
            holochainPkgs.lair-keystore    # keystore daemon

            # ── Rust (WASM target added below) ─────────────────────────────
            pkgs.cargo
            pkgs.rustc
            pkgs.rustfmt
            pkgs.clippy

            # ── Node.js (UI + bridge + tryorama) ──────────────────────────
            pkgs.nodejs_20
            pkgs.nodePackages.npm

            # ── Build utilities ────────────────────────────────────────────
            pkgs.gnumake
            pkgs.zip          # needed by `make build-ui` (ui.zip for Launcher)
            pkgs.cacert

            # ── Docker (for `make infra-*` targets) ───────────────────────
            pkgs.docker-compose
          ];

          # Add wasm32 target for Cargo
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
            echo "  make build-webhapp   → compile + pack .webhapp"
            echo "  make tests           → tryorama integration tests"
            echo "  make infra-up        → start bootstrap + signal + bridge"
            echo ""
          '';
        };
      }
    );
}
