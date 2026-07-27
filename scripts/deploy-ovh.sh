#!/usr/bin/env bash
set -euo pipefail

OVH_SFTP_HOST="${OVH_SFTP_HOST:-ftp.cluster129.hosting.ovh.net}"
OVH_SFTP_USER="${OVH_SFTP_USER:-filenyb}"
OVH_REMOTE_DIR="${OVH_REMOTE_DIR:-/home/filenyb/www}"
LOCAL_FILE="${LOCAL_FILE:-filenymous-app.html}"
REFERENCE_FILE="${REFERENCE_FILE:-docs/demo/app/index.html}"
CHECK_URL="${CHECK_URL:-https://filenymous.eu/}"

REMOTE_TMP="$OVH_REMOTE_DIR/index.html.tmp"
REMOTE_FILE="$OVH_REMOTE_DIR/index.html"

echo "== Filenymous OVH deploy =="
echo "Host: $OVH_SFTP_HOST"
echo "User: $OVH_SFTP_USER"
echo "Remote: $REMOTE_FILE"
echo "Local: $LOCAL_FILE"

test -f "$REFERENCE_FILE"
test -f "$LOCAL_FILE"

echo "1/ Checking demo and OVH bundle are identical"
if ! cmp -s <(tr -d '\r' < "$REFERENCE_FILE") <(tr -d '\r' < "$LOCAL_FILE"); then
  echo "ERROR: $REFERENCE_FILE and $LOCAL_FILE differ after line-ending normalization." >&2
  echo "Run: cp \"$REFERENCE_FILE\" \"$LOCAL_FILE\" and normalize line endings if Git requires it." >&2
  exit 1
fi

echo "2/ Checking required release markers"
grep -q 'FILENYMOUS_I18N' "$LOCAL_FILE"
grep -q 'advanced.title' "$LOCAL_FILE"
grep -q 'public-room-create-btn' "$LOCAL_FILE"
grep -q 'rooms.activeTitle' "$LOCAL_FILE"

echo "3/ Running static web tests"
npm --prefix tests test -- \
  src/web_mode_standalone.test.ts \
  src/static_room_demo.test.ts \
  src/magic_ux.test.ts \
  src/p2p_direct.test.ts \
  src/p2p_signal_hardening.test.ts \
  src/p2p_signal_server.test.ts \
  src/p2p_signal_relay.test.ts

echo "4/ Uploading to OVH through SFTP"
sftp -oBatchMode=no "$OVH_SFTP_USER@$OVH_SFTP_HOST" <<SFTP
put "$LOCAL_FILE" "$REMOTE_TMP"
rename "$REMOTE_TMP" "$REMOTE_FILE"
chmod 0644 "$REMOTE_FILE"
bye
SFTP

echo "5/ Verifying public OVH page"
CACHE_BUSTER="$(date +%s)"
HTML="$(curl -fsSL "$CHECK_URL?check=$CACHE_BUSTER")"

printf '%s' "$HTML" | grep -q 'FILENYMOUS_I18N'
printf '%s' "$HTML" | grep -q 'advanced.title'
printf '%s' "$HTML" | grep -q 'public-room-create-btn'
printf '%s' "$HTML" | grep -q 'rooms.activeTitle'

echo "OVH deploy OK: $CHECK_URL"
