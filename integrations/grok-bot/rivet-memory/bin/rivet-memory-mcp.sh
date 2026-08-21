#!/usr/bin/env bash
# rivet-memory-mcp — launch the RivetOS MCP server in stdio mode for Cursor Grok Bot.
#
# This script provides a consistent, clean way to expose the RivetOS memory
# tools (memory_search, memory_browse, memory_stats, etc.) to Cursor Grok Bot via MCP.
#
# Usage in Grok Bot:
#   As a plugin (${CURSOR_PLUGIN_ROOT} expands when installed):
#     {
#       "mcpServers": {
#         "rivetos": {
#           "command": "${CURSOR_PLUGIN_ROOT}/bin/rivet-memory-mcp.sh"
#         }
#       }
#     }
#
#   Or point directly at the script (manual setup):
#     {
#       "mcpServers": {
#         "rivetos": {
#           "command": "/opt/rivetos/integrations/grok-bot/rivet-memory/bin/rivet-memory-mcp.sh"
#         }
#       }
#     }
#
# stdout is reserved for the JSON-RPC channel.
# All diagnostics and errors go to stderr.
set -euo pipefail

# RivetOS install root — override with RIVETOS_ROOT if installed elsewhere.
RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"

# Env file holding RIVETOS_PG_URL / RIVETOS_EMBED_URL (and other secrets).
RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"

# Load credentials so the memory tools are enabled.
# Without them, the server will still start but only expose echo + web tools.
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

CLI="$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js"
# pre-unification fallback (older checkouts still ship the shim path)
if [ ! -f "$CLI" ]; then
  CLI="$RIVETOS_ROOT/plugins/transports/mcp-server/dist/cli.js"
fi

if [ ! -f "$CLI" ]; then
  echo "rivet-memory: MCP server not found at $CLI" >&2
  echo "rivet-memory: Run 'npm run build' in $RIVETOS_ROOT" >&2
  exit 1
fi

# Grok Bot write-tag defaults. Sidecar write tools stay gated.
export RIVETOS_MEMORY_SOURCE="${RIVETOS_MEMORY_SOURCE:-grokbot}"
export RIVETOS_MEMORY_CHANNEL="${RIVETOS_MEMORY_CHANNEL:-grokbot}"
export RIVETOS_MEMORY_AGENT="${RIVETOS_MEMORY_AGENT:-rivet-grokbot}"
export RIVETOS_MCP_ENABLE_MEMORY_WRITE="${RIVETOS_MCP_ENABLE_MEMORY_WRITE:-1}"

# Tell the MCP server we're running in stdio mode.
export RIVETOS_MCP_STDIO=1

exec node "$CLI" --stdio
