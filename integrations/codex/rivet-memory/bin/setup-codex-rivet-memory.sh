#!/usr/bin/env bash
#
# setup-codex-rivet-memory.sh
#
# One-stop helper to set up the rivet-memory integration for Codex CLI
# on a RivetOS host. All paths it prints are derived from $RIVETOS_ROOT so the
# snippets are copy-pasteable on hosts where RivetOS lives outside /opt/rivetos.
#
# Override with:
#   RIVETOS_ROOT=/my/install ./setup-codex-rivet-memory.sh
#
# Flags:
#   --link    Create symlinks for bin scripts into /usr/local/bin (uses sudo).
#   --apply   Best-effort registration in config.toml, skills copy, and AGENTS.md into
#             the detected Codex config home (skips if already present unless
#             --force). Codex has no lifecycle hooks — capture is a watcher.
#   --force   With --apply, overwrite existing files.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-$(cd "$PLUGIN_DIR/../../.." && pwd)}"
PLUGIN_PATH="$RIVETOS_ROOT/integrations/codex/rivet-memory"

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

detect_codex_home() {
  if [ -n "${CODEX_HOME:-}" ]; then
    echo "$CODEX_HOME"
    return
  fi
  echo "$HOME/.codex"
}

CODEX_HOME_DIR="$(detect_codex_home)"

echo "=== RivetOS + Codex rivet-memory Setup ==="
echo "Plugin directory: $PLUGIN_DIR"
echo "RivetOS root:     $RIVETOS_ROOT"
echo "Codex config home: $CODEX_HOME_DIR  (override with CODEX_HOME)"
echo

CLI="$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js"
if [ ! -f "$CLI" ]; then
  echo "❌ RivetOS MCP server not built."
  echo "   Please run: cd $RIVETOS_ROOT && npm install && npm run build"
  exit 1
fi
echo "✅ RivetOS MCP server found at $CLI"

CAPTURE_BUILT="$PLUGIN_PATH/capture/dist/codex-memory-capture.js"
if [ -f "$CAPTURE_BUILT" ]; then
  echo "✅ Capture worker built at $CAPTURE_BUILT"
else
  echo "⚠️  Capture worker not built. Watcher will fall back to npx tsx (slow cold path)."
  echo "   To build: cd $RIVETOS_ROOT && npm install && npm run build"
  echo "   (ensure workspaces includes integrations/codex/rivet-memory/capture)"
fi

echo
echo "=== 1. MCP Server Configuration ==="
echo "Codex reads MCP servers from $CODEX_HOME_DIR/config.toml."
cat <<EOF

# config.toml
[mcp_servers.rivetos]
command = "bash"
args = ["$PLUGIN_PATH/bin/rivet-memory-mcp.sh"]


EOF

echo
echo "=== 2. Skills Installation ==="
cat <<EOF

# Point extra skill dirs at the plugin, or copy:
mkdir -p $CODEX_HOME_DIR/skills
cp -r $PLUGIN_PATH/skills/* $CODEX_HOME_DIR/skills/
EOF

echo
echo "=== 3. Memory Discipline Reflex (CODEX.md) ==="
cat <<EOF

cp $PLUGIN_PATH/CODEX.md $CODEX_HOME_DIR/AGENTS.md
# or include CODEX.md content in your project AGENTS.md
EOF

echo
echo "=== 4. Automatic Capture (watcher — Codex has no hooks) ==="
echo "Run the rollout jsonl watcher on the node that writes ~/.codex/sessions:"
cat <<EOF

# One-shot ingest of existing rollouts:
$PLUGIN_PATH/bin/codex-memory-capture.sh --once

# Long-running tail of \$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl:
$PLUGIN_PATH/bin/codex-memory-capture.sh --watch

# systemd user unit sketch:
# ExecStart=$PLUGIN_PATH/bin/codex-memory-capture.sh --watch
EOF
echo
echo "The capture writes under agent='rivet-gpt' channel='codex'."
echo "Logs: ~/.rivetos/codex-memory-capture.log"

echo
echo "=== 5. Backfill existing sessions ==="
echo "$RIVETOS_ROOT/integrations/codex/rivet-memory/backfill (npm test / --dry-run / --write)"

if [ "$DO_APPLY" -eq 1 ]; then
  echo
  echo "=== Applying config (--apply) ==="
  mkdir -p "$CODEX_HOME_DIR"

  if ! command -v codex >/dev/null 2>&1; then
    echo "codex is required to register the MCP server in config.toml" >&2
    exit 1
  fi
  if codex mcp get rivetos >/dev/null 2>&1 && [ "$DO_FORCE" -ne 1 ]; then
    echo "RivetOS MCP registration already exists (use --force to replace it)"
  else
    codex mcp add rivetos -- bash "$PLUGIN_PATH/bin/rivet-memory-mcp.sh"
  fi

  AGENTS_DEST="$CODEX_HOME_DIR/AGENTS.md"
  if [ ! -f "$AGENTS_DEST" ] || [ "$DO_FORCE" -eq 1 ]; then
    cp "$PLUGIN_DIR/CODEX.md" "$AGENTS_DEST"
    echo "✅ Wrote $AGENTS_DEST"
  else
    echo "⚠️  $AGENTS_DEST exists (use --force to overwrite)"
  fi

  mkdir -p "$CODEX_HOME_DIR/skills"
  if [ -z "$(ls -A "$CODEX_HOME_DIR/skills" 2>/dev/null || true)" ] || [ "$DO_FORCE" -eq 1 ]; then
    cp -r "$PLUGIN_DIR/skills/." "$CODEX_HOME_DIR/skills/"
    echo "✅ Copied skills to $CODEX_HOME_DIR/skills/"
  else
    echo "⚠️  $CODEX_HOME_DIR/skills/ not empty"
  fi
fi

if [ "$DO_LINK" -eq 1 ]; then
  echo
  echo "=== Creating symlinks (requires sudo) ==="
  sudo ln -sf "$PLUGIN_DIR/bin/rivet-memory-mcp.sh" /usr/local/bin/rivet-memory-mcp || true
  sudo ln -sf "$PLUGIN_DIR/bin/codex-memory-capture.sh" /usr/local/bin/codex-memory-capture || true
  echo "Symlinks created in /usr/local/bin"
fi

echo
echo "=== Next Steps ==="
echo "1. Configure the MCP server ($CODEX_HOME_DIR/config.toml)"
echo "2. Install skills"
echo "3. Add CODEX.md / AGENTS.md reflex"
echo "4. (Recommended) run the capture watcher on the Codex node"
echo "5. Ensure capture + backfill workspaces are in root package.json + built"
echo "6. Test with a memory-stats or time-bounded recall question"
echo
echo "Done. Memory should now feel dramatically better in Codex sessions."
