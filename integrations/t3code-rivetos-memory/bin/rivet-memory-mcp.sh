#!/usr/bin/env bash
# rivet-memory-mcp — launch the RivetOS MCP sidecar in stdio mode for a
# T3-launched harness (Claude / Codex / OpenCode / Grok).
#
# T3 itself does not spawn this file. T3 starts the harness; the harness
# starts this launcher from its own mcpServers entry.
#
# stdout is the JSON-RPC channel. Diagnostics go to stderr.
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
  echo "rivet-memory-mcp: rivet-paths.sh not found (tried $SCRIPT_DIR/../../../shared/ and ${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/)" >&2
  exit 1
fi
. "$_rivet_paths"
unset _rivet_paths _rivet_candidate
unset SCRIPT_DIR

rivetos_load_env
RIVETOS_ROOT="$(rivetos_find_root)"
export RIVETOS_ROOT
export RIVETOS_MCP_STDIO=1

kind="$(rivetos_resolve_mcp_launch)" || exit 1
if [ "${RIVETOS_MCP_LAUNCH_PRINT:-}" = "1" ]; then
  printf '%s\n' "$kind" >&2
  exit 0
fi

if [ "${kind}" = npx ] && ! command -v npx >/dev/null 2>&1; then
  echo "rivet-memory-mcp: install Node.js/npm, or point RIVETOS_ROOT at a built RivetOS checkout" >&2
  exit 127
fi
if [ -z "${RIVETOS_PG_URL:-}" ] && [ -z "${RIVETOS_DATAHUB_URL:-}" ] && [ -z "${RIVETOS_CLOUD_TOKEN:-}" ]; then
  echo "rivet-memory-mcp: no DataHub/PG URL or cloud token — memory tools stay off (echo + web only)" >&2
fi

case "$kind" in
  checkout\ *)
    CLI="${kind#checkout }"
    exec node "$CLI" --stdio
    ;;
  npx)
    spec="$(rivetos_npx_mcp_spec)"
    export npm_config_loglevel="${npm_config_loglevel:-error}"
    export NPM_CONFIG_UPDATE_NOTIFIER=false
    exec npx -y "$spec" --stdio
    ;;
  *)
    echo "rivet-memory-mcp: unknown launch kind" >&2
    exit 1
    ;;
esac
