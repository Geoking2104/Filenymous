#!/usr/bin/env bash
# download-binaries.sh
#
# Télécharge les binaires holochain + lair-keystore depuis matthme/holochain-binaries
# et les place dans src-tauri/bins/ avec le naming Tauri sidecar :
#   holochain-v{VERSION}-{triple}
#   lair-keystore-v{VERSION}-{triple}
#
# Usage :
#   bash scripts/download-binaries.sh                    # détecte le triple via rustc
#   bash scripts/download-binaries.sh aarch64-apple-darwin
#
# Sur CI : le triple est passé explicitement depuis la matrice GitHub Actions.

set -euo pipefail

HOLOCHAIN_VERSION="0.3.2"
LAIR_VERSION="0.4.5"
DEST="src-tauri/bins"

# ── Détection du triple cible ─────────────────────────────────────────────────
if [[ $# -ge 1 && -n "$1" ]]; then
    PLATFORM="$1"
else
    if ! command -v rustc &>/dev/null; then
        echo "ERROR: rustc introuvable et aucun triple fourni en argument" >&2
        echo "Usage: bash scripts/download-binaries.sh <triple>" >&2
        exit 1
    fi
    PLATFORM=$(rustc -vV | sed -n 's/^.*host: \(.*\)*$/\1/p')
fi

echo "Plateforme cible : $PLATFORM"

# ── Extension exécutable (Windows uniquement) ─────────────────────────────────
if [[ "$PLATFORM" == *windows* ]]; then
    EXT=".exe"
else
    EXT=""
fi

mkdir -p "$DEST"

# ── Téléchargement d'un binaire depuis matthme/holochain-binaries ─────────────
download_binary() {
    local repo_path="$1"    # ex: holochain-binaries-0.3.2
    local filename="$2"     # ex: holochain-v0.3.2-x86_64-apple-darwin
    local dest_path="$DEST/$filename"

    if [[ -f "$dest_path" ]]; then
        echo "   ✅ déjà présent : $dest_path"
        return
    fi

    local url="https://github.com/matthme/holochain-binaries/releases/download/${repo_path}/${filename}"
    echo "→ Téléchargement : $url"
    curl -fsSL -o "$dest_path" "$url"
    chmod +x "$dest_path"
    echo "   ✅ $dest_path"
}

# ── holochain ─────────────────────────────────────────────────────────────────
download_binary \
    "holochain-binaries-${HOLOCHAIN_VERSION}" \
    "holochain-v${HOLOCHAIN_VERSION}-${PLATFORM}${EXT}"

# ── lair-keystore ─────────────────────────────────────────────────────────────
download_binary \
    "lair-binaries-${LAIR_VERSION}" \
    "lair-keystore-v${LAIR_VERSION}-${PLATFORM}${EXT}"

echo ""
echo "✅ Binaires prêts dans $DEST/"
ls -lh "$DEST/"
