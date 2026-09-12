#!/usr/bin/env bash
#
# setup-opencode-rivet-memory.sh
#
# One-stop helper to set up the rivet-memory integration for OpenCode CLI
# on a RivetOS host. All paths it prints are derived from $RIVETOS_ROOT so the
# snippets are copy-pasteable on hosts where RivetOS lives outside /opt/rivetos.
#
# Override with:
#   RIVETOS_ROOT=/my/install ./setup-opencode-rivet-memory.sh
#
# Flags:
#   --link    Create symlinks for bin scripts into /usr/local/bin (uses sudo).
#   --apply   Best-effort registration in opencode.json, skills copy, and AGENTS.md
#             into the detected OpenCode config home (skips if already present unless
#             --force). OpenCode has no lifecycle hooks — capture is a watcher.
#   --force   With --apply, overwrite existing files.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-$(cd "$PLUGIN_DIR/../../.." && pwd)}"
PLUGIN_PATH="$RIVETOS_ROOT/integrations/opencode/rivet-memory"

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

detect_opencode_config_home() {
  if [ -n "${OPENCODE_CONFIG_DIR:-}" ]; then
    echo "$OPENCODE_CONFIG_DIR"
    return
  fi
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then
    echo "$XDG_CONFIG_HOME/opencode"
    return
  fi
  echo "$HOME/.config/opencode"
}

OPENCODE_CONFIG_HOME="$(detect_opencode_config_home)"

echo "=== RivetOS + OpenCode rivet-memory Setup ==="
echo "Plugin directory: $PLUGIN_DIR"
echo "RivetOS root:     $RIVETOS_ROOT"
echo "OpenCode config:  $OPENCODE_CONFIG_HOME  (override with OPENCODE_CONFIG_DIR)"
echo

CLI="$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js"
if [ ! -f "$CLI" ]; then
  echo "❌ RivetOS MCP server not built."
  echo "   Please run: cd $RIVETOS_ROOT && npm install && npm run build"
  exit 1
fi
echo "✅ RivetOS MCP server found at $CLI"

CAPTURE_BUILT="$PLUGIN_PATH/capture/dist/opencode-memory-capture.js"
if [ -f "$CAPTURE_BUILT" ]; then
  echo "✅ Capture worker built at $CAPTURE_BUILT"
else
  echo "⚠️  Capture worker not built. Watcher will fall back to npx tsx (slow cold path)."
  echo "   To build: cd $RIVETOS_ROOT && npm install && npm run build"
  echo "   (ensure workspaces includes integrations/opencode/rivet-memory/capture)"
fi

echo
echo "=== 1. MCP Server Configuration ==="
echo "OpenCode reads MCP servers from $OPENCODE_CONFIG_HOME/opencode.json."
cat <<EOF

# opencode.json
{
  "mcp": {
    "rivetos": {
      "type": "local",
      "command": ["bash", "$PLUGIN_PATH/bin/rivet-memory-mcp.sh"],
      "enabled": true
    }
  }
}

EOF

echo
echo "=== 2. Skills Installation ==="
cat <<EOF

# Copy skills into the OpenCode config home:
mkdir -p $OPENCODE_CONFIG_HOME/skills
cp -r $PLUGIN_PATH/skills/* $OPENCODE_CONFIG_HOME/skills/
EOF

echo
echo "=== 3. Memory Discipline Reflex (OPENCODE.md) ==="
cat <<EOF

cp $PLUGIN_PATH/OPENCODE.md $OPENCODE_CONFIG_HOME/AGENTS.md
# or include OPENCODE.md content in your project AGENTS.md
EOF

echo
echo "=== 4. Automatic Capture (watcher — OpenCode has no hooks) ==="
echo "Run the SQLite watcher on the node that writes opencode.db:"
cat <<EOF

# One-shot ingest of recent sessions (last 14 days):
$PLUGIN_PATH/bin/opencode-memory-capture.sh --once --backfill 14

# Long-running poll + WAL watch:
$PLUGIN_PATH/bin/opencode-memory-capture.sh --watch --backfill 14

# systemd user unit:
# ExecStart=$PLUGIN_PATH/bin/opencode-memory-capture.sh --watch
EOF
echo
echo "The capture writes under agent='rivet-glm' channel='opencode'."
echo "Logs: ~/.rivetos/opencode-memory-capture.log"
echo "Cursor: ~/.rivetos/opencode-capture-state.json"

if [ "$DO_APPLY" -eq 1 ]; then
  echo
  echo "=== Applying config (--apply) ==="
  mkdir -p "$OPENCODE_CONFIG_HOME"

  CFG="$OPENCODE_CONFIG_HOME/opencode.json"
  MCP_CMD="$PLUGIN_PATH/bin/rivet-memory-mcp.sh"
  node - "$CFG" "$MCP_CMD" "$DO_FORCE" <<'JS'
const fs = require('node:fs')
const cfgPath = process.argv[2]
const mcpCmd = process.argv[3]
const force = process.argv[4] === '1'
let data = {}
if (fs.existsSync(cfgPath)) {
  try {
    data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  } catch {
    console.log(`⚠️  ${cfgPath} is not plain JSON (JSONC?) — leaving it; writing mcp block skipped`)
    process.exit(0)
  }
}
if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
if (!data.mcp || typeof data.mcp !== 'object' || Array.isArray(data.mcp)) data.mcp = {}
if (data.mcp.rivetos && !force) {
  console.log('RivetOS MCP registration already exists (use --force to replace it)')
} else {
  data.mcp.rivetos = {
    type: 'local',
    command: ['bash', mcpCmd],
    enabled: true,
  }
  fs.writeFileSync(cfgPath, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`✅ Wrote MCP block to ${cfgPath}`)
}
JS

  AGENTS_DEST="$OPENCODE_CONFIG_HOME/AGENTS.md"
  if [ ! -f "$AGENTS_DEST" ] || [ "$DO_FORCE" -eq 1 ]; then
    cp "$PLUGIN_DIR/OPENCODE.md" "$AGENTS_DEST"
    echo "✅ Wrote $AGENTS_DEST"
  else
    echo "⚠️  $AGENTS_DEST exists (use --force to overwrite)"
  fi

  mkdir -p "$OPENCODE_CONFIG_HOME/skills"
  if [ -z "$(ls -A "$OPENCODE_CONFIG_HOME/skills" 2>/dev/null || true)" ] || [ "$DO_FORCE" -eq 1 ]; then
    cp -r "$PLUGIN_DIR/skills/." "$OPENCODE_CONFIG_HOME/skills/"
    echo "✅ Copied skills to $OPENCODE_CONFIG_HOME/skills/"
  else
    echo "⚠️  $OPENCODE_CONFIG_HOME/skills/ not empty"
  fi
fi

if [ "$DO_LINK" -eq 1 ]; then
  echo
  echo "=== Creating symlinks (requires sudo) ==="
  sudo ln -sf "$PLUGIN_DIR/bin/rivet-memory-mcp.sh" /usr/local/bin/rivet-memory-mcp || true
  sudo ln -sf "$PLUGIN_DIR/bin/opencode-memory-capture.sh" /usr/local/bin/opencode-memory-capture || true
  echo "Symlinks created in /usr/local/bin"
fi

echo
echo "=== Next Steps ==="
echo "1. Configure the MCP server ($OPENCODE_CONFIG_HOME/opencode.json)"
echo "2. Install skills"
echo "3. Add OPENCODE.md / AGENTS.md reflex"
echo "4. (Recommended) run the capture watcher on the OpenCode node"
echo "5. Ensure the capture workspace is in root package.json + built"
echo "6. Test with a memory-stats or time-bounded recall question"
echo
echo "Done. Memory should now feel dramatically better in OpenCode sessions."
