#!/usr/bin/env bash
# codex-memory-capture — RivetOS memory ingest for Codex CLI.
#
# Codex lifecycle hooks (`UserPromptSubmit`, `Stop`, `SessionEnd`) invoke this
# launcher with `--hook` and one JSON object on stdin. Also supports
# `--ingest-file`, `--backfill [--days N]`, and `--status`.
#
# Best-effort: always exits 0 so the CLI is never blocked.
#
# Path discovery: this script lives at .../rivet-memory/bin/. Prefers the
# built artifact at .../capture/dist/codex-memory-capture.js. Falls back to
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

if [ -n "${RIVETOS_ROOT:-}" ] && [ -d "$RIVETOS_ROOT/integrations/codex/rivet-memory/capture" ]; then
  CAPTURE_DIR="$RIVETOS_ROOT/integrations/codex/rivet-memory/capture"
else
  CAPTURE_DIR="$PLUGIN_DIR/capture"
fi
CAPTURE_BUILT="$CAPTURE_DIR/dist/codex-memory-capture.js"
CAPTURE_SRC="$CAPTURE_DIR/src/codex-memory-capture.ts"

if [ -f "$CAPTURE_BUILT" ]; then
  node "$CAPTURE_BUILT" "$@" || true
elif [ -f "$CAPTURE_SRC" ]; then
  npx --yes tsx "$CAPTURE_SRC" "$@" || true
else
  echo "codex-memory-capture: capture not found at $CAPTURE_BUILT or $CAPTURE_SRC" >&2
fi

exit 0
