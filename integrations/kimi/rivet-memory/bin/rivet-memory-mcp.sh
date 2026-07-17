#!/usr/bin/env bash
# rivet-memory-mcp — launch the RivetOS MCP server in stdio mode for Kimi Code CLI.
#
# This script provides a consistent, clean way to expose the RivetOS memory
# tools (memory_search, memory_browse, memory_stats, etc.) to kimi-code via MCP.
#
# Usage in kimi-code (mcp.json in the config dir):
#   {
#     "mcpServers": {
#       "rivetos": {
#         "command": "/path/to/rivetos/integrations/kimi/rivet-memory/bin/rivet-memory-mcp.sh"
#       }
#     }
#   }
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

# Tell the MCP server we're running in stdio mode.
export RIVETOS_MCP_STDIO=1

exec node "$CLI" --stdio
