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

local_plugin="$CURSOR_HOME/plugins/local/rivet-memory-cursor"
previous_plugin=""
if [ -L "$local_plugin" ]; then
  target="$(readlink -f -- "$local_plugin" || true)"
  case "$target" in
    "$PLUGIN_DIR" | */integrations/cursor/rivet-memory) previous_plugin="$target" ;;
    *) echo "Refusing to replace foreign plugin symlink: $local_plugin" >&2
       [ "$DO_APPLY" -ne 1 ] && exit 0
       exit 1 ;;
  esac
elif [ -e "$local_plugin" ]; then
  echo "Refusing to replace existing plugin path (not a kit symlink): $local_plugin" >&2
  [ "$DO_APPLY" -ne 1 ] && exit 0
  exit 1
fi

if [ "$DO_APPLY" -ne 1 ]; then
  cat <<EOF
Dry run (pass --apply to install).
Will copy AGENT.md/MEMORY.md, backing up user edits; link $local_plugin;
remove only legacy kit-owned hooks, MCP launchers, and skill symlinks.
EOF
  exit 0
fi

umask 077
mkdir -p "$CURSOR_HOME" "$CURSOR_HOME/plugins/local"

for name in AGENT.md MEMORY.md; do
  dest="$CURSOR_HOME/$name"
  if cmp -s "$PLUGIN_DIR/$name" "$dest" 2>/dev/null; then
    echo "OK  $dest (unchanged)"
  else
    if [ -e "$dest" ] && { [ -z "$previous_plugin" ] || ! cmp -s "$previous_plugin/$name" "$dest"; }; then
      backup="$dest.bak-$(date -u +%Y%m%dT%H%M%S%N)"
      cp -p -- "$dest" "$backup"
      echo "Backed up $dest -> $backup"
    fi
    cp -- "$PLUGIN_DIR/$name" "$dest"
    echo "Wrote $dest"
  fi
done

# Preflight above verified ownership. Unlink only; never recursively delete.
[ ! -L "$local_plugin" ] || rm -- "$local_plugin"
ln -s -- "$PLUGIN_DIR" "$local_plugin"
echo "Linked $local_plugin -> $PLUGIN_DIR"

for link in "$CURSOR_HOME"/skills/*; do
  [ -L "$link" ] || continue
  target="$(readlink -f -- "$link" || true)"
  case "$target" in
    "$PLUGIN_DIR"/skills/* | */integrations/cursor/rivet-memory/skills/*)
      rm -- "$link"
      echo "Removed legacy skill link $link"
      ;;
  esac
done

python3 - "$CURSOR_HOME/hooks.json" "$CURSOR_HOME/mcp.json" "$PLUGIN_DIR" <<'PYTHON'
import json, os, shlex, shutil, subprocess, sys, tempfile, time

hooks_path, mcp_path, plugin = sys.argv[1:]

MARKER = "/integrations/cursor/rivet-memory/bin/"
SHELL_DIRS = ("/bin", "/usr/bin", "/usr/local/bin")

def resolve(word):
    # Only an absolute command can prove ownership. Relative or bare commands depend on
    # the cwd/PATH Cursor runs hooks with, which this installer cannot know: preserve them.
    if not isinstance(word, str) or not os.path.isabs(word):
        return ""
    return os.path.realpath(word)

def owned(word, launcher=False):
    resolved = resolve(word)
    if not resolved:
        return False
    names = ("rivet-memory-mcp.sh",) if launcher else ("rivet-memory-hook.sh", "rivet-memory-mcp.sh")
    for name in names:
        if resolved == os.path.realpath(os.path.join(plugin, "bin", name)):
            return True
        if resolved.endswith(MARKER + name):  # a previous checkout of this kit
            return True
    return False

def is_shell(word):
    # Only an absolute interpreter in a system bin dir proves a shell. A bare `bash` depends on the
    # PATH Cursor launches the server with, which may name something else: preserve it.
    resolved = resolve(word)
    return (bool(resolved) and os.path.dirname(resolved) in SHELL_DIRS
            and os.path.basename(resolved) in ("bash", "sh", "dash"))

def owned_hook(entry):
    if not isinstance(entry, dict) or not isinstance(entry.get("command"), str):
        return False
    try:
        words = shlex.split(entry["command"])
        return bool(words) and owned(words[0])
    except ValueError:
        return False

def owned_server(entry):
    if not isinstance(entry, dict):
        return False
    command = entry.get("command")
    if owned(command, launcher=True):
        return True
    # Only a literal shell running the kit launcher; never argument or env text alone.
    args = entry.get("args")
    return is_shell(command) and isinstance(args, list) and bool(args) and owned(args[0], launcher=True)

def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None

def save(path, data):
    backup = "%s.bak-%s%09d" % (path, time.strftime("%Y%m%dT%H%M%S", time.gmtime()), time.time_ns() % 1_000_000_000)
    shutil.copy2(path, backup)
    print(f"Backed up {path} -> {backup}")
    fd, tmp = tempfile.mkstemp(prefix=".rivet-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        subprocess.run(["chmod", "--reference=" + path, tmp], check=True)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

hooks = load(hooks_path)
if hooks and isinstance(hooks.get("hooks"), dict):
    removed = 0
    for ev, entries in list(hooks["hooks"].items()):
        if not isinstance(entries, list):
            continue
        kept = [e for e in entries if not owned_hook(e)]
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
    removed = [name for name, entry in servers.items() if owned_server(entry)]
    for name in removed:
        del servers[name]
    if removed:
        save(mcp_path, mcp)
        print(f"Removed {len(removed)} legacy kit MCP server(s) from {mcp_path}")
PYTHON

echo
echo "Done. Restart Cursor (or reload MCP) to pick up the plugin."
