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

# Rivet/phone: this is the on-device CLAUDE agent — file its captures under its own
# mesh identity (grok uses rivet-phone-grok). Authoritative over any inherited value.
export RIVETOS_CAPTURE_AGENT="rivet-phone-claude"

HOOK="$(cd "$(dirname "$0")" && pwd)/rivet-memory-hooks.mjs"
[ -f "$HOOK" ] || exit 0

# Durable offline outbox: persist the payload + replay when datahub is reachable, so captures
# made off-mesh aren't lost (the bundle's own spool is ephemeral). Falls back to a plain run.
if [ -r /opt/rivet-memory-offline.sh ]; then
  # shellcheck disable=SC1091
  . /opt/rivet-memory-offline.sh
  rivet_offline_run "$HOME/.rivetos/offline-spool/claude" node "$HOOK"
else
  node "$HOOK" || true
fi
exit 0
