#!/usr/bin/env bash
# Launch RivetOS memory MCP for Grok Bot (rivethub-grokbot).
#
# Thin wrapper: exec the sibling rivet-memory launcher so there is one
# MCP architecture. Plugin dashboard env (RIVETOS_MODE / DATAHUB / cloud
# token) is already in this process; the sibling's rivetos_load_env keeps
# those values and fills gaps from ~/.rivetos/.env.
#
# stdout is reserved for the JSON-RPC channel. Never print secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIBLING="$(cd "$ROOT/../rivet-memory/bin" 2>/dev/null && pwd)/rivet-memory-mcp.sh"
if [[ -x "$SIBLING" ]]; then
  exec "$SIBLING" "$@"
fi
if [[ -n "${RIVETOS_ROOT:-}" && -x "$RIVETOS_ROOT/integrations/grok-bot/rivet-memory/bin/rivet-memory-mcp.sh" ]]; then
  exec "$RIVETOS_ROOT/integrations/grok-bot/rivet-memory/bin/rivet-memory-mcp.sh" "$@"
fi
echo "rivethub-grokbot: rivet-memory MCP launcher not found (sibling or RIVETOS_ROOT)" >&2
exit 1
