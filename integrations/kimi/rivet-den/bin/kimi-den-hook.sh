#!/usr/bin/env bash
# rivet-den hook for Kimi Code CLI — translate the lifecycle payload (stdin)
# into den protocol events and POST them to the den-server.
#
# The event name is passed as an argument as well as riding in the payload's
# hook_event_name, matching the sibling rivet-memory launcher: one less thing
# to go wrong if a future kimi release trims the payload.
#
# Best-effort: ALWAYS exits 0 so a den outage can never disrupt the session.
# (kimi only treats exit code 2 — or exit 0 plus a structured JSON deny on
# stdout — as a block; every other non-zero exit is fail-open. Exiting 0 keeps
# the den out of that decision entirely.)

# Executor-owned sessions (RivetOS task engine) emit den events themselves —
# the hook must stay quiet or every tool call gets double-reported.
if [ "${RIVETOS_DEN_HOOK_DISABLED:-}" = "1" ]; then
  exit 0
fi

RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  # the den-server PTY spawner injects RIVET_DEN_SESSION; a stale value in
  # the env file must not clobber the inherited one
  _den_session="${RIVET_DEN_SESSION-}"
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
  [ -n "$_den_session" ] && export RIVET_DEN_SESSION="$_den_session"
  unset _den_session
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/../hooks/kimi-den-hook.mjs" "${1:-}" || true
exit 0
