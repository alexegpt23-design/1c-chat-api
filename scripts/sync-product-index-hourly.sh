#!/bin/sh
set -eu
cd /opt/1c-chat-api
exec 9>/tmp/1c-product-index-sync.lock
if ! flock -n 9; then
    echo "[product-index-sync] previous synchronization is still running"
    exit 0
fi
exec /usr/bin/node scripts/sync-product-index.js
