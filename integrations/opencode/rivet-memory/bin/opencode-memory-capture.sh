#!/usr/bin/env bash
# opencode-memory-capture — start the RivetOS capture watcher for OpenCode CLI.
#
# OpenCode has no lifecycle hooks. This script launches the SQLite watcher
# (`--watch`) or a one-shot ingest (`--once`). Best-effort: ingest failures
# are logged, the watcher keeps running.
#
# Path discovery: respects $RIVETOS_ROOT (default /opt/rivetos). Prefers the
# built artifact at .../capture/dist/opencode-memory-capture.js. Falls back to
# running the .ts source via `npx --yes tsx` on unbuilt checkouts.
#
set -euo pipefail

RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
CAPTURE_DIR="$RIVETOS_ROOT/integrations/opencode/rivet-memory/capture"
CAPTURE_BUILT="$CAPTURE_DIR/dist/opencode-memory-capture.js"
CAPTURE_SRC="$CAPTURE_DIR/src/opencode-memory-capture.ts"

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
  echo "opencode-memory-capture: capture not found at $CAPTURE_BUILT or $CAPTURE_SRC" >&2
  exit 1
fi
