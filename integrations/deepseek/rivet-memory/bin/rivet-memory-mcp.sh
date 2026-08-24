#!/usr/bin/env bash
# rivet-memory-mcp — launch the RivetOS MCP server in stdio mode for dsh.
set -euo pipefail

RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
RIVETOS_ENV="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"

if [ -f "$RIVETOS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV" 2>/dev/null || true
  set +a
fi

CLI="$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js"
if [ ! -f "$CLI" ]; then
  CLI="$RIVETOS_ROOT/plugins/transports/mcp-server/dist/cli.js"
fi

if [ ! -f "$CLI" ]; then
  echo "rivet-memory: MCP server not found at $CLI" >&2
  echo "rivet-memory: Run 'npm run build' in $RIVETOS_ROOT" >&2
  exit 1
fi

export RIVETOS_MCP_STDIO=1
exec node "$CLI" --stdio
