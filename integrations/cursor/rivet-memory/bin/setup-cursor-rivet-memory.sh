#!/usr/bin/env bash
#
# setup-cursor-rivet-memory.sh
#
# Install RivetOS memory into ~/.cursor for Cursor IDE/CLI.
#
# Writes global wiring with absolute paths into this kit: hook entries in
# hooks.json, the rivetos server in mcp.json, skill links in skills/, and the
# memory-researcher agent link in agents/. Copies AGENT.md/MEMORY.md.
# Removes a kit symlink under plugins/local/: Cursor auto-discovers a plugin's
# hooks and MCP server, so a linked plugin would run them a second time.
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
      sed -n '2,16p' "$0"
      exit 0
      ;;
  esac
done

echo "=== RivetOS + Cursor rivet-memory Setup ==="
echo "Kit directory: $PLUGIN_DIR"
echo "Cursor home:   $CURSOR_HOME"
echo

is_kit_path() {
  case "$1" in
    "$PLUGIN_DIR" | "$PLUGIN_DIR"/* | */integrations/cursor/rivet-memory | */integrations/cursor/rivet-memory/*) return 0 ;;
  esac
  return 1
}

local_plugin="$CURSOR_HOME/plugins/local/rivet-memory-cursor"
previous_kit=""
if [ -L "$local_plugin" ]; then
  target="$(readlink -f -- "$local_plugin" || true)"
  if is_kit_path "$target"; then
    previous_kit="$target"
  else
    echo "Leaving foreign plugin symlink alone: $local_plugin"
  fi
elif [ -e "$local_plugin" ]; then
  echo "Leaving existing plugin path alone (not a kit symlink): $local_plugin"
fi

if [ "$DO_APPLY" -ne 1 ]; then
  cat <<EOF
Dry run (pass --apply to install).
Will copy AGENT.md/MEMORY.md (backing up user edits), write kit hook entries
to $CURSOR_HOME/hooks.json and the rivetos server to $CURSOR_HOME/mcp.json,
link skills and the memory-researcher agent, and unlink a kit plugin symlink.
EOF
  exit 0
fi

umask 077
mkdir -p "$CURSOR_HOME" "$CURSOR_HOME/skills" "$CURSOR_HOME/agents"

for name in AGENT.md MEMORY.md; do
  dest="$CURSOR_HOME/$name"
  if cmp -s "$PLUGIN_DIR/$name" "$dest" 2>/dev/null; then
    echo "OK  $dest (unchanged)"
  else
    if [ -e "$dest" ] && { [ -z "$previous_kit" ] || ! cmp -s "$previous_kit/$name" "$dest"; }; then
      backup="$dest.bak-$(date -u +%Y%m%dT%H%M%S%N)"
      cp -p -- "$dest" "$backup"
      echo "Backed up $dest -> $backup"
    fi
    cp -- "$PLUGIN_DIR/$name" "$dest"
    echo "Wrote $dest"
  fi
done

if [ -n "$previous_kit" ]; then
  rm -- "$local_plugin"
  echo "Unlinked $local_plugin (global wiring replaces it)"
fi

# Replace only links that point into a rivet-memory kit; never touch real files.
link_owned() {
  local src="$1" dest="$2"
  if [ -L "$dest" ]; then
    if ! is_kit_path "$(readlink -f -- "$dest" || true)"; then
      echo "Skip $dest (foreign symlink)"
      return
    fi
    rm -- "$dest"
  elif [ -e "$dest" ]; then
    echo "Skip $dest (exists and is not a kit symlink)"
    return
  fi
  ln -s -- "$src" "$dest"
  echo "Linked $dest -> $src"
}

for skill in "$PLUGIN_DIR"/skills/*/; do
  skill="${skill%/}"
  link_owned "$skill" "$CURSOR_HOME/skills/$(basename "$skill")"
done
for agent in "$PLUGIN_DIR"/agents/*.md; do
  link_owned "$agent" "$CURSOR_HOME/agents/$(basename "$agent")"
done

python3 - "$CURSOR_HOME/hooks.json" "$CURSOR_HOME/mcp.json" "$PLUGIN_DIR" <<'PYTHON'
import json, os, shlex, shutil, sys, tempfile, time

hooks_path, mcp_path, plugin = sys.argv[1:]
hook_script = os.path.join(plugin, "bin", "rivet-memory-hook.sh")
mcp_script = os.path.join(plugin, "bin", "rivet-memory-mcp.sh")

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
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        sys.exit(f"Refusing to rewrite unreadable or invalid JSON: {path}")
    if not isinstance(data, dict):
        sys.exit(f"Refusing to rewrite non-object JSON: {path}")
    return data

def save(path, data):
    mode = os.stat(path).st_mode & 0o7777 if os.path.exists(path) else 0o600
    if os.path.exists(path):
        backup = "%s.bak-%s%09d" % (path, time.strftime("%Y%m%dT%H%M%S", time.gmtime()), time.time_ns() % 1_000_000_000)
        shutil.copy2(path, backup)
        print(f"Backed up {path} -> {backup}")
    fd, tmp = tempfile.mkstemp(prefix=".rivet-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

with open(os.path.join(plugin, "hooks", "hooks.json"), encoding="utf-8") as f:
    kit_hooks = json.load(f)["hooks"]

hooks = load(hooks_path)
before = json.dumps(hooks, sort_keys=True)
hooks.setdefault("version", 1)
events = hooks.setdefault("hooks", {})
if not isinstance(events, dict):
    sys.exit(f"Refusing to rewrite {hooks_path}: 'hooks' is not an object")
for ev, entries in list(events.items()):
    if isinstance(entries, list):
        events[ev] = [e for e in entries if not owned_hook(e)]
for ev, entries in kit_hooks.items():
    timeout = entries[0].get("timeout", 10) if entries else 10
    target = events.setdefault(ev, [])
    if not isinstance(target, list):
        sys.exit(f"Refusing to rewrite {hooks_path}: '{ev}' is not a list")
    target.append({"command": f"{shlex.quote(hook_script)} {ev}", "timeout": timeout})
for ev in [ev for ev, entries in events.items() if entries == []]:
    del events[ev]
if json.dumps(hooks, sort_keys=True) != before:
    save(hooks_path, hooks)
    print(f"Wrote kit hooks for {len(kit_hooks)} event(s) to {hooks_path}")
else:
    print(f"OK  {hooks_path} (unchanged)")

mcp = load(mcp_path)
before = json.dumps(mcp, sort_keys=True)
servers = mcp.setdefault("mcpServers", {})
if not isinstance(servers, dict):
    sys.exit(f"Refusing to rewrite {mcp_path}: 'mcpServers' is not an object")
for name in [n for n, e in servers.items() if owned_server(e)]:
    del servers[name]
if "rivetos" in servers:
    print(f"Skip rivetos server in {mcp_path} (a non-kit 'rivetos' entry exists)")
else:
    servers["rivetos"] = {"command": mcp_script}
if json.dumps(mcp, sort_keys=True) != before:
    save(mcp_path, mcp)
    print(f"Wrote rivetos server to {mcp_path}")
else:
    print(f"OK  {mcp_path} (unchanged)")
PYTHON

echo
echo "Done. Restart Cursor (or reload MCP) to pick up the changes."
