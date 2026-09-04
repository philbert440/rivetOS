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

# herdr pane identity: when this session runs inside a herdr pane, report the
# harness session id + transcript path to the pane over the session socket
# (the same env herdr's own integration hook keys on: HERDR_ENV=1,
# HERDR_SOCKET_PATH, HERDR_PANE_ID). stdin is captured once and replayed to
# both consumers ONLY in that case — off herdr the hook is byte-for-byte the
# old `node "$HOOK"`. Never fails the hook.
if [ "${HERDR_ENV:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ] && [ -n "${HERDR_SOCKET_PATH:-}" ]; then
  PAYLOAD="$(cat)"
  printf '%s' "$PAYLOAD" | node "$RIVETOS_ROOT/integrations/shared/herdr-report-session.mjs" claude || true
  printf '%s' "$PAYLOAD" | node "$HOOK" || true
else
  node "$HOOK" || true
fi
exit 0
