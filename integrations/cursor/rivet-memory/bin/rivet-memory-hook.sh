#!/usr/bin/env bash
# rivet-memory-hook — forward a Cursor lifecycle-hook payload (stdin JSON) to
# the RivetOS capture spool. Best-effort: ALWAYS exits 0 so capture never
# disrupts the Cursor session.
#
# Cursor events (hooks.json): beforeSubmitPrompt, postToolUse, stop,
# sessionEnd, afterAgentResponse, subagentStop.
#
# Until a dedicated Cursor capture worker lands in-tree, this spools the
# raw payload under ~/.rivetos/cursor-capture/ and optionally appends a
# lightweight memory row via the sidecar CLI when RIVETOS_PG_URL is set.

RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
HOOK_EVENT="${1:-unknown}"
LOG="${HOME}/.rivetos/cursor-capture.log"
SPOOL_DIR="${HOME}/.rivetos/cursor-capture/spool"

if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

mkdir -p "$SPOOL_DIR" 2>/dev/null || true

PAYLOAD="$(cat || true)"
TS="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%s)"
SPOOL_FILE="${SPOOL_DIR}/${TS}-${HOOK_EVENT}-$$.json"

{
  printf '%s\n' "{\"hook\":\"${HOOK_EVENT}\",\"ts\":\"${TS}\",\"payload\":"
  if [ -n "$PAYLOAD" ]; then
    printf '%s' "$PAYLOAD"
  else
    printf '{}'
  fi
  printf '}\n'
} >"$SPOOL_FILE" 2>/dev/null || true

printf '%s hook=%s spool=%s bytes=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo now)" \
  "$HOOK_EVENT" \
  "$SPOOL_FILE" \
  "${#PAYLOAD}" >>"$LOG" 2>/dev/null || true

# Prefer a built Cursor capture worker when present (future).
CAPTURE_BUILT="$RIVETOS_ROOT/integrations/cursor/rivet-memory/capture/dist/cursor-memory-capture.js"
CAPTURE_SRC="$RIVETOS_ROOT/integrations/cursor/rivet-memory/capture/src/cursor-memory-capture.ts"
if [ -f "$CAPTURE_BUILT" ]; then
  printf '%s' "$PAYLOAD" | node "$CAPTURE_BUILT" --hook "$HOOK_EVENT" >>"$LOG" 2>&1 || true
elif [ -f "$CAPTURE_SRC" ]; then
  printf '%s' "$PAYLOAD" | npx --yes tsx "$CAPTURE_SRC" --hook "$HOOK_EVENT" >>"$LOG" 2>&1 || true
fi

exit 0
