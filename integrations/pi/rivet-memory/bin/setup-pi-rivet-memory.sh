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
#   --apply   Best-effort registration in mcp.json, skills copy, and AGENTS.md into
#             ~/.pi/agent (skips if already present unless --force). Pi has no
#             lifecycle hooks — capture is a watcher.
#   --force   With --apply, overwrite existing files.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-$(cd "$PLUGIN_DIR/../../.." && pwd)}"
PLUGIN_PATH="$RIVETOS_ROOT/integrations/pi/rivet-memory"

DO_LINK=0
DO_APPLY=0
DO_FORCE=0
for arg in "$@"; do
  case "$arg" in
    --link) DO_LINK=1 ;;
    --apply) DO_APPLY=1 ;;
    --force) DO_FORCE=1 ;;
    -h|--help)
      sed -n '2,22p' "$0"
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
  echo "⚠️  Capture worker not built. Watcher will fall back to npx tsx (slow cold path)."
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
echo "=== 4. Automatic Capture (watcher — pi has no hooks) ==="
echo "Run the v3 session jsonl watcher on the node that writes ~/.pi/agent/sessions:"
cat <<EOF

# One-shot ingest of existing sessions:
$PLUGIN_PATH/bin/pi-memory-capture.sh --backfill

# Long-running tail of ~/.pi/agent/sessions/<encoded-cwd>/*_<uuid>.jsonl
# (or a flat --session-dir):
$PLUGIN_PATH/bin/pi-memory-capture.sh --watch

# systemd user unit sketch:
# ExecStart=$PLUGIN_PATH/bin/pi-memory-capture.sh --watch
# Unit name: pi-memory-capture.service
# launchd label: dev.rivetos.pi-capture
EOF
echo
echo "The capture writes under agent='rivet-deepseek' channel='pi'."
echo "Logs: ~/.rivetos/pi-memory-capture.log"
echo "Doctor marker: ~/.rivetos/pi-capture-state.json (written by --watch)"

if [ "$DO_APPLY" -eq 1 ]; then
  echo
  echo "=== Applying config (--apply) ==="
  mkdir -p "$PI_HOME_DIR"

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
echo "4. (Recommended) run the capture watcher on the pi node"
echo "   rivetos plugins install --harness pi"
echo "5. Ensure the capture workspace is in root package.json + built"
echo "   (integrator: npm install --package-lock-only)"
echo "6. Test with a memory-stats or time-bounded recall question"
echo
echo "Done. Memory should now feel dramatically better in pi sessions."
