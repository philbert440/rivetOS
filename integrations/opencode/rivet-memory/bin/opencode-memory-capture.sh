#!/usr/bin/env bash
# opencode-memory-capture — RivetOS capture ingest for OpenCode CLI.
#
# Triggered by the OpenCode plugin (`--ingest-session <id>`) or run as a
# one-shot (`--backfill [--days N]`) / `--status`. Always exits 0 so the
# harness is never blocked.
#
# Path discovery: prefers capture/dist/opencode-memory-capture.js next to
# this package. Falls back to `npx --yes tsx` against the .ts source.
# Sources ${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}.
#
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CAPTURE_DIR="$PLUGIN_DIR/capture"
CAPTURE_BUILT="$CAPTURE_DIR/dist/opencode-memory-capture.js"
CAPTURE_SRC="$CAPTURE_DIR/src/opencode-memory-capture.ts"

if [ -z "${RIVETOS_ROOT:-}" ]; then
  RIVETOS_ROOT="$(cd "$PLUGIN_DIR/../../.." && pwd 2>/dev/null || echo /opt/rivetos)"
  export RIVETOS_ROOT
fi

RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

if [ -f "$CAPTURE_BUILT" ]; then
  node "$CAPTURE_BUILT" "$@" || true
elif [ -f "$CAPTURE_SRC" ]; then
  npx --yes tsx "$CAPTURE_SRC" "$@" || true
else
  echo "opencode-memory-capture: capture not found at $CAPTURE_BUILT or $CAPTURE_SRC" >&2 || true
fi

exit 0
