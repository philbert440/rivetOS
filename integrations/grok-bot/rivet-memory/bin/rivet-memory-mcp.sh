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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Shared install-root discovery + env loading (integrations/shared).
# shellcheck source=../../../shared/rivet-paths.sh
_rivet_paths=""
for _rivet_candidate in \
  "$SCRIPT_DIR/../../../shared/rivet-paths.sh" \
  "${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/rivet-paths.sh"; do
  if [ -f "$_rivet_candidate" ]; then
    _rivet_paths="$_rivet_candidate"
    break
  fi
done
if [ -z "$_rivet_paths" ]; then
  echo "rivet-memory-mcp: rivet-paths.sh not found (tried $SCRIPT_DIR/../../../shared/ and ${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/)" >&2
  exit 1
fi
. "$_rivet_paths"
unset _rivet_paths _rivet_candidate
unset SCRIPT_DIR # don't leak a global into the sourced namespace

# Load RIVETOS_PG_URL / RIVETOS_EMBED_URL (and a possible RIVETOS_ROOT
# override) from ~/.rivetos/.env, then locate the install root.
rivetos_load_env
RIVETOS_ROOT="$(rivetos_find_root)"
export RIVETOS_ROOT

# Grok Bot write-tag defaults. Sidecar write tools stay gated.
export RIVETOS_MEMORY_SOURCE="${RIVETOS_MEMORY_SOURCE:-grokbot}"
export RIVETOS_MEMORY_CHANNEL="${RIVETOS_MEMORY_CHANNEL:-grokbot}"
export RIVETOS_MEMORY_AGENT="${RIVETOS_MEMORY_AGENT:-rivet-grokbot}"
export RIVETOS_MCP_ENABLE_MEMORY_WRITE="${RIVETOS_MCP_ENABLE_MEMORY_WRITE:-1}"

# Tell the MCP server we're running in stdio mode.
export RIVETOS_MCP_STDIO=1

CLI="$(rivetos_mcp_cli "$RIVETOS_ROOT")"
exec node "$CLI" --stdio
