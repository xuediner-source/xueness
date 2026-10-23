#!/bin/sh
# Xueness one-command local launcher (Node.js 24; no Docker).
#
# From a checkout:
#   ./install.sh                 # start on 127.0.0.1:8137, data in ./.xueness-data
#   PORT=9000 ./install.sh       # choose a port
#   DATA_DIR=/var/lib/xueness ./install.sh
#
# Everything runs as the current user, loopback-only. Nothing is installed
# system-wide and no network service is exposed. The first start installs the
# TypeScript workspace dependencies into ./ts/node_modules. Stop with Ctrl-C.
set -eu

PORT="${PORT:-8137}"
DATA_DIR="${DATA_DIR:-$(pwd)/.xueness-data}"
NODE="${XUENESS_NODE:-node}"

command -v "$NODE" >/dev/null 2>&1 || {
    echo "node not found. Xueness needs Node.js 24.11 or newer." >&2
    exit 1
}

"$NODE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || major === 24 && minor >= 11 ? 0 : 1)' \
    || { echo "Node.js 24.11 or newer is required." >&2; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

if [ ! -d ts/node_modules ]; then
    npm ci --prefix ts --omit=dev --no-audit --no-fund
fi

mkdir -p "$DATA_DIR/state" "$DATA_DIR/runs"
chmod 700 "$DATA_DIR" 2>/dev/null || true

echo "Xueness: http://127.0.0.1:${PORT}  (data: ${DATA_DIR})"
echo "Local only. Press Ctrl-C to stop."
exec "$NODE" ts/apps/server/src/main.ts --project-root "$HERE" --port "$PORT" --state "$DATA_DIR/state" --web-runs "$DATA_DIR/runs"
