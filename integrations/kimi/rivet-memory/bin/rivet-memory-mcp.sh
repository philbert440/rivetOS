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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Shared install-root discovery + env loading (integrations/shared).
# shellcheck source=../../../shared/rivet-paths.sh
. "$SCRIPT_DIR/../../../shared/rivet-paths.sh"
unset SCRIPT_DIR # don't leak a global into the sourced namespace

# Load RIVETOS_PG_URL / RIVETOS_EMBED_URL (and a possible RIVETOS_ROOT
# override) from ~/.rivetos/.env, then locate the install root.
rivetos_load_env
RIVETOS_ROOT="$(rivetos_find_root)"
export RIVETOS_ROOT

# Tell the MCP server we're running in stdio mode.
export RIVETOS_MCP_STDIO=1

CLI="$(rivetos_mcp_cli "$RIVETOS_ROOT")"
exec node "$CLI" --stdio
