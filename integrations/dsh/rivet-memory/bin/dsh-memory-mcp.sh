#!/usr/bin/env bash
# dsh-memory-mcp — launch the RivetOS MCP server in stdio mode for DeepSeek Harness.
#
# stdout is the JSON-RPC channel: only the MCP server may write to it. Every
# diagnostic in this script goes to stderr.
#
# Server selection is delegated to `rivetos_resolve_mcp_launch`, the same
# resolver the claude-code kit uses. On a RivetHub node that is `rh mcp`;
# elsewhere it is a built checkout's Node sidecar, or npx. Hand-rolling the
# choice here previously selected the Node sidecar on a RivetHub node, where
# every memory call failed with "den unreachable".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Shared install-root discovery + env loading (integrations/shared).
#
# Prefer an installed tree over a sibling source checkout. A checkout's copy of
# rivet-paths.sh can be older than the install and lack newer resolvers
# (rivetos_rh_mcp_bin arrived after this repo's Sep 2026 copy), and sourcing the
# stale one silently falls back to an unbuilt Node sidecar on a RivetHub node.
_rivet_paths=""
for _rivet_candidate in \
  "${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/rivet-paths.sh" \
  "${HOME:-/root}/.local/opt/rivetos/integrations/shared/rivet-paths.sh" \
  "/opt/rivetos/integrations/shared/rivet-paths.sh" \
  "$SCRIPT_DIR/../../shared/rivet-paths.sh" \
  "$SCRIPT_DIR/../../../shared/rivet-paths.sh"; do
  if [ -f "$_rivet_candidate" ]; then
    _rivet_paths="$_rivet_candidate"
    break
  fi
done
if [ -z "$_rivet_paths" ]; then
  echo "dsh-memory-mcp: rivet-paths.sh not found (tried \${RIVETOS_ROOT:-/opt/rivetos}, ~/.local/opt/rivetos, and $SCRIPT_DIR/../../shared/)" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$_rivet_paths"
unset _rivet_paths _rivet_candidate
unset SCRIPT_DIR # don't leak a global into the sourced namespace

# Plugin-hosted launch. collect_plugin_options supplies the den URL that
# load_env alone does not set, so it must run first.
export RIVETOS_PLUGIN_ENV=1
rivetos_collect_plugin_options

rivetos_load_env
RIVETOS_ROOT="$(rivetos_find_root)"
export RIVETOS_ROOT

# The sidecar refuses to start when an embed URL is set without a model id.
# The house env file carries RIVETOS_EMBED_MODEL; fall back to the id the embed
# server actually serves so a stripped environment still works.
if [ -n "${RIVETOS_EMBED_URL:-}" ] && [ -z "${RIVETOS_EMBED_MODEL:-}" ]; then
  export RIVETOS_EMBED_MODEL="nemotron-embed-8b"
fi

export RIVETOS_MCP_STDIO=1

kind="$(rivetos_resolve_mcp_launch)" || exit 1

case "$kind" in
  rh\ *)
    # RivetHub serves MCP itself over stdio; same env, no Node needed.
    exec "${kind#rh }" mcp
    ;;
  checkout\ *)
    exec node "${kind#checkout }" --stdio
    ;;
  npx)
    # npx chatter must never touch stdout (JSON-RPC).
    export npm_config_loglevel="${npm_config_loglevel:-error}"
    export NPM_CONFIG_UPDATE_NOTIFIER=false
    exec npx -y "$(rivetos_npx_mcp_spec)" --stdio
    ;;
  *)
    echo "dsh-memory-mcp: unrecognized launch kind '$kind'" >&2
    exit 1
    ;;
esac
