#!/usr/bin/env bash
# opencode-memory-capture — RivetOS capture ingest for OpenCode CLI.
#
# Triggered by the OpenCode plugin (`--ingest-session <id> [--delay-ms N]`) or
# run one-shot (`--backfill [--days N]`, `--status`). Always exits 0 so the
# harness is never blocked.
#
# Path discovery: this script lives in the plugin tree (resolved through
# symlinks, so a /usr/local/bin link works). Prefers capture/dist/*.js, falls
# back to `npx --yes tsx` against the .ts source. A validated RIVETOS_ROOT (or
# /opt/rivetos) is the fallback when the resolved dir has no capture/.
# Sources ${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}.
#
set -u

_resolve_script() {
  local src="$1"
  if command -v readlink >/dev/null 2>&1 && readlink -f "$src" >/dev/null 2>&1; then
    readlink -f "$src"
    return
  fi
  local dir=""
  while [ -L "$src" ]; do
    dir="$(cd "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    case "$src" in
      /*) ;;
      *) src="${dir}/${src}" ;;
    esac
  done
  dir="$(cd "$(dirname "$src")" && pwd)"
  echo "${dir}/$(basename "$src")"
}

_SELF="$(_resolve_script "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$_SELF")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CAPTURE_DIR="$PLUGIN_DIR/capture"
unset _SELF

if [ ! -d "$CAPTURE_DIR" ]; then
  _root="${RIVETOS_ROOT:-/opt/rivetos}"
  _fallback="$_root/integrations/opencode/rivet-memory/capture"
  if [ -d "$_fallback" ]; then
    PLUGIN_DIR="$_root/integrations/opencode/rivet-memory"
    CAPTURE_DIR="$_fallback"
  fi
  unset _root _fallback
fi

if [ -z "${RIVETOS_ROOT:-}" ]; then
  RIVETOS_ROOT="$(cd "$PLUGIN_DIR/../../.." && pwd 2>/dev/null || echo /opt/rivetos)"
  export RIVETOS_ROOT
fi

CAPTURE_BUILT="$CAPTURE_DIR/dist/opencode-memory-capture.js"
CAPTURE_SRC="$CAPTURE_DIR/src/opencode-memory-capture.ts"

RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

LOG_DIR="${HOME}/.rivetos/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG_FILE="${LOG_DIR}/opencode-capture.log"

run_capture() {
  if [ -f "$CAPTURE_BUILT" ]; then
    node "$CAPTURE_BUILT" "$@"
  elif [ -f "$CAPTURE_SRC" ]; then
    npx --yes tsx "$CAPTURE_SRC" "$@"
  else
    echo "opencode-memory-capture: capture not found at $CAPTURE_BUILT or $CAPTURE_SRC" >&2
    return 0
  fi
}

case "${1:-}" in
  --ingest-session)
    # plugin-triggered, detached: nothing should reach the harness; keep a small log
    run_capture "$@" >>"$LOG_FILE" 2>&1 || true
    ;;
  *)
    run_capture "$@" || true
    ;;
esac

exit 0
