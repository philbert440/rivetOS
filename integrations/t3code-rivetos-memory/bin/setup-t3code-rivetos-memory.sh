#!/usr/bin/env bash
#
# setup-t3code-rivetos-memory.sh
#
# Prototype installer. T3 Code has no first-class plugin loader, so this
# writes the closest artifacts T3 / its harnesses can consume:
#
#   --print   (default)  Show Claude / Codex / OpenCode / T3-HTTP snippets
#   --apply              Write generated files under ~/.rivetos/t3code-rivetos-memory/
#                        and merge mcpServers.rivetos into ~/.claude.json when
#                        that file is missing or valid JSON
#   --remove             Delete generated files and the rivetos Claude MCP key
#   --force              Replace an existing rivetos Claude MCP entry
#
# Never prints secret values.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-$(cd "$PLUGIN_DIR/../../.." && pwd)}"
PLUGIN_PATH="$RIVETOS_ROOT/integrations/t3code-rivetos-memory"
LAUNCHER="$PLUGIN_PATH/bin/rivet-memory-mcp.sh"
HTTP_LAUNCHER="$PLUGIN_PATH/bin/rivet-memory-mcp-http.sh"
MCP_HOST="${MCP_HOST:-127.0.0.1}"
MCP_PORT="${MCP_PORT:-5700}"
MCP_URL="http://${MCP_HOST}:${MCP_PORT}/mcp"
STATE_DIR="${RIVETOS_HOME:-$HOME/.rivetos}/t3code-rivetos-memory"
CLAUDE_JSON="${CLAUDE_CONFIG_FILE:-$HOME/.claude.json}"

DO_APPLY=0
DO_FORCE=0
DO_REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --apply) DO_APPLY=1 ;;
    --force) DO_FORCE=1 ;;
    --remove) DO_REMOVE=1 ;;
    --print) ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

merge_claude_json() {
  local mode="$1"
  node - "$CLAUDE_JSON" "$LAUNCHER" "$mode" "$DO_FORCE" <<'JS'
const fs = require('node:fs')
const cfgPath = process.argv[2]
const launcher = process.argv[3]
const mode = process.argv[4]
const force = process.argv[5] === '1'
const exists = fs.existsSync(cfgPath)
let data = {}
if (exists) {
  try {
    data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  } catch {
    console.log(`⚠️  ${cfgPath} is not plain JSON — leaving it; wrote the fragment only`)
    process.exit(0)
  }
}
if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) {
  data.mcpServers = {}
}
if (mode === 'remove') {
  if (!data.mcpServers.rivetos) {
    console.log(`No rivetos MCP entry in ${cfgPath}`)
    process.exit(0)
  }
  delete data.mcpServers.rivetos
  fs.writeFileSync(cfgPath, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`✅ Removed rivetos MCP from ${cfgPath}`)
  process.exit(0)
}
if (data.mcpServers.rivetos && !force) {
  console.log(`RivetOS MCP already in ${cfgPath} (use --force to replace it)`)
  process.exit(0)
}
data.mcpServers.rivetos = { command: 'bash', args: [launcher] }
fs.writeFileSync(cfgPath, `${JSON.stringify(data, null, 2)}\n`)
console.log(`✅ Wrote mcpServers.rivetos to ${cfgPath}`)
JS
}

if [ "$DO_REMOVE" -eq 1 ]; then
  rm -rf "$STATE_DIR"
  echo "Removed $STATE_DIR"
  if [ -f "$CLAUDE_JSON" ]; then
    merge_claude_json remove
  fi
  exit 0
fi

echo "T3 Code rivet-memory prototype"
echo "RivetOS root: $RIVETOS_ROOT"
echo "Plugin path:  $PLUGIN_PATH"
echo
echo "T3 has no first-class plugin API and no context-injection hook."
echo "Registration is harness-native MCP (works today) plus a T3-shaped HTTP mcpUrl (RFC #6419, not shipped)."
echo

echo "=== 1. Claude (T3 loads settingSources user/project/local) ==="
cat <<EOF
# ~/.claude.json  (or \$CLAUDE_CONFIG_DIR)
{
  "mcpServers": {
    "rivetos": {
      "command": "bash",
      "args": ["$LAUNCHER"]
    }
  }
}
EOF
echo

echo "=== 2. Codex (T3 launches Codex with that home's config) ==="
cat <<EOF
codex mcp add rivetos -- bash $LAUNCHER
# or add [mcp_servers.rivetos] to ~/.codex/config.toml
EOF
echo

echo "=== 3. OpenCode ==="
cat <<EOF
# ~/.config/opencode/opencode.json
{
  "mcp": {
    "rivetos": {
      "type": "local",
      "command": ["bash", "$LAUNCHER"],
      "enabled": true
    }
  }
}
EOF
echo

echo "=== 4. T3 HTTP mcpUrl (type:http, no headers — matches t3-code shape) ==="
cat <<EOF
# Start the sidecar:
bash $HTTP_LAUNCHER
# Health: $MCP_URL replaced by http://${MCP_HOST}:${MCP_PORT}/health/live
# Proposed plugin entry (t3-plugin.json):
{
  "name": "rivetos-memory",
  "url": "http://${MCP_HOST}:${MCP_PORT}/",
  "mcpUrl": "$MCP_URL"
}
# Current T3 does not merge this automatically. If/when Add plugin ships,
# paste mcpUrl. Until then this is the documented closest shape.
EOF
echo

echo "=== Env (never commit secrets) ==="
echo "Read from ~/.rivetos/.env or the process environment:"
echo "  RIVETOS_PG_URL / RIVETOS_DATAHUB_URL   required for memory_* tools"
echo "  RIVETOS_EMBED_URL + RIVETOS_EMBED_MODEL  optional hybrid search"
echo "  RIVETOS_MCP_ENABLE_MEMORY_WRITE=1        opt-in store (memory_append)"
echo "  RIVETOS_ROOT                             RivetOS checkout (default /opt/rivetos)"
echo "  MCP_HOST / MCP_PORT                      HTTP bind (default 127.0.0.1:5700)"
echo

if [ "$DO_APPLY" -eq 1 ]; then
  echo "=== Applying (--apply) ==="
  mkdir -p "$STATE_DIR"
  node - "$STATE_DIR" "$PLUGIN_PATH" "$MCP_HOST" "$MCP_PORT" <<'JS'
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const [stateDir, pluginRoot, host, port] = process.argv.slice(2)
import(pathToFileURL(path.join(pluginRoot, 'src', 'register.mjs')).href).then(({ buildRegistration }) => {
  const reg = buildRegistration({ pluginRoot, host, port: Number(port) })
  const write = (name, value) => {
    const dest = path.join(stateDir, name)
    fs.writeFileSync(dest, `${JSON.stringify(value, null, 2)}\n`)
    console.log(`✅ Wrote ${dest}`)
  }
  write('t3-plugin.json', reg.plugin)
  write('claude.mcp.json', reg.claudeStdio)
  write('t3-http.mcp.json', reg.t3Http)
  write('opencode.mcp.json', reg.opencode)
})
JS
  merge_claude_json apply
  echo "Start a new T3 thread after the harness reloads MCP."
fi
