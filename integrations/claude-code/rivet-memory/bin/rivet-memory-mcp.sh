#!/usr/bin/env bash
# rivet-memory-mcp — launch the RivetOS MCP server in stdio mode for a Claude
# Code plugin MCP entry.
#
# stdout is the JSON-RPC channel: only the MCP server (checkout cli.js or
# npx @rivetos/mcp-sidecar) may write to it. Every diagnostic in this
# script goes to stderr.
#
# Resolution:
#   (a) built checkout ($RIVETOS_ROOT / walk-up / /opt/rivetos) — unchanged
#   (b) otherwise exec npx -y @rivetos/mcp-sidecar@<pin> --stdio
# The pin lives in integrations/shared/rivet-paths.sh and requires ≥ 0.5.0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Shared install-root discovery + env loading (integrations/shared).
# Plugin-local lib/ comes first so marketplace installs are self-contained.
# shellcheck source=../../../shared/rivet-paths.sh
_rivet_paths=""
for _rivet_candidate in \
  "$SCRIPT_DIR/../lib/rivet-paths.sh" \
  "$SCRIPT_DIR/../../../shared/rivet-paths.sh" \
  "${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/rivet-paths.sh"; do
  if [ -f "$_rivet_candidate" ]; then
    _rivet_paths="$_rivet_candidate"
    break
  fi
done
if [ -z "$_rivet_paths" ]; then
  echo "rivet-memory-mcp: rivet-paths.sh not found (tried $SCRIPT_DIR/../../../shared/, $SCRIPT_DIR/../lib/, and ${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/)" >&2
  exit 1
fi
. "$_rivet_paths"
unset _rivet_paths _rivet_candidate
unset SCRIPT_DIR # don't leak a global into the sourced namespace

# Plugin dashboard / userConfig first, then ~/.rivetos/.env.
# Never print PG URLs or tokens.
export RIVETOS_PLUGIN_ENV=1

# Primary channel: RIVETOS_PLUGIN_OPT_* set by this kit's .mcp.json.
# Secondary channel: CLAUDE_PLUGIN_OPTION_* honoured when the client provides it
# (the documented export for userConfig, and the one that carries `sensitive`
# values, which are not substituted into .mcp.json); it wins if both channels
# supply a value. Inherited RIVETOS_* values are not plugin settings.
RIVETOS_PLUGIN_KEYS=''
for _k in RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_EMBED_URL RIVETOS_EMBED_MODEL \
          RIVETOS_CLOUD_URL RIVETOS_CLOUD_TOKEN \
          RIVETOS_MCP_ENABLE_MEMORY_WRITE; do
  for _prefix in RIVETOS_PLUGIN_OPT_ CLAUDE_PLUGIN_OPTION_; do
    _opt="${_prefix}${_k}"
    if ! rivetos_is_effective_unset "${!_opt-}"; then
      export "${_k}=${!_opt}"
      RIVETOS_PLUGIN_KEYS="${RIVETOS_PLUGIN_KEYS} ${_k}"
    fi
    unset "$_opt"
  done
done
unset _k _opt _prefix

rivetos_load_env
unset RIVETOS_PLUGIN_KEYS

# Safe defaults: do not enable shell / file / search write tools.
# Memory write stays off unless the user opted in during onboard.
export RIVETOS_MCP_STDIO=1
RIVETOS_ROOT="$(rivetos_find_root)"
export RIVETOS_ROOT

kind="$(rivetos_resolve_mcp_launch)" || exit 1
if [ "${RIVETOS_MCP_LAUNCH_PRINT:-}" = "1" ]; then
  printf '%s\n' "$kind" >&2
  exit 0
fi

if [ "$kind" = npx ] && ! command -v npx >/dev/null 2>&1; then
  echo "rivet-memory-mcp: install Node.js/npm, or point RIVETOS_ROOT at a built RivetOS checkout" >&2
  exit 127
fi
if [ -z "${RIVETOS_PG_URL:-}" ] && [ -z "${RIVETOS_DATAHUB_URL:-}" ] && [ -z "${RIVETOS_CLOUD_TOKEN:-}" ]; then
  echo "rivet-memory-mcp: no DataHub/PG URL or cloud token — run rivetos-onboard or add ~/.rivetos/.env" >&2
fi

if ! rivetos_is_effective_unset "${RIVETOS_EMBED_URL:-}" &&
   { ! rivetos_is_effective_unset "${RIVETOS_PG_URL:-}" || ! rivetos_is_effective_unset "${RIVETOS_DATAHUB_URL:-}"; } &&
   rivetos_is_effective_unset "${RIVETOS_EMBED_MODEL:-}"; then
  echo "rivet-memory-mcp: RIVETOS_EMBED_MODEL is required when RIVETOS_EMBED_URL and a Postgres/DataHub URL are set" >&2
fi

case "$kind" in
  checkout\ *)
    CLI="${kind#checkout }"
    exec node "$CLI" --stdio
    ;;
  npx)
    spec="$(rivetos_npx_mcp_spec)"
    # npx chatter must not touch stdout (JSON-RPC).
    export npm_config_loglevel="${npm_config_loglevel:-error}"
    export NPM_CONFIG_UPDATE_NOTIFIER=false
    exec npx -y "$spec" --stdio
    ;;
  *)
    echo "rivet-memory-mcp: unknown launch kind" >&2
    exit 1
    ;;
esac
