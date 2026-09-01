#!/usr/bin/env bash
# rivet-paths.sh — shared RivetOS install-root discovery for the per-integration
# rivet-memory-mcp.sh launchers (and anything else that needs the install root).
#
# Source this file; it only defines functions — nothing runs at source time:
#
#   rivetos_load_env           Source the credentials env file
#                              ($RIVETOS_ENV_FILE or ~/.rivetos/.env), exporting
#                              everything in it. Call BEFORE rivetos_find_root so
#                              a RIVETOS_ROOT set in the env file is honored.
#   rivetos_find_root          Echo the install root:
#                                1. RIVETOS_ROOT env (authoritative — set in
#                                   the process env or by rivetos_load_env)
#                                2. walk up from THIS FILE's real path
#                                   (readlink -f) for a dir that passes the
#                                   RivetOS sentinel: nx.json AND
#                                   services/mcp-sidecar both exist
#                                3. fall back to /opt/rivetos (documented
#                                   default install root)
#                              There is deliberately NO $PWD step: MCP
#                              launchers run with cwd = the USER's project,
#                              which is often an unrelated Nx repo whose
#                              nx.json must never bind the install root.
#   rivetos_mcp_cli <root>     Echo <root>/services/mcp-sidecar/dist/cli.js, or
#                              print a build hint to stderr and return 1.
#                              services/mcp-sidecar is the ONLY MCP server path —
#                              the pre-unification plugins/transports/mcp-server
#                              shim layout no longer exists on any node.
#
# Diagnostics go to stderr; function results go to stdout.

# Load DB + embedding credentials so the memory tools come up. Without them the
# server still starts, but with echo + web tools only (memory disabled).
rivetos_load_env() {
  local env_file="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file" 2>/dev/null || true
    set +a
  fi
}

rivetos_find_root() {
  # 1. Explicit override wins (process env, or set by rivetos_load_env).
  if [ -n "${RIVETOS_ROOT:-}" ]; then
    printf '%s\n' "$RIVETOS_ROOT"
    return 0
  fi
  # 2. Walk up from this file's real location; a candidate is only the
  #    install root if it passes the RivetOS sentinel — nx.json AND
  #    services/mcp-sidecar both exist. BASH_SOURCE[0] inside this function
  #    is rivet-paths.sh itself, wherever the launcher was invoked from.
  local probe
  probe="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
  while [ "$probe" != "/" ]; do
    if [ -f "$probe/nx.json" ] && [ -d "$probe/services/mcp-sidecar" ]; then
      printf '%s\n' "$probe"
      return 0
    fi
    probe="$(dirname "$probe")"
  done
  # 3. Documented default install root.
  printf '%s\n' /opt/rivetos
}

rivetos_mcp_cli() {
  local root="$1"
  local cli="$root/services/mcp-sidecar/dist/cli.js"
  if [ ! -f "$cli" ]; then
    echo "rivet-memory: MCP server not built at $cli" >&2
    echo "rivet-memory: run 'npm run build' in $root (or set RIVETOS_ROOT to a built tree)" >&2
    return 1
  fi
  printf '%s\n' "$cli"
}
