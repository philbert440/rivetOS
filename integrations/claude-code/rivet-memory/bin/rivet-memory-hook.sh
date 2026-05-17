#!/usr/bin/env bash
# rivet-memory-hook — forward a Claude Code lifecycle-hook payload (on stdin)
# to the RivetOS capture handler.
#
# Capture is best-effort: this script ALWAYS exits 0 so that a capture failure
# can never disrupt the Claude Code session. The handler itself only spools the
# payload and detaches a worker, so this returns in single-digit milliseconds.

# RivetOS install root — override with RIVETOS_ROOT if installed elsewhere.
RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
# Env file holding RIVETOS_PG_URL / RIVETOS_EMBED_URL (the worker writes to PG).
RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"

if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

HOOK="$RIVETOS_ROOT/plugins/providers/claude-cli/dist/hooks.js"
[ -f "$HOOK" ] || exit 0

node "$HOOK" || true
exit 0
