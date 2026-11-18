#!/usr/bin/env bash
# download-binaries.sh
#
# Télécharge le binaire `holochain` (release officielle holochain/holochain)
# et le place dans src-tauri/bins/ avec le naming Tauri sidecar :
#   holochain-v{VERSION}-{triple}
#
# Holochain 0.6 : lair-keystore tourne **in-process** dans le conductor
# (KeystoreConfig::LairServerInProc) — plus de sidecar lair.
#
# La version doit correspondre à `holochain_conductor_api` dans
# src-tauri/Cargo.toml (build.rs en dérive le nom du sidecar).
#
# Usage :
#   bash scripts/download-binaries.sh                    # détecte le triple via rustc
#   bash scripts/download-binaries.sh aarch64-apple-darwin

set -euo pipefail

HOLOCHAIN_VERSION="0.6.1"
DEST="src-tauri/bins"

if [[ $# -ge 1 && -n "$1" ]]; then
    PLATFORM="$1"
else
    if ! command -v rustc &>/dev/null; then
        echo "ERROR: rustc introuvable et aucun triple fourni en argument" >&2
        exit 1
    fi
    PLATFORM=$(rustc -vV | sed -n 's/^host: //p')
fi
echo "Plateforme cible : $PLATFORM"

EXT=""
[[ "$PLATFORM" == *windows* ]] && EXT=".exe"

mkdir -p "$DEST"
dest_path="$DEST/holochain-v${HOLOCHAIN_VERSION}-${PLATFORM}${EXT}"
if [[ -f "$dest_path" ]]; then
    echo "   ✅ déjà présent : $dest_path"
else
    url="https://github.com/holochain/holochain/releases/download/holochain-${HOLOCHAIN_VERSION}/holochain-${PLATFORM}${EXT}"
    echo "→ Téléchargement : $url"
    curl -fsSL -o "$dest_path" "$url"
    chmod +x "$dest_path"
fi
"$dest_path" --version 2>/dev/null || true
echo "✅ Binaire prêt dans $DEST/"
