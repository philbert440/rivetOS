#!/usr/bin/env bash
# grok-memory-hook — forward a Grok Build lifecycle hook payload to RivetOS capture.
#
# This script is meant to be referenced from Grok's hooks configuration.
# It is extremely fast and best-effort: it always exits 0.

set -euo pipefail

RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
CAPTURE_SCRIPT="$RIVETOS_ROOT/integrations/grok/rivet-memory/capture/grok-memory-capture.ts"

# Source env for DB credentials if present
RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

if [ ! -f "$CAPTURE_SCRIPT" ]; then
  echo "grok-memory-hook: capture script not found at $CAPTURE_SCRIPT" >&2
  exit 0
fi

# Read the hook payload from stdin and pass it to the capture module
# The module will spool it and detach a worker.
node "$CAPTURE_SCRIPT" --hook "${1:-unknown}" || true

exit 0
