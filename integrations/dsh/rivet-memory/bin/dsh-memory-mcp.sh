#!/usr/bin/env bash
# dsh-memory-mcp — launch the RivetOS MCP server in stdio mode for DeepSeek Harness.
#
# stdout is reserved for the JSON-RPC channel; every diagnostic goes to stderr.
# Never exits non-zero from a capture path failure: a broken memory server must
# not take the harness down with it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Shared install-root discovery + env loading (integrations/shared).
_rivet_paths=""
for _candidate in \
  "$SCRIPT_DIR/../../shared/rivet-paths.sh" \
  "$SCRIPT_DIR/../../../shared/rivet-paths.sh" \
  "${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/rivet-paths.sh"; do
  if [ -f "$_candidate" ]; then
    _rivet_paths="$_candidate"
    break
  fi
done
if [ -z "$_rivet_paths" ]; then
  echo "dsh-memory-mcp: rivet-paths.sh not found (tried $SCRIPT_DIR/../../shared/ and \${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/)" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$_rivet_paths"
unset _rivet_paths _candidate
unset SCRIPT_DIR

rivetos_load_env
RIVETOS_ROOT="$(rivetos_find_root)"
export RIVETOS_ROOT

# Root discovery accepts any checkout carrying nx.json + services/mcp-sidecar,
# including an unbuilt source tree. The MCP server only exists after a build, so
# fall back to a built install root instead of failing the whole tool surface.
if [ ! -f "$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js" ]; then
  for _built in /opt/rivetos "${HOME:-/root}/rivetOS"; do
    if [ -f "$_built/services/mcp-sidecar/dist/cli.js" ]; then
      echo "dsh-memory-mcp: '$RIVETOS_ROOT' is not built; using '$_built'" >&2
      RIVETOS_ROOT="$_built"
      export RIVETOS_ROOT
      break
    fi
  done
  unset _built
fi

# The sidecar refuses to start when an embed URL is set without a model id.
# The house env file carries RIVETOS_EMBED_MODEL; fall back to the vLLM id the
# embed server actually serves so a stripped environment still works.
if [ -n "${RIVETOS_EMBED_URL:-}" ] && [ -z "${RIVETOS_EMBED_MODEL:-}" ]; then
  export RIVETOS_EMBED_MODEL="nemotron-embed-8b"
fi

export RIVETOS_MCP_STDIO=1
CLI="$(rivetos_mcp_cli "$RIVETOS_ROOT")"
exec node "$CLI" --stdio
