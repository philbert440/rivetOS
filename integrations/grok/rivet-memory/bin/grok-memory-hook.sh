#!/usr/bin/env bash
# grok-memory-hook — forward a Grok Build lifecycle hook payload to RivetOS capture.
#
# This script is meant to be referenced from Grok's hooks configuration.
# It is extremely fast and best-effort: it always exits 0.
#
# Path discovery: respects $RIVETOS_ROOT (default /opt/rivetos). Prefers the
# built artifact at .../capture/dist/grok-memory-capture.js (produced by
# `npm run build` in the @rivetos/grok-rivet-memory-capture workspace). Falls
# back to running the .ts source via `npx --yes tsx` for ergonomics on
# unbuilt checkouts — the .js path is the supported production path.

set -euo pipefail

RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
CAPTURE_DIR="$RIVETOS_ROOT/integrations/grok/rivet-memory/capture"
CAPTURE_BUILT="$CAPTURE_DIR/dist/grok-memory-capture.js"
CAPTURE_SRC="$CAPTURE_DIR/src/grok-memory-capture.ts"

# Source env for DB credentials if present
RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

if [ -f "$CAPTURE_BUILT" ]; then
  node "$CAPTURE_BUILT" --hook "${1:-unknown}" || true
elif [ -f "$CAPTURE_SRC" ]; then
  npx --yes tsx "$CAPTURE_SRC" --hook "${1:-unknown}" || true
else
  echo "grok-memory-hook: capture not found at $CAPTURE_BUILT or $CAPTURE_SRC" >&2
fi

exit 0
