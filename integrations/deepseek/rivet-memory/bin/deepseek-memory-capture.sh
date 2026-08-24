#!/usr/bin/env bash
# Launch the DeepSeek Harness rivet-memory capture worker.
# Used by the Cordis plugin (live session/event) and by operators (backfill).
set -euo pipefail

RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
CAPTURE="$RIVETOS_ROOT/integrations/deepseek/rivet-memory/capture/deepseek-memory-capture.mjs"
if [ ! -f "$CAPTURE" ]; then
  # Shared checkout / worktree fallback
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CAPTURE="$(cd "$SCRIPT_DIR/../capture" && pwd)/deepseek-memory-capture.mjs"
fi

RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

exec node "$CAPTURE" "$@"
