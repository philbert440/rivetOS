#!/usr/bin/env bash
# pi-memory-capture — start the RivetOS capture watcher for the pi CLI.
#
# Pi has no lifecycle hooks. This script launches the v3 session jsonl
# watcher (`--watch`) or a one-shot ingest (`--backfill`/`--once`, `--ingest FILE`).
# Best-effort: ingest failures are logged, the watcher keeps running.
#
# Path discovery: respects $RIVETOS_ROOT (default /opt/rivetos). Prefers the
# built artifact at .../capture/dist/pi-memory-capture.js. Falls back to
# running the .ts source via `npx --yes tsx` on unbuilt checkouts.
#
set -euo pipefail

RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
CAPTURE_DIR="$RIVETOS_ROOT/integrations/pi/rivet-memory/capture"
CAPTURE_BUILT="$CAPTURE_DIR/dist/pi-memory-capture.js"
CAPTURE_SRC="$CAPTURE_DIR/src/pi-memory-capture.ts"

RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

if [ -f "$CAPTURE_BUILT" ]; then
  exec node "$CAPTURE_BUILT" "$@"
elif [ -f "$CAPTURE_SRC" ]; then
  exec npx --yes tsx "$CAPTURE_SRC" "$@"
else
  echo "pi-memory-capture: capture not found at $CAPTURE_BUILT or $CAPTURE_SRC" >&2
  exit 1
fi
