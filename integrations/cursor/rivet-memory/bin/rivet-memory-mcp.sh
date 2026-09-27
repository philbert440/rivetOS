#!/usr/bin/env bash
# rivet-memory-mcp — launch the RivetOS MCP server in stdio mode for Cursor IDE.
#
# stdout is reserved for the JSON-RPC channel. Diagnostics go to stderr.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
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
  echo "rivet-memory-mcp: rivet-paths.sh not found" >&2
  exit 1
fi
. "$_rivet_paths"
unset _rivet_paths _rivet_candidate
unset SCRIPT_DIR

rivetos_load_env
RIVETOS_ROOT="$(rivetos_find_root)"
export RIVETOS_ROOT

# Cursor IDE write-tag defaults. Sidecar write tools stay gated by this flag.
export RIVETOS_MEMORY_SOURCE="${RIVETOS_MEMORY_SOURCE:-cursor}"
export RIVETOS_MEMORY_CHANNEL="${RIVETOS_MEMORY_CHANNEL:-cursor}"
export RIVETOS_MEMORY_AGENT="${RIVETOS_MEMORY_AGENT:-rivet-cursor}"
export RIVETOS_MCP_ENABLE_MEMORY_WRITE="${RIVETOS_MCP_ENABLE_MEMORY_WRITE:-1}"

export RIVETOS_MCP_STDIO=1
CLI="$(rivetos_mcp_cli "$RIVETOS_ROOT")"
exec node "$CLI" --stdio
