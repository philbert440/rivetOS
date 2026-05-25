#!/usr/bin/env bash
# grok-memory-hook — fire a RivetOS capture ingest pass for a Grok session.
#
# This script is meant to be referenced from Grok's hooks configuration. It
# is a pure trigger: every lifecycle event (SessionStart, UserPromptSubmit,
# PostToolUse, Stop, PreCompact, SessionEnd, …) shells in here, and the
# capture worker reads the session's updates.jsonl from disk to figure out
# what actually changed (slice-by-count idempotency). It is extremely fast
# and best-effort: it always exits 0.
#
# Path discovery: respects $RIVETOS_ROOT (default /opt/rivetos). Prefers the
# built artifact at .../capture/dist/grok-memory-capture.js (produced by
# `npm run build` in the @rivetos/grok-rivet-memory-capture workspace). Falls
# back to running the .ts source via `npx --yes tsx` for ergonomics on
# unbuilt checkouts — the .js path is the supported production path.
#
# NOTE: The same dist/-vs-src/ decision exists in the capture's enqueue()
# function for the in-process worker re-exec. If you move dist/ or src/,
# update both this file and capture/src/grok-memory-capture.ts.

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
