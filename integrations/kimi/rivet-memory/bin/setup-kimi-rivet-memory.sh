#!/usr/bin/env bash
#
# setup-kimi-rivet-memory.sh
#
# One-stop helper to set up the rivet-memory integration for Kimi Code CLI
# on a RivetOS host. All paths it prints are derived from $RIVETOS_ROOT so the
# snippets are copy-pasteable on hosts where RivetOS lives outside /opt/rivetos.
#
# Override with:
#   RIVETOS_ROOT=/my/install ./setup-kimi-rivet-memory.sh
#
# Flags:
#   --link    Create symlinks for bin scripts into /usr/local/bin (uses sudo).
#   --apply   Best-effort write of mcp.json, skills link, AGENTS.md, and hooks
#             fragment into the detected kimi config home (skips if already present
#             unless --force). Empirical config-home detection is best-effort.
#   --force   With --apply, overwrite existing files.
#
# It will:
#   1. Verify RivetOS is built (and that the capture workspace is built)
#   2. Detect kimi config home (KIMI_CODE_HOME → ~/.kimi-code → ~/.kimi)
#   3. Print exact config snippets for MCP, skills, capture hooks, and KIMI.md
#   4. Optionally apply them (--apply) and/or link bins (--link)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
PLUGIN_PATH="$RIVETOS_ROOT/integrations/kimi/rivet-memory"

DO_LINK=0
DO_APPLY=0
DO_FORCE=0
for arg in "$@"; do
  case "$arg" in
    --link) DO_LINK=1 ;;
    --apply) DO_APPLY=1 ;;
    --force) DO_FORCE=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Detect kimi config home (constants — easy to adjust after live verify)
# ---------------------------------------------------------------------------
detect_kimi_home() {
  if [ -n "${KIMI_CODE_HOME:-}" ] && [ -d "$KIMI_CODE_HOME" ]; then
    echo "$KIMI_CODE_HOME"
    return
  fi
  if [ -n "${KIMI_CODE_HOME:-}" ]; then
    echo "$KIMI_CODE_HOME"
    return
  fi
  if [ -d "$HOME/.kimi-code" ]; then
    echo "$HOME/.kimi-code"
    return
  fi
  if [ -d "$HOME/.kimi" ]; then
    echo "$HOME/.kimi"
    return
  fi
  # Prefer the new name if nothing exists yet
  echo "$HOME/.kimi-code"
}

KIMI_HOME="$(detect_kimi_home)"

echo "=== RivetOS + Kimi rivet-memory Setup ==="
echo "Plugin directory: $PLUGIN_DIR"
echo "RivetOS root:     $RIVETOS_ROOT"
echo "Kimi config home: $KIMI_HOME  (override with KIMI_CODE_HOME)"
echo

# 1. Check build
CLI="$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js"
if [ ! -f "$CLI" ]; then
  CLI="$RIVETOS_ROOT/plugins/transports/mcp-server/dist/cli.js"
fi
if [ ! -f "$CLI" ]; then
  echo "❌ RivetOS MCP server not built."
  echo "   Please run: cd $RIVETOS_ROOT && npm install && npm run build"
  exit 1
fi
echo "✅ RivetOS MCP server found at $CLI"

CAPTURE_BUILT="$PLUGIN_PATH/capture/dist/kimi-memory-capture.js"
if [ -f "$CAPTURE_BUILT" ]; then
  echo "✅ Capture worker built at $CAPTURE_BUILT"
else
  echo "⚠️  Capture worker not built. Hook will fall back to npx tsx on each fire (slow cold path)."
  echo "   To build: cd $RIVETOS_ROOT && npm install && npm run build"
  echo "   (ensure workspaces includes integrations/kimi/rivet-memory/capture)"
fi

# 2. MCP Server
echo
echo "=== 1. MCP Server Configuration ==="
echo "Write this to $KIMI_HOME/mcp.json (Claude-style MCP config):"
cat <<EOF

{
  "mcpServers": {
    "rivetos": {
      "command": "$PLUGIN_PATH/bin/rivet-memory-mcp.sh"
    }
  }
}
EOF

# 3. Skills
echo
echo "=== 2. Skills Installation ==="
echo "Preferred: point extra_skill_dirs at the plugin skills directory."
cat <<EOF

# In $KIMI_HOME/config.toml (or project config):
extra_skill_dirs = ["$PLUGIN_PATH/skills"]

# Or copy:
mkdir -p $KIMI_HOME/skills
cp -r $PLUGIN_PATH/skills/* $KIMI_HOME/skills/
EOF

# 4. Reflex
echo
echo "=== 3. Memory Discipline Reflex (KIMI.md) ==="
echo "If kimi-code reads AGENTS.md (vendor-neutral always-on rules), copy:"
cat <<EOF

cp $PLUGIN_PATH/KIMI.md $KIMI_HOME/AGENTS.md
# or include KIMI.md content in your main project rules / global config
EOF

# 5. Capture hooks
echo
echo "=== 4. Automatic Capture (Optional but High Value) ==="
echo "Append the TOML fragment from hooks/hooks.toml into $KIMI_HOME/config.toml."
echo "Wired events: SessionStart, SessionEnd, UserPromptSubmit, PostToolUse,"
echo "PostToolUseFailure, Stop, PreCompact (timeout 8s each)."
echo
cat <<EOF
# Example single entry:
[[hooks]]
event = "PreCompact"
command = "$PLUGIN_PATH/bin/kimi-memory-hook.sh PreCompact"
timeout = 8

# Full fragment:
cat $PLUGIN_PATH/hooks/hooks.toml >> $KIMI_HOME/config.toml
EOF
echo
echo "The capture writes under agent='rivet-kimi' and is best-effort (never blocks Kimi)."
echo "Logs: ~/.rivetos/kimi-memory-capture.log"

# 6. Commands
echo
echo "=== 5. Quick Commands ==="
echo "The commands/ directory provides /memory-recall, /memory-today, etc."
echo "These are available as skills. You can also reference them explicitly."

# 7. Optional apply
if [ "$DO_APPLY" -eq 1 ]; then
  echo
  echo "=== Applying config (--apply) ==="
  mkdir -p "$KIMI_HOME"

  MCP_DEST="$KIMI_HOME/mcp.json"
  if [ ! -f "$MCP_DEST" ] || [ "$DO_FORCE" -eq 1 ]; then
    cat > "$MCP_DEST" <<EOF
{
  "mcpServers": {
    "rivetos": {
      "command": "$PLUGIN_PATH/bin/rivet-memory-mcp.sh"
    }
  }
}
EOF
    echo "✅ Wrote $MCP_DEST"
  else
    echo "⚠️  $MCP_DEST exists (use --force to overwrite)"
  fi

  AGENTS_DEST="$KIMI_HOME/AGENTS.md"
  if [ ! -f "$AGENTS_DEST" ] || [ "$DO_FORCE" -eq 1 ]; then
    cp "$PLUGIN_DIR/KIMI.md" "$AGENTS_DEST"
    echo "✅ Wrote $AGENTS_DEST"
  else
    echo "⚠️  $AGENTS_DEST exists (use --force to overwrite)"
  fi

  # Append hooks fragment if not already present
  CONFIG_TOML="$KIMI_HOME/config.toml"
  HOOK_MARKER="kimi-memory-hook.sh"
  if [ -f "$CONFIG_TOML" ] && grep -q "$HOOK_MARKER" "$CONFIG_TOML" 2>/dev/null; then
    echo "⚠️  Hooks already present in $CONFIG_TOML"
  else
    {
      echo ""
      echo "# --- rivet-memory capture hooks (auto-appended by setup-kimi-rivet-memory.sh) ---"
      # Rewrite command paths to absolute PLUGIN_PATH
      sed "s|\${RIVETOS_ROOT:-/opt/rivetos}|$RIVETOS_ROOT|g; s|/opt/rivetos|$RIVETOS_ROOT|g" \
        "$PLUGIN_DIR/hooks/hooks.toml"
    } >> "$CONFIG_TOML"
    echo "✅ Appended hooks to $CONFIG_TOML"
  fi

  # skills: prefer extra_skill_dirs note; also copy if skills dir empty
  mkdir -p "$KIMI_HOME/skills"
  if [ -z "$(ls -A "$KIMI_HOME/skills" 2>/dev/null || true)" ] || [ "$DO_FORCE" -eq 1 ]; then
    cp -r "$PLUGIN_DIR/skills/." "$KIMI_HOME/skills/"
    echo "✅ Copied skills to $KIMI_HOME/skills/"
  else
    echo "⚠️  $KIMI_HOME/skills/ not empty; prefer extra_skill_dirs in config.toml"
  fi
fi

# 8. Optional symlinks
if [ "$DO_LINK" -eq 1 ]; then
  echo
  echo "=== Creating symlinks (requires sudo) ==="
  echo "You will be prompted for your password to write to /usr/local/bin."
  sudo ln -sf "$PLUGIN_DIR/bin/rivet-memory-mcp.sh" /usr/local/bin/rivet-memory-mcp || true
  sudo ln -sf "$PLUGIN_DIR/bin/kimi-memory-hook.sh" /usr/local/bin/kimi-memory-hook || true
  echo "Symlinks created in /usr/local/bin"
fi

echo
echo "=== Next Steps ==="
echo "1. Configure the MCP server ($KIMI_HOME/mcp.json)"
echo "2. Install skills (extra_skill_dirs or copy)"
echo "3. Add KIMI.md / AGENTS.md reflex"
echo "4. (Recommended) Wire capture hooks into config.toml"
echo "5. Ensure capture workspace is in root package.json workspaces + built"
echo "6. Test with a memory-stats or time-bounded recall question"
echo
echo "Done. Memory should now feel dramatically better in Kimi sessions."
