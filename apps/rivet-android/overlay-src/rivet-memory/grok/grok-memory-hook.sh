#!/usr/bin/env bash
# grok-memory-hook — forward a Grok lifecycle-hook event to the bundled capture
# worker. Best-effort: always exits 0 so capture can never disrupt a session.
set -euo pipefail
RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  set -a; . "$RIVETOS_ENV" 2>/dev/null || true; set +a
fi
# Rivet/phone: on-device GROK agent identity (authoritative).
export RIVETOS_CAPTURE_AGENT="rivet-phone-grok"
CAPTURE_BUILT="$(cd "$(dirname "$0")" && pwd)/grok-memory-capture.mjs"
[ -f "$CAPTURE_BUILT" ] || exit 0
# Durable offline outbox (replay when datahub is reachable). The event arg is stored per entry,
# so a queued capture replays with its ORIGINAL event, not whatever fires on reconnect.
if [ -r /opt/rivet-memory-offline.sh ]; then
  # shellcheck disable=SC1091
  . /opt/rivet-memory-offline.sh
  rivet_offline_run "$HOME/.rivetos/offline-spool/grok" node "$CAPTURE_BUILT" --hook "${1:-unknown}"
else
  node "$CAPTURE_BUILT" --hook "${1:-unknown}" || true
fi
exit 0
