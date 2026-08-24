#!/usr/bin/env bash
#
# setup-deepseek-rivet-memory.sh
#
# Install the rivet-memory integration for DeepSeek Harness (dsh) on a RivetOS
# host. dsh has no Claude/kimi-style hooks — this wires a Cordis plugin on
# session/event plus a zstd JSONL backfill tool.
#
# Flags:
#   --apply   Write DSH_HOME patch + install capture deps + add plugin to
#             the headless (and web, if present) profile.
#   --force   With --apply, overwrite existing AGENTS.md / mcp snippets.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

DO_APPLY=0
DO_FORCE=0
for arg in "$@"; do
  case "$arg" in
    --apply) DO_APPLY=1 ;;
    --force) DO_FORCE=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

echo "=== RivetOS + dsh rivet-memory Setup ==="
echo "Plugin directory: $PLUGIN_DIR"
echo "RivetOS root:     $RIVETOS_ROOT"
echo "DSH home:         $DSH_HOME"
echo
echo "Capture mechanism: Cordis plugin ctx.on('session/event') + zstd JSONL backfill"
echo "Agent stamp:       rivet-deepseek"
echo "There are no Claude-style hooks in dsh 0.1.1-rc.2."
echo

CAPTURE="$PLUGIN_DIR/capture/deepseek-memory-capture.mjs"
if [ -f "$CAPTURE" ]; then
  echo "✅ Capture worker at $CAPTURE"
else
  echo "❌ Capture worker missing at $CAPTURE"
  exit 1
fi

echo
echo "=== 1. Install capture deps (pg + fzstd) ==="
echo "  cd $PLUGIN_DIR/capture && npm install"
echo
echo "=== 2. Mount the Cordis plugin ==="
echo "Preferred (profile-local, official add surface):"
echo "  export PATH=\$HOME/.local/bin:\$PATH"
echo "  dsh plugin --profile headless add $PLUGIN_DIR/plugin"
echo "  # also: dsh plugin --profile web add $PLUGIN_DIR/plugin"
echo
echo "Fallback (home-level patch, wins over bundle defaults):"
cat <<EOF
# Append to $DSH_HOME/cordis.patch.yml
- insert:
    - id: rivet-memory
      name: '$PLUGIN_DIR/plugin/index.js'
EOF
echo
echo "=== 3. Backfill existing transcripts ==="
echo "  node $CAPTURE --backfill \$DSH_HOME/sessions"
echo
echo "=== 4. Reflex ==="
echo "  cp $PLUGIN_DIR/DEEPSEEK.md $DSH_HOME/AGENTS.md"
echo

if [ "$DO_APPLY" -eq 1 ]; then
  echo "=== Applying (--apply) ==="
  mkdir -p "$DSH_HOME"
  (cd "$PLUGIN_DIR/capture" && npm install)

  PATCH="$DSH_HOME/cordis.patch.yml"
  MARKER="rivet-memory"
  if [ -f "$PATCH" ] && grep -q "$MARKER" "$PATCH" 2>/dev/null; then
    echo "⚠️  $PATCH already mentions rivet-memory"
  else
    {
      echo ""
      echo "# --- rivet-memory capture (auto-appended by setup-deepseek-rivet-memory.sh) ---"
      echo "- insert:"
      echo "    - id: rivet-memory"
      echo "      name: '$PLUGIN_DIR/plugin/index.js'"
    } >> "$PATCH"
    echo "✅ Appended plugin insert to $PATCH"
  fi

  if command -v dsh >/dev/null 2>&1; then
    for prof in headless web; do
      if [ -d "$DSH_HOME/profiles/$prof" ]; then
        dsh plugin --profile "$prof" add "$PLUGIN_DIR/plugin" || \
          echo "⚠️  dsh plugin add ($prof) failed — home patch is the fallback"
      fi
    done
  else
    echo "⚠️  dsh not on PATH; skipped profile plugin add"
  fi

  AGENTS_DEST="$DSH_HOME/AGENTS.md"
  if [ ! -f "$AGENTS_DEST" ] || [ "$DO_FORCE" -eq 1 ]; then
    cp "$PLUGIN_DIR/DEEPSEEK.md" "$AGENTS_DEST"
    echo "✅ Wrote $AGENTS_DEST"
  else
    echo "⚠️  $AGENTS_DEST exists (use --force to overwrite)"
  fi

  mkdir -p "$DSH_HOME/skills"
  cp -r "$PLUGIN_DIR/skills/." "$DSH_HOME/skills/"
  echo "✅ Copied skills to $DSH_HOME/skills/"
fi

echo
echo "Done. Verify with:"
echo "  node $CAPTURE --backfill --dump \$DSH_HOME/sessions/<workspace>/session-*/session.jsonl.zstd"
echo "  node $CAPTURE --backfill \$DSH_HOME/sessions   # twice → inserted then skipped"
echo "Logs: ~/.rivetos/deepseek-memory-capture.log"
