#!/usr/bin/env bash
# rivet-memory-mcp — launch the RivetOS MCP server in stdio mode for a Claude
# Code plugin MCP entry.
#
# stdout is the JSON-RPC channel: only `node cli.js --stdio` may write to it.
# Every diagnostic in this script goes to stderr. The MCP server itself
# redirects its own console.log to stderr in stdio mode.
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

export RIVETOS_MCP_STDIO=1
CLI="$(rivetos_mcp_cli "$RIVETOS_ROOT")"
exec node "$CLI" --stdio
