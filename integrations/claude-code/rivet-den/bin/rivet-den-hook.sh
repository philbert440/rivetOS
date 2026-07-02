#!/usr/bin/env bash
# rivet-den hook — translate the Claude Code lifecycle payload (stdin) into
# den protocol events and POST them to the den-server.
#
# Best-effort: ALWAYS exits 0 so a den outage can never disrupt the session.

RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/../hooks/den-hook.mjs" || true
exit 0
