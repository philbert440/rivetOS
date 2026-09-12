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
#   --apply   Register MCP + skills + AGENTS.md, merge capture hooks into
#             ~/.codex/hooks.json (and /etc/codex/requirements.toml when
#             `sudo -n` works), and disable the old capture watcher unit.
#   --remove  Unregister the capture hooks from hooks.json / requirements.toml.
#   --force   With --apply, overwrite existing AGENTS.md / skills / MCP.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-$(cd "$PLUGIN_DIR/../../.." && pwd)}"
PLUGIN_PATH="$RIVETOS_ROOT/integrations/codex/rivet-memory"
PLUGIN_BIN="$PLUGIN_PATH/bin"
HOOK_FRAGMENT="$PLUGIN_DIR/hooks/hooks.json"
HOOK_MARKER="$PLUGIN_BIN/codex-memory-capture.sh"
MANAGED_TOML="/etc/codex/requirements.toml"
WATCHER_UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/codex-memory-capture.service"
WATCHER_PLIST="$HOME/Library/LaunchAgents/dev.rivetos.codex-capture.plist"

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

detect_codex_home() {
  if [ -n "${CODEX_HOME:-}" ]; then
    echo "$CODEX_HOME"
    return
  fi
  echo "$HOME/.codex"
}

CODEX_HOME_DIR="$(detect_codex_home)"
USER_HOOKS="$CODEX_HOME_DIR/hooks.json"

json_tool() {
  if command -v python3 >/dev/null 2>&1; then
    echo python3
  elif command -v node >/dev/null 2>&1; then
    echo node
  else
    echo ""
  fi
}

# Merge our three hook groups into dest JSON. Marker = absolute launcher path.
# Never clobbers other people's hooks. Creates dest if absent.
merge_hooks_json() {
  local dest="$1"
  local fragment="$2"
  local plugin_path="$3"
  local tool
  tool="$(json_tool)"
  if [ -z "$tool" ]; then
    echo "⚠️  Need python3 or node to merge $dest" >&2
    return 1
  fi
  if [ "$tool" = python3 ]; then
    python3 - "$dest" "$fragment" "$plugin_path" <<'PY'
import json, pathlib, sys
dest, fragment_path, plugin_path = sys.argv[1], sys.argv[2], sys.argv[3]
marker = plugin_path + "/bin/codex-memory-capture.sh"
text = pathlib.Path(fragment_path).read_text(encoding="utf-8").replace("<PLUGIN_PATH>", plugin_path)
fragment = json.loads(text)
p = pathlib.Path(dest)
try:
    dest_obj = json.loads(p.read_text(encoding="utf-8"))
except FileNotFoundError:
    dest_obj = {"hooks": {}}
except json.JSONDecodeError:
    dest_obj = {"hooks": {}}
if not isinstance(dest_obj, dict):
    dest_obj = {"hooks": {}}
hooks = dest_obj.get("hooks")
if not isinstance(hooks, dict):
    hooks = {}
    dest_obj["hooks"] = hooks

def group_has_marker(group):
    if not isinstance(group, dict):
        return False
    inner = group.get("hooks") or []
    if not isinstance(inner, list):
        return False
    for h in inner:
        if isinstance(h, dict) and marker in str(h.get("command") or ""):
            return True
    return False

added = 0
for event, groups in (fragment.get("hooks") or {}).items():
    if not isinstance(groups, list):
        continue
    existing = hooks.get(event) if isinstance(hooks.get(event), list) else []
    if any(group_has_marker(g) for g in existing):
        continue
    hooks[event] = list(existing) + list(groups)
    added += len(groups)
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(dest_obj, indent=2) + "\n", encoding="utf-8")
print(("merged %d hook group(s) into " % added) + dest if added else "hooks already present in " + dest)
PY
  else
    node -e '
const fs = require("fs");
const path = require("path");
const dest = process.argv[1];
const fragmentPath = process.argv[2];
const pluginPath = process.argv[3];
const marker = pluginPath + "/bin/codex-memory-capture.sh";
const fragment = JSON.parse(
  fs.readFileSync(fragmentPath, "utf8").split("<PLUGIN_PATH>").join(pluginPath),
);
let destObj;
try {
  destObj = JSON.parse(fs.readFileSync(dest, "utf8"));
} catch {
  destObj = { hooks: {} };
}
if (!destObj || typeof destObj !== "object" || Array.isArray(destObj)) destObj = { hooks: {} };
if (!destObj.hooks || typeof destObj.hooks !== "object" || Array.isArray(destObj.hooks)) {
  destObj.hooks = {};
}
function groupHasMarker(group) {
  const inner = group && Array.isArray(group.hooks) ? group.hooks : [];
  return inner.some((h) => h && typeof h.command === "string" && h.command.includes(marker));
}
let added = 0;
for (const [event, groups] of Object.entries(fragment.hooks || {})) {
  if (!Array.isArray(groups)) continue;
  const existing = Array.isArray(destObj.hooks[event]) ? destObj.hooks[event] : [];
  if (existing.some(groupHasMarker)) continue;
  destObj.hooks[event] = existing.concat(groups);
  added += groups.length;
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(destObj, null, 2) + "\n");
process.stdout.write(
  (added > 0 ? "merged " + added + " hook group(s) into " : "hooks already present in ") + dest + "\n",
);
' "$dest" "$fragment" "$plugin_path"
  fi
}

unmerge_hooks_json() {
  local dest="$1"
  local plugin_path="$2"
  [ -f "$dest" ] || { echo "no $dest"; return 0; }
  local tool
  tool="$(json_tool)"
  if [ -z "$tool" ]; then
    echo "⚠️  Need python3 or node to unmerge $dest" >&2
    return 1
  fi
  if [ "$tool" = python3 ]; then
    python3 - "$dest" "$plugin_path" <<'PY'
import json, pathlib, sys
dest, plugin_path = sys.argv[1], sys.argv[2]
marker = plugin_path + "/bin/codex-memory-capture.sh"
p = pathlib.Path(dest)
dest_obj = json.loads(p.read_text(encoding="utf-8"))
hooks = dest_obj.get("hooks") if isinstance(dest_obj, dict) else None
if not isinstance(hooks, dict):
    print("no hooks object in " + dest)
    raise SystemExit(0)

def group_has_marker(group):
    if not isinstance(group, dict):
        return False
    inner = group.get("hooks") or []
    if not isinstance(inner, list):
        return False
    return any(isinstance(h, dict) and marker in str(h.get("command") or "") for h in inner)

removed = 0
for event in list(hooks.keys()):
    existing = hooks[event]
    if not isinstance(existing, list):
        continue
    kept = [g for g in existing if not group_has_marker(g)]
    removed += len(existing) - len(kept)
    if kept:
        hooks[event] = kept
    else:
        del hooks[event]
p.write_text(json.dumps(dest_obj, indent=2) + "\n", encoding="utf-8")
print("removed %d hook group(s) from %s" % (removed, dest))
PY
  else
    node -e '
const fs = require("fs");
const dest = process.argv[1];
const pluginPath = process.argv[2];
const marker = pluginPath + "/bin/codex-memory-capture.sh";
const destObj = JSON.parse(fs.readFileSync(dest, "utf8"));
const hooks = destObj && destObj.hooks && typeof destObj.hooks === "object" ? destObj.hooks : null;
if (!hooks) {
  process.stdout.write("no hooks object in " + dest + "\n");
  process.exit(0);
}
function groupHasMarker(group) {
  const inner = group && Array.isArray(group.hooks) ? group.hooks : [];
  return inner.some((h) => h && typeof h.command === "string" && h.command.includes(marker));
}
let removed = 0;
for (const event of Object.keys(hooks)) {
  const existing = hooks[event];
  if (!Array.isArray(existing)) continue;
  const kept = existing.filter((g) => !groupHasMarker(g));
  removed += existing.length - kept.length;
  if (kept.length) hooks[event] = kept;
  else delete hooks[event];
}
fs.writeFileSync(dest, JSON.stringify(destObj, null, 2) + "\n");
process.stdout.write("removed " + removed + " hook group(s) from " + dest + "\n");
' "$dest" "$plugin_path"
  fi
}

managed_block() {
  local plugin_bin="$1"
  cat <<EOF
# --- rivet-memory capture hooks (marker: codex-memory-capture.sh) ---
[hooks]
managed_dir = "${plugin_bin}"

[[hooks.UserPromptSubmit]]
command = "${plugin_bin}/codex-memory-capture.sh --hook"
timeout = 20

[[hooks.Stop]]
command = "${plugin_bin}/codex-memory-capture.sh --hook"
timeout = 20

[[hooks.SessionEnd]]
command = "${plugin_bin}/codex-memory-capture.sh --hook"
timeout = 20
# --- end rivet-memory capture hooks ---
EOF
}

merge_requirements_text() {
  local plugin_bin="$1"
  local existing="$2"
  if printf '%s' "$existing" | grep -q 'codex-memory-capture.sh' 2>/dev/null; then
    printf '%s' "$existing"
    if [ -n "$existing" ] && [ "${existing: -1}" != $'\n' ]; then printf '\n'; fi
    return 0
  fi
  local block
  block="$(managed_block "$plugin_bin")"
  if [ -z "$existing" ]; then
    printf '%s\n' "$block"
    return 0
  fi
  printf '%s' "$existing"
  if [ "${existing: -1}" != $'\n' ]; then printf '\n'; fi
  printf '\n%s\n' "$block"
}

strip_requirements_text() {
  local existing="$1"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$existing" | python3 -c '
import sys
text = sys.stdin.read()
BEGIN = "# --- rivet-memory capture hooks (marker: codex-memory-capture.sh) ---"
END = "# --- end rivet-memory capture hooks ---"
start = text.find(BEGIN)
if start < 0:
    sys.stdout.write(text)
    raise SystemExit(0)
end = text.find(END, start)
if end < 0:
    sys.stdout.write(text[:start])
else:
    sys.stdout.write(text[:start] + text[end + len(END):])
'
  elif command -v node >/dev/null 2>&1; then
    printf '%s' "$existing" | node -e '
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { text += c; });
process.stdin.on("end", () => {
  const BEGIN = "# --- rivet-memory capture hooks (marker: codex-memory-capture.sh) ---";
  const END = "# --- end rivet-memory capture hooks ---";
  const start = text.indexOf(BEGIN);
  if (start < 0) { process.stdout.write(text); return; }
  const end = text.indexOf(END, start);
  if (end < 0) process.stdout.write(text.slice(0, start));
  else process.stdout.write(text.slice(0, start) + text.slice(end + END.length));
});
'
  else
    printf '%s' "$existing"
  fi
}

sudo_n() {
  sudo -n true >/dev/null 2>&1
}

write_managed_toml() {
  local plugin_bin="$1"
  local dest="$MANAGED_TOML"
  local existing=""
  if [ -f "$dest" ]; then
    existing="$(sudo cat "$dest" 2>/dev/null || cat "$dest" 2>/dev/null || true)"
  fi
  if printf '%s' "$existing" | grep -q 'codex-memory-capture.sh' 2>/dev/null; then
    echo "Managed hooks already present in $dest"
    return 0
  fi
  local merged
  merged="$(merge_requirements_text "$plugin_bin" "$existing")"
  sudo mkdir -p /etc/codex
  printf '%s\n' "$merged" | sudo tee "$dest" >/dev/null
  echo "Wrote managed hooks to $dest (managed_dir=$plugin_bin)"
}

remove_managed_toml() {
  local dest="$MANAGED_TOML"
  [ -f "$dest" ] || { echo "no $dest"; return 0; }
  if ! sudo_n; then
    echo "⚠️  sudo -n failed; cannot unmerge $dest (run with sudo)"
    return 0
  fi
  local existing
  existing="$(sudo cat "$dest" 2>/dev/null || true)"
  local stripped
  stripped="$(strip_requirements_text "$existing" | sed '/^$/N;/^\n$/D')"
  local leftover
  leftover="$(printf '%s' "$stripped" | sed '/^[[:space:]]*$/d;/^#/d')"
  if [ -z "$leftover" ]; then
    sudo rm -f "$dest"
    echo "Removed $dest (was only rivet-memory hooks)"
  else
    printf '%s\n' "$stripped" | sudo tee "$dest" >/dev/null
    echo "Removed rivet-memory hook tables from $dest"
  fi
}

stamp_hook_installed() {
  command -v node >/dev/null 2>&1 || return 0
  node -e '
const fs = require("fs");
const os = require("os");
const path = require("path");
const file = process.env.RIVETOS_CODEX_STATE || path.join(os.homedir(), ".rivetos", "codex-capture-state.json");
let state = { version: 1, cursors: {} };
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed && typeof parsed === "object") state = { version: 1, cursors: {}, ...parsed };
} catch {}
if (!state.hookInstalledAt) state.hookInstalledAt = new Date().toISOString();
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
'
}

print_trust_note() {
  echo
  echo "Trust: non-managed hooks need a one-time /hooks → trust in the Codex TUI; managed (requirements.toml) hooks are trusted by policy."
}

print_migration() {
  local ran=0
  if [ -f "$WATCHER_UNIT" ]; then
    echo
    echo "Old capture watcher unit found: $WATCHER_UNIT"
    echo "  systemctl --user disable --now codex-memory-capture.service"
    echo "  rm -f $WATCHER_UNIT"
    echo "  systemctl --user daemon-reload"
    if [ "$1" = apply ]; then
      systemctl --user disable --now codex-memory-capture.service >/dev/null 2>&1 || true
      rm -f "$WATCHER_UNIT" || true
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      echo "Disabled and removed $WATCHER_UNIT"
    fi
    ran=1
  fi
  if [ -f "$WATCHER_PLIST" ]; then
    echo
    echo "Old capture watcher plist found: $WATCHER_PLIST"
    echo "  launchctl bootout gui/\$UID $WATCHER_PLIST"
    echo "  rm -f $WATCHER_PLIST"
    if [ "$1" = apply ]; then
      local uid
      uid="$(id -u)"
      launchctl bootout "gui/${uid}" "$WATCHER_PLIST" >/dev/null 2>&1 || true
      rm -f "$WATCHER_PLIST" || true
      echo "Booted out and removed $WATCHER_PLIST"
    fi
    ran=1
  fi
  if [ "$ran" -eq 0 ]; then
    echo "No old capture watcher unit/plist at $WATCHER_UNIT or $WATCHER_PLIST"
  fi
}

echo "=== RivetOS + Codex rivet-memory Setup ==="
echo "Plugin directory: $PLUGIN_DIR"
echo "RivetOS root:     $RIVETOS_ROOT"
echo "Codex config home: $CODEX_HOME_DIR  (override with CODEX_HOME)"
echo

if [ "$DO_REMOVE" -eq 1 ]; then
  echo "=== Removing capture hooks (--remove) ==="
  unmerge_hooks_json "$USER_HOOKS" "$PLUGIN_PATH" || true
  echo "User hooks path: $USER_HOOKS"
  if sudo_n; then
    remove_managed_toml || true
    echo "Managed hooks path: $MANAGED_TOML"
  else
    echo "Skipped managed hooks (sudo -n failed): $MANAGED_TOML"
  fi
  print_trust_note
  echo
  echo "Done. Capture hooks unregistered."
  exit 0
fi

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
  echo "⚠️  Capture worker not built. Hook will fall back to npx tsx (slow cold path)."
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
echo "=== 4. Automatic Capture (native Codex hooks) ==="
echo "Events: UserPromptSubmit, Stop, SessionEnd → $HOOK_MARKER --hook"
echo "User hooks file: $USER_HOOKS"
echo "Managed hooks file (sudo): $MANAGED_TOML"
echo "One-shot history: $PLUGIN_PATH/bin/codex-memory-capture.sh --backfill [--days N]"
echo "Status:           $PLUGIN_PATH/bin/codex-memory-capture.sh --status"
echo
if [ "$DO_APPLY" -ne 1 ]; then
  print_migration preview
  print_trust_note
fi
echo
echo "The capture writes under agent='rivet-gpt' channel='codex'."
echo "Logs: ~/.rivetos/codex-memory-capture.log"
echo "State: ~/.rivetos/codex-capture-state.json"

echo
echo "=== 5. Backfill existing sessions ==="
echo "$PLUGIN_PATH/bin/codex-memory-capture.sh --backfill [--days N]"
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

  echo
  echo "=== Registering capture hooks ==="
  if [ ! -f "$HOOK_FRAGMENT" ]; then
    echo "❌ Missing hook fragment $HOOK_FRAGMENT" >&2
    exit 1
  fi
  merge_hooks_json "$USER_HOOKS" "$HOOK_FRAGMENT" "$PLUGIN_PATH"
  echo "User hooks path: $USER_HOOKS"

  if sudo_n; then
    write_managed_toml "$PLUGIN_BIN"
    echo "Managed hooks path: $MANAGED_TOML"
  else
    echo "Skipped managed hooks (sudo -n failed): $MANAGED_TOML"
  fi

  stamp_hook_installed || true
  print_migration apply
  print_trust_note
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
echo "4. Trust non-managed hooks once via /hooks in the Codex TUI (skip if managed)"
echo "5. Optional: $PLUGIN_PATH/bin/codex-memory-capture.sh --backfill"
echo "6. Test with a memory-stats or time-bounded recall question"
echo
echo "Done. Memory should now feel dramatically better in Codex sessions."
