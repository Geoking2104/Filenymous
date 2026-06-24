{
  description = "Filenymous - P2P file transfer on Holochain";

  inputs = {
    holonix.url = "github:holochain/holonix?ref=main-0.6";
    nixpkgs.follows = "holonix/nixpkgs";
    flake-parts.follows = "holonix/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = builtins.attrNames inputs.holonix.devShells;

      perSystem = { inputs', pkgs, ... }: {
        formatter = pkgs.nixpkgs-fmt;

        devShells.default = pkgs.mkShell {
          inputsFrom = [ inputs'.holonix.devShells.default ];

          packages = with pkgs; [
            nodejs_22
            gnumake
            zip
            binaryen
          ];

          shellHook = ''
            export CARGO_TARGET_DIR="$(pwd)/target"
            export PS1='\[\033[1;34m\][filenymous:\w]$\[\033[0m\] '
            echo "Filenymous dev shell"
            echo "  holochain  $(holochain --version 2>/dev/null || echo 'not found')"
            echo "  hc         $(hc --version 2>/dev/null || echo 'not found')"
            echo "  node       $(node --version 2>/dev/null || echo 'not found')"
            echo "  cargo      $(cargo --version 2>/dev/null || echo 'not found')"
          '';
        };
      };
    };
}
