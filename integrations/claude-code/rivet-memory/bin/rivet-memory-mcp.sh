#!/usr/bin/env bash
# rivet-memory-mcp — launch the RivetOS MCP server in stdio mode for a Claude
# Code plugin MCP entry.
#
# stdout is the JSON-RPC channel: only `node cli.js --stdio` may write to it.
# Every diagnostic in this script goes to stderr. The MCP server itself
# redirects its own console.log to stderr in stdio mode.
set -euo pipefail

# RivetOS install root — override with RIVETOS_ROOT if installed elsewhere.
RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
# Env file holding RIVETOS_PG_URL / RIVETOS_EMBED_URL.
RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"

# Load DB + embedding credentials so the memory tools come up. Without them the
# server still starts, but with echo + web tools only (memory disabled).
if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV"
  set +a
fi

CLI="$RIVETOS_ROOT/plugins/transports/mcp-server/dist/cli.js"
if [ ! -f "$CLI" ]; then
  echo "rivet-memory: MCP server not built at $CLI" >&2
  echo "rivet-memory: run 'npm run build' in $RIVETOS_ROOT" >&2
  exit 1
fi

export RIVETOS_MCP_STDIO=1
exec node "$CLI" --stdio
