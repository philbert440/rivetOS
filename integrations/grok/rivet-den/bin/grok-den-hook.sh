#!/usr/bin/env bash
# rivet-den hook for Grok Build — reuses the canonical translator from the
# Claude Code plugin with the event name as an argument (grok payloads omit
# hook_event_name). Best-effort: ALWAYS exits 0.

RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

TRANSLATOR="$RIVETOS_ROOT/integrations/claude-code/rivet-den/hooks/den-hook.mjs"
[ -f "$TRANSLATOR" ] || exit 0

node "$TRANSLATOR" --harness grok-build "$1" || true
exit 0
