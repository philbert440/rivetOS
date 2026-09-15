#!/usr/bin/env bash
# qwen-memory-capture — RivetOS memory ingest for Qwen Code CLI.
#
# Qwen lifecycle hooks (`UserPromptSubmit`, `Stop`, `SessionEnd`) invoke this
# launcher with `--hook` and one JSON object on stdin. `--hook` hands off to a
# detached `--ingest-file` child. Also supports `--ingest-file`,
# `--backfill [--days N]`, and `--status`.
#
# Best-effort: always exits 0 so the CLI is never blocked. In `--hook` mode
# stdout and stderr go to ~/.rivetos/logs/qwen-code-capture.log — never to Qwen.
#
# Path discovery: this script lives at .../rivet-memory/bin/. Prefers the
# built artifact at .../capture/dist/qwen-memory-capture.js. Falls back to
# running the .ts source via `npx --yes tsx` on unbuilt checkouts.
#
set -u

RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

SELF="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1; then
  RESOLVED="$(readlink -f "$SELF" 2>/dev/null || true)"
  if [ -n "${RESOLVED:-}" ]; then
    SELF="$RESOLVED"
  fi
fi
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -n "${RIVETOS_ROOT:-}" ] && [ -d "$RIVETOS_ROOT/integrations/qwen-code/rivet-memory/capture" ]; then
  CAPTURE_DIR="$RIVETOS_ROOT/integrations/qwen-code/rivet-memory/capture"
else
  CAPTURE_DIR="$PLUGIN_DIR/capture"
fi
CAPTURE_BUILT="$CAPTURE_DIR/dist/qwen-memory-capture.js"
CAPTURE_SRC="$CAPTURE_DIR/src/qwen-memory-capture.ts"

is_hook=0
for arg in "$@"; do
  if [ "$arg" = "--hook" ]; then
    is_hook=1
    break
  fi
done

run_capture() {
  if [ -f "$CAPTURE_BUILT" ]; then
    node "$CAPTURE_BUILT" "$@"
  elif [ -f "$CAPTURE_SRC" ]; then
    npx --yes tsx "$CAPTURE_SRC" "$@"
  else
    echo "qwen-memory-capture: capture not found at $CAPTURE_BUILT or $CAPTURE_SRC" >&2
    return 0
  fi
}

if [ "$is_hook" -eq 1 ]; then
  # Qwen parses hook stdout as control output; other stdout is added to
  # the model context. Never write to the hook's stdout/stderr; always exit 0.
  LOG_DIR="${HOME}/.rivetos/logs"
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  LOG_FILE="${LOG_DIR}/qwen-code-capture.log"
  run_capture "$@" >>"$LOG_FILE" 2>&1 || true
else
  run_capture "$@" || true
fi

exit 0
