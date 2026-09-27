#!/usr/bin/env bash
# rivet-den hook for Cursor — reuses the canonical translator from the
# Claude Code plugin with harness=cursor. Best-effort: ALWAYS exits 0.

if [ "${RIVETOS_DEN_HOOK_DISABLED:-}" = "1" ]; then
  exit 0
fi

if [ -z "${RIVETOS_ROOT:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  RIVETOS_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd -P)"
  [ -f "$RIVETOS_ROOT/integrations/claude-code/rivet-den/hooks/den-hook.mjs" ] || RIVETOS_ROOT=/opt/rivetos
fi
RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [ -f "$RIVETOS_ENV" ]; then
  _den_session="${RIVET_DEN_SESSION-}"
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
  [ -n "$_den_session" ] && export RIVET_DEN_SESSION="$_den_session"
  unset _den_session
fi

TRANSLATOR="$RIVETOS_ROOT/integrations/claude-code/rivet-den/hooks/den-hook.mjs"
[ -f "$TRANSLATOR" ] || exit 0

CURSOR_EVENT="${1:-}"
PAYLOAD="$(cat || true)"

# With the workspace at $HOME, Cursor loads ~/.cursor/hooks.json twice and every event
# arrives twice. Payloads carry conversation/generation/tool ids, so an identical
# event + payload within the window is the same occurrence.
first_delivery() {
  local dir="$HOME/.rivetos/cursor-hook-seen/$1" key
  [ -n "$PAYLOAD" ] || return 0
  key="$(printf '%s\n%s' "$CURSOR_EVENT" "$PAYLOAD" | sha256sum 2>/dev/null)" || return 0
  key="${key%% *}"
  mkdir -p -m 700 "$dir" 2>/dev/null || return 0
  find "$dir" -mindepth 1 -maxdepth 1 -mmin +10 -exec rm -rf -- {} + 2>/dev/null
  mkdir "$dir/$key" 2>/dev/null || [ ! -d "$dir/$key" ]
}
first_delivery den || exit 0

# Map Cursor lifecycle names to Claude Code spellings the translator switch uses.
case "$CURSOR_EVENT" in
  sessionStart) EV=SessionStart ;;
  sessionEnd) EV=SessionEnd ;;
  beforeSubmitPrompt) EV=UserPromptSubmit ;;
  postToolUse) EV=PostToolUse ;;
  afterAgentResponse) EV=AfterAgentResponse ;;
  stop) EV=Stop ;;
  '') EV="" ;;
  *) EV="$CURSOR_EVENT" ;;
esac

printf '%s' "$PAYLOAD" | node "$TRANSLATOR" --harness cursor ${EV:+"$EV"} || true
exit 0
