#!/usr/bin/env bash
# rivet-memory-hook — forward a Cursor lifecycle-hook payload (stdin JSON) to
# the RivetOS capture spool. Best-effort: ALWAYS exits 0 so capture never
# disrupts the Cursor session.
#
# Cursor events (hooks.json): beforeSubmitPrompt, postToolUse, stop,
# sessionEnd, afterAgentResponse, subagentStop.
#
# Until a dedicated Cursor capture worker lands in-tree, this spools the
# raw payload under ~/.rivetos/cursor-capture/ (not yet ingested).

umask 077

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

PAYLOAD="$(cat || true)"
TS="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%s)"

log_line() {
  # Diagnostics stay bounded on every path; one previous log is retained.
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -ge 1048576 ]; then
    mv -f -- "$LOG" "$LOG.1" 2>/dev/null || true
  fi
  printf '%s hook=%s %s\n' "$TS" "$HOOK_EVENT" "$1" >>"$LOG" 2>/dev/null || true
}

# Serialize creation and pruning so concurrent hooks share the same limits. The lock has a
# deadline: a stuck holder must not park every later hook until Cursor's timeout.
if command -v python3 >/dev/null 2>&1 && { mkdir -p "$SPOOL_DIR" && chmod 700 "$SPOOL_DIR"; } 2>/dev/null; then
  (
    flock -w 3 9 || exit 1
    SPOOL_FILE="$(mktemp --tmpdir="$SPOOL_DIR" XXXXXX.json)" || exit 1
    if {
      printf '%s\n' "{\"hook\":\"${HOOK_EVENT}\",\"ts\":\"${TS}\",\"payload\":"
      if [ -n "$PAYLOAD" ]; then printf '%s' "$PAYLOAD"; else printf '{}'; fi
      printf '}\n'
    } >"$SPOOL_FILE"; then
      # Bound the undrained spool by both count and bytes, oldest first.
      if python3 - "$SPOOL_DIR" <<'PYTHON'
import sys
from pathlib import Path
files = sorted((p for p in Path(sys.argv[1]).glob('*.json') if p.is_file()),
               key=lambda p: (p.stat().st_mtime_ns, p.name))
sizes = {p: p.stat().st_size for p in files}
total = sum(sizes.values())
while len(files) > 500 or total > 50 * 1024 * 1024:
    oldest = files.pop(0)
    oldest.unlink()
    total -= sizes[oldest]
PYTHON
      then
        log_line "spooled $SPOOL_FILE (not yet ingested; retention applied)"
      else
        # Retention could not be enforced: roll the new payload back so the bound holds.
        rm -f -- "$SPOOL_FILE"
        log_line "spool prune failed; payload discarded"
        exit 2
      fi
    else
      rm -f -- "$SPOOL_FILE"
      exit 1
    fi
  ) 9>"$SPOOL_DIR/.lock" 2>/dev/null || { [ "$?" -eq 2 ] || log_line "spool write failed"; }
else
  log_line "spool write failed"
fi

# Prefer a built Cursor capture worker when present (future). No npx from a hook:
# a network fetch can sit until Cursor's timeout, and the spool is the record.
CAPTURE_BUILT="$RIVETOS_ROOT/integrations/cursor/rivet-memory/capture/dist/cursor-memory-capture.js"
if [ -f "$CAPTURE_BUILT" ]; then
  printf '%s' "$PAYLOAD" | node "$CAPTURE_BUILT" --hook "$HOOK_EVENT" >>"$LOG" 2>&1 || true
fi

exit 0
