#!/usr/bin/env bash
# rivet-memory-mcp — launch the RivetOS MCP server in stdio mode for dsh.
#
# stdout is reserved for the JSON-RPC channel.
# All diagnostics and errors go to stderr.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Shared install-root discovery + env loading (integrations/shared).
# shellcheck source=../../../shared/rivet-paths.sh
. "$SCRIPT_DIR/../../../shared/rivet-paths.sh"
unset SCRIPT_DIR # don't leak a global into the sourced namespace

rivetos_load_env
RIVETOS_ROOT="$(rivetos_find_root)"
export RIVETOS_ROOT

export RIVETOS_MCP_STDIO=1
CLI="$(rivetos_mcp_cli "$RIVETOS_ROOT")"
exec node "$CLI" --stdio
