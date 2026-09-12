#!/usr/bin/env bash
#
# setup-pi-rivet-memory.sh
#
# One-stop helper to set up the rivet-memory integration for the pi CLI
# on a RivetOS host. All paths it prints are derived from $RIVETOS_ROOT so the
# snippets are copy-pasteable on hosts where RivetOS lives outside /opt/rivetos.
#
# Override with:
#   RIVETOS_ROOT=/my/install ./setup-pi-rivet-memory.sh
#
# Flags:
#   --link    Create symlinks for bin scripts into /usr/local/bin (uses sudo).
#   --apply   Register the pi extension, mcp.json merge, skills, AGENTS.md.
#             Idempotent. Migrates off the old capture watcher unit/plist.
#   --remove  Delete ~/.pi/agent/extensions/rivet-memory.ts (our file only).
#   --force   With --apply, overwrite existing mcp.json / AGENTS.md / skills.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-$(cd "$PLUGIN_DIR/../../.." && pwd)}"
PLUGIN_PATH="$PLUGIN_DIR"

DO_LINK=0
DO_APPLY=0
DO_FORCE=0
DO_REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --link) DO_LINK=1 ;;
    --apply) DO_APPLY=1 ;;
    --force) DO_FORCE=1 ;;
    --remove) DO_REMOVE=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

detect_pi_home() {
  if [ -n "${PI_AGENT_HOME:-}" ]; then
    echo "$PI_AGENT_HOME"
    return
  fi
  echo "$HOME/.pi/agent"
}

PI_HOME_DIR="$(detect_pi_home)"
EXT_SRC="$PLUGIN_DIR/extension/rivet-memory.ts"
EXT_DEST="$PI_HOME_DIR/extensions/rivet-memory.ts"
EXT_MARKER="rivet-memory pi extension"

echo "=== RivetOS + pi rivet-memory Setup ==="
echo "Plugin directory: $PLUGIN_DIR"
echo "RivetOS root:     $RIVETOS_ROOT"
echo "pi config home:   $PI_HOME_DIR  (override with PI_AGENT_HOME)"
echo

CLI="$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js"
if [ ! -f "$CLI" ]; then
  echo "❌ RivetOS MCP server not built."
  echo "   Please run: cd $RIVETOS_ROOT && npm install && npm run build"
  exit 1
fi
echo "✅ RivetOS MCP server found at $CLI"

CAPTURE_BUILT="$PLUGIN_PATH/capture/dist/pi-memory-capture.js"
if [ -f "$CAPTURE_BUILT" ]; then
  echo "✅ Capture worker built at $CAPTURE_BUILT"
else
  echo "⚠️  Capture worker not built. Extension ingest will fall back to npx tsx (slow cold path)."
  echo "   To build: cd $RIVETOS_ROOT && npm install && npm run build"
  echo "   (ensure workspaces includes integrations/pi/rivet-memory/capture)"
fi

echo
echo "=== 1. MCP Server Configuration ==="
echo "Write $PI_HOME_DIR/mcp.json so pi (or a future plugin loader) can reach RivetOS memory."
cat <<EOF

# mcp.json
{
  "mcpServers": {
    "rivetos": {
      "command": "bash",
      "args": ["$PLUGIN_PATH/bin/rivet-memory-mcp.sh"]
    }
  }
}

EOF

echo
echo "=== 2. Skills Installation ==="
cat <<EOF

mkdir -p $PI_HOME_DIR/skills
cp -r $PLUGIN_PATH/skills/* $PI_HOME_DIR/skills/
EOF

echo
echo "=== 3. Memory Discipline Reflex (PI.md) ==="
cat <<EOF

cp $PLUGIN_PATH/PI.md $PI_HOME_DIR/AGENTS.md
# or include PI.md content in your project AGENTS.md
EOF

echo
echo "=== 4. Automatic Capture (pi extension) ==="
echo "Copy extension/rivet-memory.ts → $PI_HOME_DIR/extensions/rivet-memory.ts"
echo "with PLUGIN_PATH rewritten to $PLUGIN_PATH."
echo "On turn_end / agent_end (debounced 1.5s) and session_shutdown /"
echo "session_before_switch / session_info_changed (flush) the extension"
echo "spawns: bash $PLUGIN_PATH/bin/pi-memory-capture.sh --ingest-file <session.jsonl>"
cat <<EOF

# One-shot ingest of existing sessions (optional):
$PLUGIN_PATH/bin/pi-memory-capture.sh --backfill
$PLUGIN_PATH/bin/pi-memory-capture.sh --backfill --days 14

# Status (last ingest time + counts):
$PLUGIN_PATH/bin/pi-memory-capture.sh --status
EOF
echo
echo "The capture writes under agent='rivet-deepseek' channel='pi'."
echo "Logs: ~/.rivetos/logs/pi-capture.log"
echo "Doctor marker: ~/.rivetos/pi-capture-state.json"
echo "Native registration: $EXT_DEST"

stop_old_watcher() {
  echo
  echo "=== Migrating off capture watcher ==="
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop pi-memory-capture.service 2>/dev/null || true
    systemctl --user disable pi-memory-capture.service 2>/dev/null || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/pi-memory-capture.service"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "Stopped/disabled/removed pi-memory-capture.service (user unit) if present"
  fi
  if command -v launchctl >/dev/null 2>&1; then
    local plist="$HOME/Library/LaunchAgents/dev.rivetos.pi-capture.plist"
    if [ -f "$plist" ]; then
      launchctl bootout "gui/$(id -u)/dev.rivetos.pi-capture" 2>/dev/null || \
        launchctl unload "$plist" 2>/dev/null || true
      rm -f "$plist"
      echo "Unloaded/removed $plist"
    else
      echo "No launchd plist at $plist"
    fi
  fi
}

install_extension() {
  mkdir -p "$PI_HOME_DIR/extensions"
  if [ ! -f "$EXT_SRC" ]; then
    echo "❌ Extension source missing: $EXT_SRC"
    return 1
  fi
  if [ -f "$EXT_DEST" ] && ! grep -q "$EXT_MARKER" "$EXT_DEST" 2>/dev/null && ! grep -q 'const PLUGIN_PATH' "$EXT_DEST" 2>/dev/null; then
    echo "Refusing to overwrite $EXT_DEST (not our extension). Use a different name."
    return 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$EXT_SRC" "$EXT_DEST" "$PLUGIN_PATH" <<'PY'
import json, pathlib, re, sys
src, dest, plugin = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(src).read_text(encoding="utf-8")
new, n = re.subn(
    r"^const PLUGIN_PATH = .*",
    "const PLUGIN_PATH = " + json.dumps(plugin),
    text,
    count=1,
    flags=re.M,
)
if n != 1:
    raise SystemExit("PLUGIN_PATH assignment not found in extension source")
pathlib.Path(dest).write_text(new, encoding="utf-8")
PY
  else
    local escaped
    escaped=$(printf '%s' "$PLUGIN_PATH" | sed 's/[\\&|]/\\&/g')
    sed "s|^const PLUGIN_PATH = \".*\"|const PLUGIN_PATH = \"${escaped}\"|" "$EXT_SRC" > "$EXT_DEST"
  fi
  echo "✅ Installed pi extension: $EXT_DEST"
  echo "   PLUGIN_PATH=$PLUGIN_PATH"
}

stamp_hook_installed() {
  local state="$HOME/.rivetos/pi-capture-state.json"
  mkdir -p "$HOME/.rivetos"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$state" <<'PY'
import json, os, sys
from datetime import datetime, timezone
path = sys.argv[1]
data = {}
if os.path.isfile(path):
    try:
        with open(path, encoding="utf-8") as f:
            parsed = json.load(f)
        if isinstance(parsed, dict):
            data = parsed
    except Exception:
        data = {}
data["hookInstalledAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f)
    f.write("\n")
PY
    echo "✅ Recorded hookInstalledAt in $state"
  else
    echo "⚠️  python3 not found; skipped hookInstalledAt stamp"
  fi
}

if [ "$DO_REMOVE" -eq 1 ]; then
  echo
  echo "=== Removing pi extension (--remove) ==="
  if [ -f "$EXT_DEST" ]; then
    if grep -q "$EXT_MARKER" "$EXT_DEST" 2>/dev/null || grep -q 'const PLUGIN_PATH' "$EXT_DEST" 2>/dev/null; then
      rm -f "$EXT_DEST"
      echo "✅ Deleted $EXT_DEST"
    else
      echo "Refusing to delete $EXT_DEST (not our extension)"
    fi
  else
    echo "No extension at $EXT_DEST"
  fi
fi

if [ "$DO_APPLY" -eq 1 ]; then
  echo
  echo "=== Applying config (--apply) ==="
  mkdir -p "$PI_HOME_DIR"

  install_extension
  stop_old_watcher
  stamp_hook_installed

  MCP_DEST="$PI_HOME_DIR/mcp.json"
  if [ ! -f "$MCP_DEST" ] || [ "$DO_FORCE" -eq 1 ]; then
    cat > "$MCP_DEST" <<EOF
{
  "mcpServers": {
    "rivetos": {
      "command": "bash",
      "args": ["$PLUGIN_PATH/bin/rivet-memory-mcp.sh"]
    }
  }
}
EOF
    echo "✅ Wrote $MCP_DEST"
  else
    if grep -q '"rivetos"' "$MCP_DEST" 2>/dev/null; then
      echo "RivetOS MCP registration already exists in $MCP_DEST (use --force to replace it)"
    else
      echo "⚠️  $MCP_DEST exists without rivetos (use --force to overwrite)"
    fi
  fi

  AGENTS_DEST="$PI_HOME_DIR/AGENTS.md"
  if [ ! -f "$AGENTS_DEST" ] || [ "$DO_FORCE" -eq 1 ]; then
    cp "$PLUGIN_DIR/PI.md" "$AGENTS_DEST"
    echo "✅ Wrote $AGENTS_DEST"
  else
    echo "⚠️  $AGENTS_DEST exists (use --force to overwrite)"
  fi

  mkdir -p "$PI_HOME_DIR/skills"
  if [ -z "$(ls -A "$PI_HOME_DIR/skills" 2>/dev/null || true)" ] || [ "$DO_FORCE" -eq 1 ]; then
    cp -r "$PLUGIN_DIR/skills/." "$PI_HOME_DIR/skills/"
    echo "✅ Copied skills to $PI_HOME_DIR/skills/"
  else
    echo "⚠️  $PI_HOME_DIR/skills/ not empty"
  fi
fi

if [ "$DO_LINK" -eq 1 ]; then
  echo
  echo "=== Creating symlinks (requires sudo) ==="
  sudo ln -sf "$PLUGIN_DIR/bin/rivet-memory-mcp.sh" /usr/local/bin/rivet-memory-mcp || true
  sudo ln -sf "$PLUGIN_DIR/bin/pi-memory-capture.sh" /usr/local/bin/pi-memory-capture || true
  echo "Symlinks created in /usr/local/bin"
fi

echo
echo "=== Next Steps ==="
echo "1. Configure the MCP server ($PI_HOME_DIR/mcp.json)"
echo "2. Install skills"
echo "3. Add PI.md / AGENTS.md reflex"
echo "4. Register the capture extension:"
echo "   $PLUGIN_PATH/bin/setup-pi-rivet-memory.sh --apply"
echo "   (or: rivetos plugins install --harness pi)"
echo "5. Optional one-shot of existing sessions:"
echo "   $PLUGIN_PATH/bin/pi-memory-capture.sh --backfill"
echo "6. Ensure the capture workspace is in root package.json + built"
echo "   (integrator: npm install --package-lock-only)"
echo "7. Test with a memory-stats or time-bounded recall question"
echo
echo "Done. Memory should now feel dramatically better in pi sessions."
