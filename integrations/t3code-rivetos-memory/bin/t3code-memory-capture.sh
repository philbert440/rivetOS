#!/usr/bin/env bash
# t3code-memory-capture — poll T3 state.sqlite and upsert into RivetOS memory.
#
# Run beside `t3 service` (or `t3 serve`). Always exits 0 on --watch ticks
# so a flaky read cannot take down a supervisor. Never writes the SQLite file.
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
  _fallback="$_root/integrations/t3code-rivetos-memory/capture"
  if [ -d "$_fallback" ]; then
    PLUGIN_DIR="$_root/integrations/t3code-rivetos-memory"
    CAPTURE_DIR="$_fallback"
  fi
  unset _root _fallback
fi

if [ -z "${RIVETOS_ROOT:-}" ]; then
  RIVETOS_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd 2>/dev/null || echo /opt/rivetos)"
  export RIVETOS_ROOT
fi

CAPTURE_BUILT="$CAPTURE_DIR/dist/t3code-memory-capture.js"
CAPTURE_SRC="$CAPTURE_DIR/src/t3code-memory-capture.ts"

RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

LOG_DIR="${HOME}/.rivetos/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG_FILE="${LOG_DIR}/t3code-capture.log"

run_capture() {
  if [ -f "$CAPTURE_BUILT" ]; then
    node "$CAPTURE_BUILT" "$@"
  elif [ -f "$CAPTURE_SRC" ]; then
    if node --experimental-strip-types --help >/dev/null 2>&1; then
      node --experimental-strip-types "$CAPTURE_SRC" "$@"
    else
      npx --yes tsx "$CAPTURE_SRC" "$@"
    fi
  else
    echo "t3code-memory-capture: capture not found at $CAPTURE_BUILT or $CAPTURE_SRC" >&2
    return 0
  fi
}

case "${1:-}" in
  --watch)
    # detached sidecar beside `t3 service`: keep ticks out of the terminal
    run_capture "$@" >>"$LOG_FILE" 2>&1 || true
    ;;
  *)
    run_capture "$@" || true
    ;;
esac
exit 0
