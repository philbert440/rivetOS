#!/usr/bin/env bash
#
# setup-qwen-rivet-memory.sh
#
# One-stop helper to set up the rivet-memory integration for Qwen Code CLI
# on a RivetOS host. All paths it prints are derived from $RIVETOS_ROOT so the
# snippets are copy-pasteable on hosts where RivetOS lives outside /opt/rivetos.
#
# Override with:
#   RIVETOS_ROOT=/my/install ./setup-qwen-rivet-memory.sh
#   QWEN_BINARY=qwen QWEN_HOME=$HOME/.qwen ./setup-qwen-rivet-memory.sh --apply
#
# Flags:
#   --apply                 Install the rivet-memory qwen extension (default
#                           --mode extension) or merge hooks into user settings
#                           (--mode settings). Idempotent.
#   --remove                Uninstall the extension / strip our marker groups.
#   --status                Print current registration.
#   --mode extension|settings
#                           Default extension. settings is the fallback if a
#                           node's qwen refuses extensions.
#   --disable-auto-memory   Opt-in: set memory.enableManagedAutoMemory:false
#                           in user settings (one extra model call per headless
#                           run otherwise).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-$(cd "$PLUGIN_DIR/../../.." && pwd)}"
PLUGIN_PATH="$RIVETOS_ROOT/integrations/qwen-code/rivet-memory"
PLUGIN_BIN="$PLUGIN_PATH/bin"
HOOK_FRAGMENT="$PLUGIN_DIR/extension/hooks/hooks.json"
HOOK_MARKER="qwen-memory-capture.sh"
CAPTURE_DIR="$PLUGIN_PATH/capture"
MERGE_BUILT="$CAPTURE_DIR/dist/merge-settings-hooks.js"
MERGE_SRC="$CAPTURE_DIR/src/merge-settings-hooks.ts"
EXT_SRC="$PLUGIN_DIR/extension"

run_merge() {
  if [ -f "$MERGE_BUILT" ]; then
    node "$MERGE_BUILT" "$@"
  elif [ -f "$MERGE_SRC" ]; then
    npx --yes tsx "$MERGE_SRC" "$@"
  else
    echo "error: merge-settings-hooks not found at $MERGE_BUILT or $MERGE_SRC" >&2
    return 1
  fi
}

DO_APPLY=0
DO_REMOVE=0
DO_STATUS=0
DO_DISABLE_AUTO=0
MODE="extension"
for arg in "$@"; do
  case "$arg" in
    --apply) DO_APPLY=1 ;;
    --remove) DO_REMOVE=1 ;;
    --status) DO_STATUS=1 ;;
    --disable-auto-memory) DO_DISABLE_AUTO=1 ;;
    --mode) ;;
    --mode=extension) MODE="extension" ;;
    --mode=settings) MODE="settings" ;;
    --mode=*)
      echo "error: unknown --mode ${arg#--mode=} (want extension|settings)" >&2
      exit 1
      ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
  esac
done

# Support `--mode settings` as two tokens.
prev=""
for arg in "$@"; do
  if [ "$prev" = "--mode" ]; then
    case "$arg" in
      extension|settings) MODE="$arg" ;;
      *)
        echo "error: unknown --mode $arg (want extension|settings)" >&2
        exit 1
        ;;
    esac
  fi
  prev="$arg"
done

detect_qwen_home() {
  if [ -n "${QWEN_HOME:-}" ]; then
    echo "$QWEN_HOME"
    return
  fi
  echo "$HOME/.qwen"
}

QWEN_HOME_DIR="$(detect_qwen_home)"
QWEN_BIN="${QWEN_BINARY:-qwen}"
USER_SETTINGS="$QWEN_HOME_DIR/settings.json"
EXT_INSTALLED="$QWEN_HOME_DIR/extensions/rivet-memory"
EXT_HOOKS="$EXT_INSTALLED/hooks/hooks.json"

qwen_cmd() {
  command -v "$QWEN_BIN" >/dev/null 2>&1 || [ -x "$QWEN_BIN" ]
}

echo "=== RivetOS + Qwen Code rivet-memory Setup ==="
echo "Plugin directory: $PLUGIN_DIR"
echo "RivetOS root:     $RIVETOS_ROOT"
echo "Qwen config home: $QWEN_HOME_DIR  (override with QWEN_HOME)"
echo "Qwen binary:      $QWEN_BIN  (override with QWEN_BINARY)"
echo "Mode:             $MODE"
echo

if [ "$DO_STATUS" -eq 1 ]; then
  if [ -f "$EXT_HOOKS" ] && grep -q "$HOOK_MARKER" "$EXT_HOOKS" 2>/dev/null; then
    echo "extension: installed ($EXT_HOOKS contains $HOOK_MARKER)"
  else
    echo "extension: not installed (no $EXT_HOOKS marker)"
  fi
  if [ -f "$USER_SETTINGS" ] && grep -q "$HOOK_MARKER" "$USER_SETTINGS" 2>/dev/null; then
    echo "settings:  hooks present in $USER_SETTINGS"
  else
    echo "settings:  no rivet-memory hooks in $USER_SETTINGS"
  fi
  exit 0
fi

if [ "$DO_REMOVE" -eq 1 ]; then
  echo "=== Removing capture registration (--remove) ==="
  if qwen_cmd; then
    "$QWEN_BIN" extensions uninstall rivet-memory >/dev/null 2>&1 || true
    echo "qwen extensions uninstall rivet-memory (ignored failure if absent)"
  else
    echo "qwen binary not found; skipping extensions uninstall"
  fi
  if [ -d "$EXT_INSTALLED" ]; then
    rm -rf "$EXT_INSTALLED"
    echo "Removed $EXT_INSTALLED"
  fi
  if [ -f "$USER_SETTINGS" ]; then
    run_merge remove "$USER_SETTINGS" "$PLUGIN_PATH" || true
  else
    echo "no $USER_SETTINGS"
  fi
  echo "Done. Capture hooks unregistered."
  exit 0
fi

CLI="$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js"
if [ ! -f "$CLI" ]; then
  echo "⚠️  RivetOS MCP server not built."
  echo "   Please run: cd $RIVETOS_ROOT && npm install && npm run build"
else
  echo "✅ RivetOS MCP server found at $CLI"
fi

CAPTURE_BUILT="$PLUGIN_PATH/capture/dist/qwen-memory-capture.js"
if [ -f "$CAPTURE_BUILT" ]; then
  echo "✅ Capture worker built at $CAPTURE_BUILT"
else
  echo "⚠️  Capture worker not built. Hook will fall back to npx tsx (slow cold path)."
  echo "   To build: cd $RIVETOS_ROOT && npm install && npm run build"
fi

echo
echo "=== Automatic Capture ==="
echo "Events: UserPromptSubmit, Stop, SessionEnd → $PLUGIN_BIN/$HOOK_MARKER --hook"
echo "Default: qwen extension at $EXT_INSTALLED (hooks + MCP + skills)."
echo "Fallback: --mode settings merges the same three hook groups into $USER_SETTINGS."
echo "One-shot history: $PLUGIN_BIN/qwen-memory-capture.sh --backfill [--days N]"
echo "Status:           $PLUGIN_BIN/qwen-memory-capture.sh --status"
echo
echo "The capture writes under agent='rivet-qwen' channel='qwen-code'."
echo "Logs: ~/.rivetos/logs/qwen-code-capture.log"
echo "State: ~/.rivetos/qwen-code-capture-state.json"
echo "There was never a watcher unit for qwen — nothing to migrate."
echo
echo "--disable-auto-memory (opt-in) sets memory.enableManagedAutoMemory:false"
echo "in $USER_SETTINGS. Qwen otherwise makes one extra model call after each"
echo "headless -p run to extract memories."

if [ "$DO_DISABLE_AUTO" -eq 1 ]; then
  echo
  echo "=== Disabling managed auto-memory ==="
  mkdir -p "$QWEN_HOME_DIR"
  run_merge disable-auto-memory "$USER_SETTINGS"
fi

if [ "$DO_APPLY" -ne 1 ]; then
  echo
  echo "Re-run with --apply to install. Optional: --mode settings --disable-auto-memory"
  exit 0
fi

echo
echo "=== Applying config (--apply, mode=$MODE) ==="
mkdir -p "$QWEN_HOME_DIR"

if [ "$MODE" = "settings" ]; then
  if [ ! -f "$HOOK_FRAGMENT" ]; then
    echo "❌ Missing hook fragment $HOOK_FRAGMENT" >&2
    exit 1
  fi
  run_merge apply "$USER_SETTINGS" "$HOOK_FRAGMENT" "$PLUGIN_PATH"
  if ! grep -q "$HOOK_MARKER" "$USER_SETTINGS" 2>/dev/null; then
    echo "❌ Verification failed: $USER_SETTINGS does not contain $HOOK_MARKER" >&2
    exit 1
  fi
  echo "Capture registration mode: settings ($USER_SETTINGS)"
else
  if ! qwen_cmd; then
    echo "❌ $QWEN_BIN not found; cannot install the extension. Retry with --mode settings." >&2
    exit 1
  fi
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/qwen-rivet-memory.XXXXXX")"
  cleanup_stage() { rm -rf "$STAGE"; }
  trap cleanup_stage EXIT
  run_merge stage "$EXT_SRC" "$STAGE" "$PLUGIN_PATH"
  "$QWEN_BIN" extensions uninstall rivet-memory >/dev/null 2>&1 || true
  "$QWEN_BIN" extensions install "$STAGE" --consent
  if [ ! -f "$EXT_HOOKS" ] || ! grep -q "$HOOK_MARKER" "$EXT_HOOKS" 2>/dev/null; then
    echo "❌ Verification failed: $EXT_HOOKS does not contain $HOOK_MARKER" >&2
    exit 1
  fi
  echo "Installed qwen extension rivet-memory from staging copy of $EXT_SRC"
  echo "Verified $EXT_HOOKS contains $HOOK_MARKER"
  echo "Capture registration mode: extension ($EXT_INSTALLED)"
fi

bash "$PLUGIN_BIN/qwen-memory-capture.sh" --stamp-installed 2>/dev/null | tail -1 || true

echo
echo "=== Next Steps ==="
echo "1. Skills ship inside the extension (slash commands /memory-recall etc.)"
echo "2. MCP server is declared in extension/qwen-extension.json"
echo "3. Optional: $PLUGIN_BIN/qwen-memory-capture.sh --backfill"
echo "4. Optional: $0 --disable-auto-memory"
echo "5. Test with a memory-stats or time-bounded recall question"
echo
echo "Done. Memory should now feel dramatically better in Qwen Code sessions."
