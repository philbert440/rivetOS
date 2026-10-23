#!/usr/bin/env bash
# setup-dsh-rivet-memory — wire RivetOS memory into a DeepSeek Harness profile.
#
# Adds two things to the profile:
#   1. the @rivetos/dsh-rivet-memory bundle  (session capture)
#   2. an mcp-client entry named "rivetos"   (recall tools)
#
# Idempotent: re-running rewrites the same link and does not duplicate the MCP
# entry. Use --dry-run to print the resolved paths without touching anything.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RIVET_MEMORY="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PLUGIN_DIR="$RIVET_MEMORY/plugin"
MCP_LAUNCHER="$SCRIPT_DIR/dsh-memory-mcp.sh"

PROFILE="${DSH_PROFILE:-desktop}"
APPLY=0

usage() {
  cat <<'USAGE'
Usage: setup-dsh-rivet-memory.sh [--profile <name>] [--apply]

  --profile <name>  dsh profile to wire (default: $DSH_PROFILE, else desktop)
  --apply           write the changes; without it nothing is modified
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile needs a name}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "setup-dsh-rivet-memory: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

echo "profile:   $PROFILE"
echo "directory: $PROFILE_DIR"
echo "plugin:    $PLUGIN_DIR"
echo "mcp:       $MCP_LAUNCHER"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "setup-dsh-rivet-memory: no such profile '$PROFILE' ($PROFILE_DIR)" >&2
  echo "  existing: $(ls "$DSH_HOME/profiles" 2>/dev/null | tr '\n' ' ')" >&2
  exit 1
fi
if [ ! -f "$PLUGIN_DIR/index.mjs" ]; then
  echo "setup-dsh-rivet-memory: plugin missing at $PLUGIN_DIR" >&2
  exit 1
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "dry run — pass --apply to write the changes"
  exit 0
fi

# 1. Link the bundle into the profile's node_modules.
mkdir -p "$PROFILE_DIR/node_modules/@rivetos"
ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/@rivetos/dsh-rivet-memory"

# 2. Register it as a dependency and a bundle. Rewritten in place so the file
#    stays valid JSON and re-running does not duplicate entries.
node - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" <<'NODE'
const fs = require('node:fs')
const [file, pluginDir] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies ??= {}
pkg.dependencies['@rivetos/dsh-rivet-memory'] = `link:${pluginDir}`
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
const bundles = pkg.dsh.profile.bundles ?? []
if (!bundles.includes('@rivetos/dsh-rivet-memory')) bundles.push('@rivetos/dsh-rivet-memory')
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
NODE

# 3. Add the MCP entry to the patch layer when absent.
PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ ! -f "$PATCH" ]; then
  printf '# Your patch layer for this dsh profile.\n' > "$PATCH"
fi
# A bare `[]` is an empty top-level array; appending entries below it would
# produce two YAML documents and the loader would ignore the second.
if grep -qx '\[\]' "$PATCH" 2>/dev/null; then
  grep -vx '\[\]' "$PATCH" > "$PATCH.tmp" && mv "$PATCH.tmp" "$PATCH"
fi
if ! grep -q 'id: mcp-rivetos' "$PATCH" 2>/dev/null; then
  # New plugins must arrive under `insert:`. A bare `{id, name, config}` entry
  # is treated as an override of an existing entry and is skipped, so the MCP
  # server would silently never load.
  cat >> "$PATCH" <<YAML
# RivetOS shared memory tools (recall/browse/stats) over the house DataHub.
- insert:
    - id: mcp-rivetos
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: stdio
        serverName: rivetos
        command: $MCP_LAUNCHER
        args: []
        failOnStartupError: false
        toolCallTimeoutMs: 60000
YAML
  echo "added mcp-rivetos to $PATCH"
else
  echo "mcp-rivetos already present in $PATCH"
fi

echo
echo "done. Verify capture with:"
echo "  tail -f ~/.rivetos/deepseek-memory-capture.log"
