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

# Den URL + CA before node, same discovery as bin/rivet-memory-mcp.sh
# (plugin lib/ first). A missing CA unsets RIVET_DEN_URL.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
_rivet_paths=""
for _rivet_candidate in \
  "$SCRIPT_DIR/../lib/rivet-paths.sh" \
  "$SCRIPT_DIR/../../../shared/rivet-paths.sh" \
  "${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/rivet-paths.sh"; do
  if [ -f "$_rivet_candidate" ]; then
    _rivet_paths="$_rivet_candidate"
    break
  fi
done
if [ -n "${_rivet_paths:-}" ]; then
  # shellcheck disable=SC1090
  . "$_rivet_paths"
  rivetos_resolve_den || true
else
  echo "rivet-memory-hook: rivet-paths.sh not found; den CA trust was not configured" >&2
fi
unset _rivet_paths _rivet_candidate

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
