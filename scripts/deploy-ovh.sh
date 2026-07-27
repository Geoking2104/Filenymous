#!/usr/bin/env bash
set -euo pipefail

OVH_SFTP_HOST="${OVH_SFTP_HOST:-ftp.cluster129.hosting.ovh.net}"
OVH_SFTP_USER="${OVH_SFTP_USER:-filenyb}"
OVH_REMOTE_DIR="${OVH_REMOTE_DIR:-/home/filenyb/www}"
LOCAL_SITE_DIR="${LOCAL_SITE_DIR:-docs/demo}"
LOCAL_APP_FILE="${LOCAL_APP_FILE:-$LOCAL_SITE_DIR/app/index.html}"
LOCAL_STANDALONE_FILE="${LOCAL_STANDALONE_FILE:-filenymous-app.html}"
CHECK_URL="${CHECK_URL:-https://filenymous.eu/}"

REMOTE_INDEX_TMP="$OVH_REMOTE_DIR/index.html.tmp"
REMOTE_INDEX="$OVH_REMOTE_DIR/index.html"
REMOTE_APP_TMP="$OVH_REMOTE_DIR/app/index.html.tmp"
REMOTE_APP="$OVH_REMOTE_DIR/app/index.html"
REMOTE_HTACCESS_TMP="$OVH_REMOTE_DIR/.htaccess.tmp"
REMOTE_HTACCESS="$OVH_REMOTE_DIR/.htaccess"

echo "== Filenymous OVH deploy =="
echo "Host: $OVH_SFTP_HOST"
echo "User: $OVH_SFTP_USER"
echo "Remote root: $OVH_REMOTE_DIR"
echo "Local site: $LOCAL_SITE_DIR"

test -f "$LOCAL_SITE_DIR/index.html"
test -f "$LOCAL_APP_FILE"
test -f "$LOCAL_SITE_DIR/.htaccess"
test -f "$LOCAL_STANDALONE_FILE"

echo "1/ Checking app bundle and standalone bundle are identical"
if ! cmp -s <(tr -d '\r' < "$LOCAL_APP_FILE") <(tr -d '\r' < "$LOCAL_STANDALONE_FILE"); then
  echo "ERROR: $LOCAL_APP_FILE and $LOCAL_STANDALONE_FILE differ after line-ending normalization." >&2
  echo "Run: cp \"$LOCAL_APP_FILE\" \"$LOCAL_STANDALONE_FILE\" and normalize line endings if Git requires it." >&2
  exit 1
fi

echo "2/ Checking required release markers"
grep -q "location.replace('./app/' + location.hash)" "$LOCAL_SITE_DIR/index.html"
grep -q 'FILENYMOUS_I18N' "$LOCAL_APP_FILE"
grep -q 'advanced.title' "$LOCAL_APP_FILE"
grep -q 'public-room-create-btn' "$LOCAL_APP_FILE"
grep -q 'rooms.activeTitle' "$LOCAL_APP_FILE"
grep -q 'preferP2PCode: true' "$LOCAL_APP_FILE"

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
-mkdir "$OVH_REMOTE_DIR/app"
put "$LOCAL_SITE_DIR/index.html" "$REMOTE_INDEX_TMP"
put "$LOCAL_APP_FILE" "$REMOTE_APP_TMP"
put "$LOCAL_SITE_DIR/.htaccess" "$REMOTE_HTACCESS_TMP"
rename "$REMOTE_INDEX_TMP" "$REMOTE_INDEX"
rename "$REMOTE_APP_TMP" "$REMOTE_APP"
rename "$REMOTE_HTACCESS_TMP" "$REMOTE_HTACCESS"
chmod 0644 "$REMOTE_INDEX"
chmod 0644 "$REMOTE_APP"
chmod 0644 "$REMOTE_HTACCESS"
bye
SFTP

echo "5/ Verifying public OVH pages"
CACHE_BUSTER="$(date +%s)"
ROOT_HTML="$(curl -fsSL "$CHECK_URL?check=$CACHE_BUSTER")"
APP_HTML="$(curl -fsSL "${CHECK_URL%/}/app/?check=$CACHE_BUSTER")"

printf '%s' "$ROOT_HTML" | grep -q "location.replace('./app/' + location.hash)"
printf '%s' "$APP_HTML" | grep -q 'FILENYMOUS_I18N'
printf '%s' "$APP_HTML" | grep -q 'advanced.title'
printf '%s' "$APP_HTML" | grep -q 'public-room-create-btn'
printf '%s' "$APP_HTML" | grep -q 'rooms.activeTitle'
printf '%s' "$APP_HTML" | grep -q 'preferP2PCode: true'

echo "OVH deploy OK: $CHECK_URL"
