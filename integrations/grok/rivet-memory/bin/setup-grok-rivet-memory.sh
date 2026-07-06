#!/usr/bin/env bash
#
# setup-grok-rivet-memory.sh
#
# One-stop helper to set up the rivet-memory integration for Grok Build
# on a RivetOS host. All paths it prints are derived from $RIVETOS_ROOT so the
# snippets are copy-pasteable on hosts where RivetOS lives outside /opt/rivetos.
#
# Override with:
#   RIVETOS_ROOT=/my/install ./setup-grok-rivet-memory.sh
#
# It will:
#   1. Verify RivetOS is built (and that the capture workspace is built)
#   2. Print exact config snippets for MCP, skills, capture hooks, and GROK.md
#   3. Optionally create symlinks for the bin scripts into /usr/local/bin (if run with --link;
#      this step calls `sudo` and will prompt for your password).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
PLUGIN_PATH="$RIVETOS_ROOT/integrations/grok/rivet-memory"

echo "=== RivetOS + Grok rivet-memory Setup ==="
echo "Plugin directory: $PLUGIN_DIR"
echo "RivetOS root:     $RIVETOS_ROOT"
echo

# 1. Check build
CLI="$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js"
# pre-unification fallback (older checkouts still ship the shim path)
if [ ! -f "$CLI" ]; then
  CLI="$RIVETOS_ROOT/plugins/transports/mcp-server/dist/cli.js"
fi
if [ ! -f "$CLI" ]; then
  echo "❌ RivetOS MCP server not built."
  echo "   Please run: cd $RIVETOS_ROOT && npm install && npm run build"
  exit 1
fi
echo "✅ RivetOS MCP server found at $CLI"

CAPTURE_BUILT="$PLUGIN_PATH/capture/dist/grok-memory-capture.js"
if [ -f "$CAPTURE_BUILT" ]; then
  echo "✅ Capture worker built at $CAPTURE_BUILT"
else
  echo "⚠️  Capture worker not built. Hook will fall back to npx tsx on each fire (slow cold path)."
  echo "   To build: cd $RIVETOS_ROOT && npm install && npm run build"
fi

# 2. MCP Server recommendation
echo
echo "=== 1. MCP Server Configuration ==="
echo "Add this to your ~/.grok/config.toml (recommended) or project .mcp.json:"
cat <<EOF

[mcp_servers.rivetos]
command = "$PLUGIN_PATH/bin/rivet-memory-mcp.sh"

# Or invoke the MCP server directly:
# command = "$CLI"
# args = ["--stdio"]
EOF

echo
echo "Then restart Grok or run: /mcps reload"

# 3. Skills
echo
echo "=== 2. Skills Installation ==="
echo "Copy the skills into your Grok skills directory:"
cat <<EOF

# Project scope (recommended)
cp -r $PLUGIN_PATH/skills/* .grok/skills/

# Or global
cp -r $PLUGIN_PATH/skills/* ~/.grok/skills/
EOF

# 4. Reflex
echo
echo "=== 3. Memory Discipline Reflex (GROK.md) ==="
echo "Copy GROK.md into your rules so the discipline is always active."
echo "Grok Build reads ~/.grok/AGENTS.md as the always-on rules file (per the"
echo "vendor-neutral AGENTS.md convention), so we copy GROK.md to that path:"
cat <<EOF

cp $PLUGIN_PATH/GROK.md ~/.grok/AGENTS.md
# or include its content in your main project rules / global config
EOF

# 5. Capture (optional but recommended)
echo
echo "=== 4. Automatic Capture (Optional but High Value) ==="
echo "To automatically save Grok turns, tool calls, and pre-compaction into memory,"
echo "drop the example hook file into Grok's hooks directory (~/.grok/hooks/, NOT"
echo "~/.grok/config.toml — hooks are loaded from JSON files in the hooks dir):"
echo
cat <<EOF
mkdir -p ~/.grok/hooks
cp $PLUGIN_PATH/hooks/hooks.json ~/.grok/hooks/rivet-memory.json
EOF
echo
echo "The shipped hooks.json wires 7 events (SessionStart, SessionEnd, UserPromptSubmit,"
echo "PostToolUse, PostToolUseFailure, Stop, PreCompact). The most important for capture"
echo "richness is PreCompact — it preserves messages about to be summarized away."
echo
echo "For a minimal install, only PreCompact + Stop are needed. Edit the JSON to"
echo "remove events you don't want before copying."

echo
echo "The capture writes under agent='rivet-grok' and is best-effort (never blocks Grok)."

# 6. Commands (slash commands)
echo
echo "=== 5. Quick Commands ==="
echo "The commands/ directory provides /memory-recall, /memory-today, etc."
echo "These are available as skills. You can also reference them explicitly."

# 7. Optional symlinks
if [[ "${1:-}" == "--link" ]]; then
  echo
  echo "=== Creating symlinks (requires sudo) ==="
  echo "You will be prompted for your password to write to /usr/local/bin."
  sudo ln -sf "$PLUGIN_DIR/bin/rivet-memory-mcp.sh" /usr/local/bin/rivet-memory-mcp || true
  sudo ln -sf "$PLUGIN_DIR/bin/grok-memory-hook.sh" /usr/local/bin/grok-memory-hook || true
  echo "Symlinks created in /usr/local/bin"
fi

echo
echo "=== Next Steps ==="
echo "1. Configure the MCP server in your Grok config"
echo "2. Copy the skills"
echo "3. Add GROK.md to your rules"
echo "4. (Recommended) Wire up the capture hooks"
echo "5. Test with: /memory-stats or a time-bounded recall question"
echo
echo "Done. Memory should now feel dramatically better in Grok sessions."
