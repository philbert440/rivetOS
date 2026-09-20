#!/usr/bin/env bash
# rivet-memory-hook — forward a Claude Code lifecycle-hook payload (on stdin)
# to the RivetOS capture handler.
#
# Capture is best-effort: this script ALWAYS exits 0 so that a capture failure
# can never disrupt the Claude Code session. The handler itself only spools the
# payload and detaches a worker, so this returns in single-digit milliseconds
# when a built checkout is present.
#
# Uses checkout hooks.js at $RIVETOS_ROOT / /opt/rivetos when available.
# Without a checkout, capture logs and skips.
# When ingest cannot run: FAIL LOUD on stderr, then exit 0.

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

_rivetos_hook_fail_loud() {
  echo "rivet-memory-hook: capture ingest cannot run: $1" >&2
}

# House / built checkout: same node (+ optional herdr) path as origin/main.
# Never call node when hooks.js is missing — that is a checkout-only binary.
if [ -f "$HOOK" ]; then
  if [ "${HERDR_ENV:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ] && [ -n "${HERDR_SOCKET_PATH:-}" ]; then
    PAYLOAD="$(cat)"
    printf '%s' "$PAYLOAD" | node "$RIVETOS_ROOT/integrations/shared/herdr-report-session.mjs" claude || true
    printf '%s' "$PAYLOAD" | node "$HOOK" || true
  else
    node "$HOOK" || true
  fi
  exit 0
fi

# No standalone capture entry is shipped. Use only shell builtins here:
# even an empty PATH and inherited errexit must not break the session.
_rivetos_hook_fail_loud "checkout capture handler unavailable; capture skipped"
exit 0
