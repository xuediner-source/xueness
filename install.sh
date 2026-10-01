#!/bin/sh
# Xueness one-command local launcher (stdlib-only Python; no pip, no Docker).
#
# From a checkout:
#   ./install.sh                 # start on 127.0.0.1:8137, data in ./.xueness-data
#   PORT=9000 ./install.sh       # choose a port
#   DATA_DIR=/var/lib/xueness ./install.sh
#
# Everything runs as the current user, loopback-only. Nothing is installed
# system-wide and no network service is exposed. Stop with Ctrl-C.
set -eu

PORT="${PORT:-8137}"
DATA_DIR="${DATA_DIR:-$(pwd)/.xueness-data}"

command -v python3 >/dev/null 2>&1 || {
    echo "python3 not found. Xueness needs Python 3.10+ (standard library only)." >&2
    exit 1
}

python3 - <<'PY' || { echo "Python 3.10+ is required." >&2; exit 1; }
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

mkdir -p "$DATA_DIR/state" "$DATA_DIR/runs"
chmod 700 "$DATA_DIR" 2>/dev/null || true

echo "Xueness: http://127.0.0.1:${PORT}  (data: ${DATA_DIR})"
echo "Local only. Press Ctrl-C to stop."
exec python3 -m xueness.web --port "$PORT" --state "$DATA_DIR/state" --web-runs "$DATA_DIR/runs"
