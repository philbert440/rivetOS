#!/usr/bin/env bash
#
# setup-cursor-rivet-memory.sh
#
# Install RivetOS memory into ~/.cursor for Cursor IDE/CLI.
#
# The plugin carries the MCP server, hooks, skills, rules, and agent. This
# script links it under ~/.cursor/plugins/local/, copies AGENT.md/MEMORY.md,
# and removes legacy global wiring (hooks.json entries, mcp.json server,
# skill symlinks) that points into this kit so nothing fires twice.
#
# Flags:
#   --apply   Perform the install (default is a dry run)
#   -h|--help Show this header
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

CURSOR_HOME="${CURSOR_HOME:-$HOME/.cursor}"
DO_APPLY=0

for arg in "$@"; do
  case "$arg" in
    --apply) DO_APPLY=1 ;;
    --force) ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
  esac
done

echo "=== RivetOS + Cursor rivet-memory Setup ==="
echo "Plugin directory: $PLUGIN_DIR"
echo "Cursor home:      $CURSOR_HOME"
echo

if [ "$DO_APPLY" -ne 1 ]; then
  cat <<EOF
Dry run (pass --apply to install).

Will:
  cp AGENT.md -> $CURSOR_HOME/AGENT.md
  cp MEMORY.md -> $CURSOR_HOME/MEMORY.md
  symlink plugin -> $CURSOR_HOME/plugins/local/rivet-memory-cursor
  remove legacy rivet-memory entries from $CURSOR_HOME/hooks.json and $CURSOR_HOME/mcp.json
  remove legacy skill symlinks in $CURSOR_HOME/skills/ that point into this kit
EOF
  exit 0
fi

mkdir -p "$CURSOR_HOME" "$CURSOR_HOME/plugins/local"

for name in AGENT.md MEMORY.md; do
  dest="$CURSOR_HOME/$name"
  if cmp -s "$PLUGIN_DIR/$name" "$dest" 2>/dev/null; then
    echo "OK  $dest (unchanged)"
  else
    cp "$PLUGIN_DIR/$name" "$dest"
    echo "Wrote $dest"
  fi
done

local_plugin="$CURSOR_HOME/plugins/local/rivet-memory-cursor"
if [ -L "$local_plugin" ] || [ -e "$local_plugin" ]; then
  rm -rf "$local_plugin"
fi
ln -sfn "$PLUGIN_DIR" "$local_plugin"
echo "Linked $local_plugin -> $PLUGIN_DIR"

for link in "$CURSOR_HOME"/skills/*; do
  [ -L "$link" ] || continue
  target="$(readlink "$link")"
  case "$target" in
    "$PLUGIN_DIR"/skills/* | */integrations/cursor/rivet-memory/skills/*)
      rm "$link"
      echo "Removed legacy skill link $link"
      ;;
  esac
done

python3 - "$CURSOR_HOME/hooks.json" "$CURSOR_HOME/mcp.json" <<'PY'
import json, os, sys

hooks_path, mcp_path = sys.argv[1], sys.argv[2]

def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None

def save(path, data):
    tmp = path + ".rivet.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)

hooks = load(hooks_path)
if hooks and isinstance(hooks.get("hooks"), dict):
    removed = 0
    for ev, entries in list(hooks["hooks"].items()):
        if not isinstance(entries, list):
            continue
        kept = [
            e for e in entries
            if not (isinstance(e, dict) and "rivet-memory-hook.sh" in str(e.get("command", "")))
        ]
        removed += len(entries) - len(kept)
        if kept:
            hooks["hooks"][ev] = kept
        else:
            del hooks["hooks"][ev]
    if removed:
        save(hooks_path, hooks)
        print(f"Removed {removed} legacy rivet-memory hook(s) from {hooks_path}")

mcp = load(mcp_path)
servers = mcp.get("mcpServers") if mcp else None
if isinstance(servers, dict):
    entry = servers.get("rivetos")
    if isinstance(entry, dict) and "integrations/cursor/rivet-memory/bin/rivet-memory-mcp.sh" in json.dumps(entry):
        del servers["rivetos"]
        save(mcp_path, mcp)
        print(f"Removed legacy rivetos server from {mcp_path} (the plugin provides it)")
PY

echo
echo "Done. Restart Cursor (or reload MCP) to pick up the plugin."
