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
#   --apply   Copy plugin/rivet-memory.ts → $OPENCODE_CONFIG_HOME/plugins/
#             with PLUGIN_PATH rewritten; merge MCP into opencode.json; stop
#             and remove the old watcher unit/plist if present.
#   --remove  Delete the copied plugin file.
#   --force   With --apply, overwrite existing MCP / AGENTS.md / skills.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-$(cd "$PLUGIN_DIR/../../.." && pwd)}"
PLUGIN_PATH="$RIVETOS_ROOT/integrations/opencode/rivet-memory"

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
      sed -n '2,24p' "$0"
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
PLUGIN_DEST="$OPENCODE_CONFIG_HOME/plugins/rivet-memory.ts"

remove_old_watcher() {
  local unit="opencode-memory-capture.service"
  local label="dev.rivetos.opencode-capture"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop "$unit" 2>/dev/null || true
    systemctl --user disable "$unit" 2>/dev/null || true
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"
  if [ -f "$plist" ]; then
    if command -v launchctl >/dev/null 2>&1; then
      launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || \
        launchctl unload "$plist" 2>/dev/null || true
    fi
    rm -f "$plist"
  fi
  echo "Removed old capture watcher unit/plist if present ($unit / $label)"
}

stamp_hook_installed() {
  local state="${HOME}/.rivetos/opencode-capture-state.json"
  mkdir -p "$(dirname "$state")"
  node - "$state" <<'JS'
const fs = require('node:fs')
const file = process.argv[2]
let data = { version: 1, partTimeUpdated: 0, messageTimeUpdated: 0, sessions: {} }
if (fs.existsSync(file)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed
  } catch { /* keep default */ }
}
if (data.version !== 1) data.version = 1
if (typeof data.partTimeUpdated !== 'number') data.partTimeUpdated = 0
if (typeof data.messageTimeUpdated !== 'number') data.messageTimeUpdated = 0
data.hookInstalledAt = new Date().toISOString()
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
JS
}

install_plugin_copy() {
  local src="$PLUGIN_PATH/plugin/rivet-memory.ts"
  if [ ! -f "$src" ]; then
    echo "❌ Plugin source missing: $src"
    return 1
  fi
  mkdir -p "$(dirname "$PLUGIN_DEST")"
  node - "$src" "$PLUGIN_DEST" "$PLUGIN_PATH" <<'JS'
const fs = require('node:fs')
const src = process.argv[2]
const dest = process.argv[3]
const pluginPath = process.argv[4]
let text = fs.readFileSync(src, 'utf8')
const next = text.replace(
  /const PLUGIN_PATH = ["'][^"']*["']/,
  `const PLUGIN_PATH = ${JSON.stringify(pluginPath)}`,
)
if (!/const PLUGIN_PATH = /.test(next)) {
  console.log('⚠️  PLUGIN_PATH const not found in plugin source — copying unmodified')
}
if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === next) {
  console.log(`Plugin already installed at ${dest} (idempotent)`)
} else {
  fs.writeFileSync(dest, next)
  console.log(`✅ Copied plugin to ${dest} (PLUGIN_PATH=${pluginPath})`)
}
JS
}

if [ "$DO_REMOVE" -eq 1 ]; then
  echo "=== RivetOS + OpenCode rivet-memory --remove ==="
  if [ -f "$PLUGIN_DEST" ]; then
    rm -f "$PLUGIN_DEST"
    echo "✅ Deleted $PLUGIN_DEST"
  else
    echo "Plugin not present at $PLUGIN_DEST"
  fi
  exit 0
fi

echo "=== RivetOS + OpenCode rivet-memory Setup ==="
echo "Plugin directory: $PLUGIN_DIR"
echo "RivetOS root:     $RIVETOS_ROOT"
echo "OpenCode config:  $OPENCODE_CONFIG_HOME  (override with OPENCODE_CONFIG_DIR)"
echo "Plugin dest:      $PLUGIN_DEST"
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
  echo "⚠️  Capture worker not built. Plugin ingest will fall back to npx tsx (slow cold path)."
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
echo "=== 4. Automatic Capture (OpenCode plugin) ==="
echo "Copy plugin/rivet-memory.ts into $OPENCODE_CONFIG_HOME/plugins/"
echo "with PLUGIN_PATH rewritten to $PLUGIN_PATH."
echo "On session.idle (debounced 1.5s) / compacted / deleted / error the plugin"
echo "spawns: bash $PLUGIN_PATH/bin/opencode-memory-capture.sh --ingest-session <id>"
cat <<EOF

# One-shot catch-up of recent sessions (last 14 days):
$PLUGIN_PATH/bin/opencode-memory-capture.sh --backfill --days 14

# Status (last ingest time + counts):
$PLUGIN_PATH/bin/opencode-memory-capture.sh --status
EOF
echo
echo "The capture writes under agent='rivet-glm' channel='opencode'."
echo "Logs: ~/.rivetos/logs/opencode-capture.log"
echo "Cursor: ~/.rivetos/opencode-capture-state.json"

if [ "$DO_APPLY" -eq 1 ]; then
  echo
  echo "=== Applying config (--apply) ==="
  mkdir -p "$OPENCODE_CONFIG_HOME"

  install_plugin_copy
  remove_old_watcher
  stamp_hook_installed

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
echo "4. Confirm $PLUGIN_DEST is present (or re-run with --apply)"
echo "5. Optional one-shot: opencode-memory-capture.sh --backfill --days 14"
echo "6. Test with a memory-stats or time-bounded recall question"
echo
echo "Done. Memory should now feel dramatically better in OpenCode sessions."
