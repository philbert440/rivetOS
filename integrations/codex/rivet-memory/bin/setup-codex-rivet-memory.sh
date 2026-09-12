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
#   --apply   Register MCP + skills + AGENTS.md, then register capture
#             hooks in exactly one place: managed /etc/codex/requirements.toml
#             when sudo -n works and the write validates; otherwise user
#             ~/.codex/hooks.json. Never both. Disable the old watcher unit.
#   --remove  Unregister capture hooks from both hooks.json and requirements.toml.
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
MERGE_HOOKS_PY="$SCRIPT_DIR/merge-hooks-json.py"
MERGE_HOOKS_JS="$SCRIPT_DIR/merge-hooks-json.cjs"

MIGRATION_INCOMPLETE=0
REGISTRATION_INCOMPLETE=0

# Stop + disable a legacy user unit. Success when it stopped OR was never loaded;
# a real failure (unit still running) returns 1 so the caller keeps the file.
stop_user_unit() {
  local unit="$1" out
  command -v systemctl >/dev/null 2>&1 || return 0
  out="$(systemctl --user disable --now "$unit" 2>&1)" && return 0
  case "$out" in
    *"Failed to connect to bus"*|*"Connection refused"*) echo "$out" >&2; return 1 ;;  # indeterminate: keep the file
    *"not loaded"*|*"could not be found"*|*"does not exist"*|*"Unit $unit not found"*) return 0 ;;
  esac
  echo "$out" >&2
  return 1
}

bootout_plist() {
  local domain="$1" plist="$2" out
  command -v launchctl >/dev/null 2>&1 || return 0
  out="$(launchctl bootout "$domain" "$plist" 2>&1)" && return 0
  case "$out" in
    *"No such process"*|*"Could not find"*|*"not find"*|*"No such file"*) return 0 ;;
  esac
  echo "$out" >&2
  return 1
}
MERGE_TOML_PY="$SCRIPT_DIR/merge-requirements.py"
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
      sed -n '2,20p' "$0"
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

# Merge our three hook groups into dest JSON. Command is bash-quoted; never
# clobbers foreign inner hooks. Creates dest if absent. Parse/shape errors
# leave dest bytes untouched and return non-zero.
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
    python3 "$MERGE_HOOKS_PY" apply "$dest" "$fragment" "$plugin_path"
  else
    node "$MERGE_HOOKS_JS" apply "$dest" "$fragment" "$plugin_path"
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
    python3 "$MERGE_HOOKS_PY" remove "$dest" "$plugin_path"
  else
    node "$MERGE_HOOKS_JS" remove "$dest" "$plugin_path"
  fi
}

# Register-once helper. mode=managed strips our user entries (foreign groups
# stay); mode=user merges our groups. Same function the tests drive.
sync_user_hooks() {
  local dest="$1"
  local mode="$2"
  local tool
  tool="$(json_tool)"
  if [ -z "$tool" ]; then
    echo "⚠️  Need python3 or node to sync $dest" >&2
    return 1
  fi
  if [ "$tool" = python3 ]; then
    python3 "$MERGE_HOOKS_PY" sync "$dest" "$HOOK_FRAGMENT" "$PLUGIN_PATH" "$mode"
  else
    node "$MERGE_HOOKS_JS" sync "$dest" "$HOOK_FRAGMENT" "$PLUGIN_PATH" "$mode"
  fi
}

sudo_n() {
  sudo -n true >/dev/null 2>&1
}

# Structural merge via bin/merge-requirements.py. Never writes invalid TOML.
# Exit 2 = foreign managed_dir (skip managed; user hooks.json is the path).
write_managed_toml() {
  local plugin_bin="$1"
  local dest="$MANAGED_TOML"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "⚠️  python3 (3.11+ tomllib) is required to merge $dest. Leaving it untouched." >&2
    echo "    cannot merge, edit by hand" >&2
    return 1
  fi
  local existing=""
  if [ -f "$dest" ]; then
    existing="$(sudo cat "$dest" 2>/dev/null || cat "$dest" 2>/dev/null || true)"
  fi
  local outf errf ec=0
  outf="$(mktemp)"
  errf="$(mktemp)"
  set +e
  printf '%s' "$existing" | python3 "$MERGE_TOML_PY" apply --plugin-bin "$plugin_bin" --stdin --out "$outf" 2>"$errf"
  ec=$?
  set -e
  if [ "$ec" -eq 2 ]; then
    echo "Skipped managed hooks at $dest (foreign managed_dir). Will register user hooks.json."
    cat "$errf" >&2 || true
    rm -f "$outf" "$errf"
    return 1
  fi
  if [ "$ec" -ne 0 ]; then
    echo "⚠️  cannot merge $dest; leaving it untouched (repair and re-run this step)."
    cat "$errf" >&2 || true
    rm -f "$outf" "$errf"
    return 1
  fi
  # Called from an `if` condition (set -e is suspended there) → check every
  # privileged step explicitly and verify the artefact before claiming success.
  if ! sudo mkdir -p /etc/codex; then
    echo "⚠️  sudo mkdir /etc/codex failed; managed hooks not written." >&2
    rm -f "$outf" "$errf"
    return 1
  fi
  # world-readable: codex runs as the user and must be able to read the managed file
  if ! sudo install -m 0644 -o root -g root "$outf" "${dest}.rivet.$$"; then
    echo "⚠️  sudo install of $dest failed; managed hooks not written." >&2
    rm -f "$outf" "$errf"
    return 1
  fi
  if ! sudo mv "${dest}.rivet.$$" "$dest"; then
    echo "⚠️  sudo mv into $dest failed; managed hooks not written." >&2
    sudo rm -f "${dest}.rivet.$$" 2>/dev/null || true
    rm -f "$outf" "$errf"
    return 1
  fi
  if ! [ -r "$dest" ] || ! grep -q 'codex-memory-capture.sh' "$dest"; then
    echo "⚠️  $dest is not readable or lacks the rivet-memory hooks after install; treating as failed." >&2
    rm -f "$outf" "$errf"
    return 1
  fi
  cat "$errf" || true
  echo "Wrote managed hooks to $dest (0644 root:root)"
  rm -f "$outf" "$errf"
}

remove_managed_toml() {
  local dest="$MANAGED_TOML"
  [ -f "$dest" ] || { echo "no $dest"; return 0; }
  if ! sudo_n; then
    echo "⚠️  sudo -n failed; cannot unmerge $dest (run with sudo)"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "⚠️  python3 (3.11+ tomllib) is required to unmerge $dest. Leaving it untouched." >&2
    return 1
  fi
  local existing
  existing="$(sudo cat "$dest" 2>/dev/null || true)"
  local outf errf ec=0
  outf="$(mktemp)"
  errf="$(mktemp)"
  set +e
  printf '%s' "$existing" | python3 "$MERGE_TOML_PY" remove --plugin-bin "$PLUGIN_BIN" --stdin --out "$outf" 2>"$errf"
  ec=$?
  set -e
  if [ "$ec" -ne 0 ]; then
    echo "⚠️  cannot unmerge $dest; leaving it untouched (repair and re-run this step)."
    cat "$errf" >&2 || true
    rm -f "$outf" "$errf"
    return 1
  fi
  local leftover
  leftover="$(sed '/^[[:space:]]*$/d;/^#/d' "$outf")"
  if [ -z "$leftover" ]; then
    if ! sudo rm -f "$dest" || [ -e "$dest" ]; then
      echo "⚠️  could not delete $dest; rivet-memory managed hooks are still active." >&2
      rm -f "$outf" "$errf"
      return 1
    fi
    echo "Removed $dest (was only rivet-memory hooks)"
  else
    if ! sudo install -m 0644 -o root -g root "$outf" "${dest}.rivet.$$" || ! sudo mv "${dest}.rivet.$$" "$dest"; then
      echo "⚠️  could not rewrite $dest; leaving it untouched." >&2
      sudo rm -f "${dest}.rivet.$$" 2>/dev/null || true
      rm -f "$outf" "$errf"
      return 1
    fi
    cat "$errf" || true
    echo "Removed rivet-memory hook tables from $dest"
  fi
  rm -f "$outf" "$errf"
}

stamp_hook_installed() {
  # Goes through the capture CLI so the write takes the same cross-process
  # state lock as the detached workers (never an unlocked write from setup).
  bash "$PLUGIN_BIN/codex-memory-capture.sh" --stamp-installed 2>/dev/null | tail -1 || true
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
      if stop_user_unit codex-memory-capture.service; then
        if rm -f "$WATCHER_UNIT"; then
          systemctl --user daemon-reload >/dev/null 2>&1 || true
          echo "Disabled and removed $WATCHER_UNIT"
        else
          echo "⚠️  Could not remove $WATCHER_UNIT (stopped, file kept)." >&2
          MIGRATION_INCOMPLETE=1
        fi
      else
        echo "⚠️  Could not stop codex-memory-capture.service; keeping $WATCHER_UNIT so the next install retries." >&2
        MIGRATION_INCOMPLETE=1
      fi
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
      if bootout_plist "gui/${uid}" "$WATCHER_PLIST"; then
        if rm -f "$WATCHER_PLIST"; then
          echo "Booted out and removed $WATCHER_PLIST"
        else
          echo "⚠️  Could not remove $WATCHER_PLIST (booted out, file kept)." >&2
          MIGRATION_INCOMPLETE=1
        fi
      else
        echo "⚠️  Could not boot out $WATCHER_PLIST; keeping it so the next install retries." >&2
        MIGRATION_INCOMPLETE=1
      fi
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
  if ! unmerge_hooks_json "$USER_HOOKS" "$PLUGIN_PATH"; then
    echo "⚠️  User hooks unmerge failed; left $USER_HOOKS untouched and continuing."
  else
    echo "User hooks path: $USER_HOOKS"
  fi
  if sudo_n; then
    if ! remove_managed_toml; then
      echo "❌ Managed hooks unmerge failed; rivet-memory hooks may still be active in $MANAGED_TOML." >&2
      REGISTRATION_INCOMPLETE=1
    else
      echo "Managed hooks path: $MANAGED_TOML"
    fi
  else
    echo "Skipped managed hooks (sudo -n failed): $MANAGED_TOML"
  fi
  print_trust_note
  echo
  if [ "${REGISTRATION_INCOMPLETE:-0}" -eq 1 ]; then
    echo "⚠️  Unregistration INCOMPLETE (see ❌ above) — rivet-memory hooks may still be active."
    exit 3
  fi
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
echo "Registration: exactly one of managed or user — never both."
echo "  managed when sudo -n works and /etc/codex/requirements.toml validates"
echo "  (trusted by policy; no /hooks prompt)."
echo "  otherwise user ~/.codex/hooks.json (one-time /hooks trust in the TUI)."
echo "One-shot history: $PLUGIN_PATH/bin/codex-memory-capture.sh --backfill [--days N]"
echo "Status:           $PLUGIN_PATH/bin/codex-memory-capture.sh --status"
echo
if [ "$DO_APPLY" -ne 1 ]; then
  print_migration preview
  print_trust_note
fi
echo
echo "The capture writes under agent='rivet-gpt' channel='codex'."
echo "Logs: ~/.rivetos/logs/codex-capture.log"
echo "State: ~/.rivetos/codex-capture-state.json"
echo "SessionEnd is clamped to 3s by Codex; --hook hands off ingest to a detached child."

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
  echo "=== Registering capture hooks (exactly one of managed or user) ==="
  if [ ! -f "$HOOK_FRAGMENT" ]; then
    echo "❌ Missing hook fragment $HOOK_FRAGMENT" >&2
    exit 1
  fi

  # Decide the mode from what is already registered, then end with EXACTLY one
  # registration active (managed OR user). Never leave both.
  managed_present=0
  if [ -r "$MANAGED_TOML" ] && grep -q 'codex-memory-capture.sh' "$MANAGED_TOML" 2>/dev/null; then
    managed_present=1
  fi
  managed_ok=0
  if sudo_n; then
    if write_managed_toml "$PLUGIN_BIN"; then
      managed_ok=1
    else
      echo "Managed hooks unavailable; falling back to user $USER_HOOKS."
    fi
  elif [ "$managed_present" -eq 1 ]; then
    echo "Managed registration already present in $MANAGED_TOML (no sudo to change it) — keeping it; not adding user hooks."
    managed_ok=1
  else
    echo "Skipped managed hooks (sudo -n failed): $MANAGED_TOML"
  fi

  if [ "$managed_ok" -eq 1 ]; then
    if ! sync_user_hooks "$USER_HOOKS" managed; then
      echo "❌ Incomplete: managed registration is active but user-level rivet-memory hooks could not be removed from $USER_HOOKS — both would run. Fix the file and re-run." >&2
      REGISTRATION_INCOMPLETE=1
    fi
    echo "Capture registration mode: managed ($MANAGED_TOML)"
  else
    if [ "$managed_present" -eq 1 ]; then
      # sudo was available but the managed write failed: the old managed entries still exist
      echo "❌ Incomplete: a managed registration exists in $MANAGED_TOML and could not be updated; not adding user hooks (both would run). Repair the file and re-run." >&2
      REGISTRATION_INCOMPLETE=1
    elif ! sync_user_hooks "$USER_HOOKS" user; then
      echo "⚠️  User hooks merge failed; left $USER_HOOKS untouched and continuing."
    else
      echo "User hooks path: $USER_HOOKS"
    fi
    echo "Capture registration mode: user ($USER_HOOKS)"
    print_trust_note
  fi

  stamp_hook_installed || true
  print_migration apply
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
if [ "${REGISTRATION_INCOMPLETE:-0}" -eq 1 ] || [ "${MIGRATION_INCOMPLETE:-0}" -eq 1 ]; then
  echo "⚠️  Setup finished with an INCOMPLETE step (see ❌/⚠️ above)."
  exit 3
fi
echo "Done. Memory should now feel dramatically better in Codex sessions."
