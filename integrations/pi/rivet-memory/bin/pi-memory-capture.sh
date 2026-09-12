#!/usr/bin/env bash
# pi-memory-capture — RivetOS capture ingest for the pi CLI.
#
# Triggered by the pi extension (`--ingest-file`) or run one-shot
# (`--backfill`, `--status`). Always exits 0 so the harness is never blocked.
#
# Path discovery: this script lives in the plugin tree. Prefers the built
# artifact at .../capture/dist/pi-memory-capture.js. Falls back to running
# the .ts source via `npx --yes tsx` on unbuilt checkouts.
#
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CAPTURE_DIR="$PLUGIN_DIR/capture"
CAPTURE_BUILT="$CAPTURE_DIR/dist/pi-memory-capture.js"
CAPTURE_SRC="$CAPTURE_DIR/src/pi-memory-capture.ts"

RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

LOG_DIR="${HOME}/.rivetos/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG_FILE="${LOG_DIR}/pi-capture.log"

run_capture() {
  if [ -f "$CAPTURE_BUILT" ]; then
    node "$CAPTURE_BUILT" "$@"
  elif [ -f "$CAPTURE_SRC" ]; then
    npx --yes tsx "$CAPTURE_SRC" "$@"
  else
    echo "pi-memory-capture: capture not found at $CAPTURE_BUILT or $CAPTURE_SRC" >&2
    return 0
  fi
}

# --status / --help must keep stdout for the caller (doctor).
status_or_help=0
for arg in "$@"; do
  case "$arg" in
    --status|-h|--help) status_or_help=1 ;;
  esac
done

if [ "$status_or_help" -eq 1 ]; then
  run_capture "$@" || true
else
  run_capture "$@" >>"$LOG_FILE" 2>&1 || true
fi

exit 0
