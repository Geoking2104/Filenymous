#!/usr/bin/env bash
# Agent Vault end-to-end: browser (Playwright) → local Holochain 0.6.x conductor
# running the separate "filenymous-agent-vault" app → CLI `filenymous vault`.
#
# Needs: hc + holochain 0.6.x on PATH (nix develop), node, Playwright chromium.
# Usage: scripts/agent-vault-e2e.sh            (ports 9001 admin / 9002 app)
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN_PORT=${ADMIN_PORT:-9001}
APP_PORT=${APP_PORT:-9002}
hc --version | grep -q " 0\.6\." || { echo "hc 0.6.x required"; exit 1; }

make build-agent-vault-dna
(cd cli && npm run build)

WORK=$(mktemp -d)
cleanup() {
  kill "${SANDBOX_PID:-}" "${VITE_PID:-}" 2>/dev/null || true
  pkill -f "$WORK" 2>/dev/null || true # the conductor child (config under $WORK)
  rm -rf "$WORK"
}
trap cleanup EXIT

HAPP="$PWD/workdir/filenymous-agent-vault.happ"
# Run from $WORK: hc sandbox writes its .hc bookkeeping files in the cwd.
(cd "$WORK" && echo pass | exec hc sandbox --piped -f "$ADMIN_PORT" generate --in-process-lair --root "$WORK" \
  -a filenymous-agent-vault -r "$APP_PORT" "$HAPP" network mem) > "$WORK/sandbox.log" 2>&1 &
SANDBOX_PID=$!
for _ in $(seq 60); do grep -q '"app_ports"' "$WORK/sandbox.log" && break; sleep 1; done
grep -q '"app_ports"' "$WORK/sandbox.log" || { cat "$WORK/sandbox.log"; exit 1; }

cd ui
VITE_HC_URL="ws://localhost:$APP_PORT" VITE_HC_ADMIN_URL="ws://localhost:$ADMIN_PORT" node node_modules/vite/bin/vite.js > "$WORK/vite.log" 2>&1 &
VITE_PID=$!
for _ in $(seq 30); do curl -sf http://localhost:5173/ >/dev/null && break; sleep 1; done
AGENT_VAULT_E2E=1 AV_ADMIN_URL="ws://localhost:$ADMIN_PORT" npx playwright test e2e/agent-vault.spec.ts --reporter=line
