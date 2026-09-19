#!/usr/bin/env bash
# rivet-paths.sh — shared RivetOS install-root discovery for the per-integration
# rivet-memory-mcp.sh launchers (and anything else that needs the install root).
#
# Source this file; it only defines functions — nothing runs at source time:
#
#   rivetos_load_env           Load credentials. Plugin / process RIVETOS_*
#                              vars win; empty plugin placeholders are treated
#                              as unset. Then fill gaps from
#                              $RIVETOS_ENV_FILE or ~/.rivetos/.env (house /
#                              power-user fallback). Maps a postgres
#                              RIVETOS_DATAHUB_URL onto RIVETOS_PG_URL when
#                              PG is still unset. Call BEFORE
#                              rivetos_find_root so a RIVETOS_ROOT set in the
#                              env file is honored.
#   rivetos_apply_datahub_url  If RIVETOS_PG_URL is empty and
#                              RIVETOS_DATAHUB_URL is a postgres URL, export
#                              it as RIVETOS_PG_URL. No-op for https den /
#                              other schemes (v1 contract is one PG-shaped
#                              DataHub endpoint).
#   rivetos_find_root          Echo the install root:
#                                1. RIVETOS_ROOT env (authoritative — set in
#                                   the process env or by rivetos_load_env)
#                                2. walk up from THIS FILE's real path
#                                   (rivetos_abs_path; portable, not
#                                   readlink -f) for a dir that passes the
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

# Resolve $1 to an absolute path. GNU `readlink -f` is missing on macOS
# bash 3.2; prefer perl, then a cd/pwd -P fallback. Used by rivetos_find_root
# so MCP launchers work on a laptop install.
rivetos_abs_path() {
  local target="$1"
  local resolved dir base phys candidate link hops
  if command -v perl >/dev/null 2>&1; then
    resolved="$(perl -MCwd -e 'print Cwd::abs_path(shift)' "$target" 2>/dev/null || true)"
    if [ -n "$resolved" ]; then
      printf '%s\n' "$resolved"
      return 0
    fi
  fi
  # GNU readlink (Linux). BSD readlink has no -f; swallow the failure.
  resolved="$(readlink -f "$target" 2>/dev/null || true)"
  if [ -n "$resolved" ]; then
    printf '%s\n' "$resolved"
    return 0
  fi
  dir="$(dirname "$target")"
  base="$(basename "$target")"
  if [ ! -d "$dir" ]; then
    return 1
  fi
  phys="$(cd "$dir" && pwd -P)" || return 1
  if [ "$phys" = "/" ]; then
    candidate="/$base"
  else
    candidate="$phys/$base"
  fi
  # Resolve chained symlinks in the final filename (perl/GNU readlink -f
  # already did this above; this covers macOS bash 3.2 with neither).
  # Cap at 32 hops so a cycle cannot loop forever.
  hops=0
  while [ -L "$candidate" ] && [ "$hops" -lt 32 ]; do
    hops=$((hops + 1))
    link="$(readlink "$candidate" 2>/dev/null || true)"
    if [ -z "$link" ]; then
      break
    fi
    case "$link" in
      /*) candidate="$link" ;;
      *)
        dir="$(dirname "$candidate")"
        if [ "$dir" = "/" ]; then
          candidate="/$link"
        else
          candidate="$dir/$link"
        fi
        ;;
    esac
  done
  printf '%s\n' "$candidate"
  return 0
}

# Names of currently exported RIVETOS_* variables (name only — never values).
rivetos_exported_rivetos_names() {
  printenv | awk -F= '$1 ~ /^RIVETOS_[A-Z0-9_]+$/ { print $1 }'
}

# Cursor / marketplace substitution can inject empty ${VAR} placeholders.
# Treat those as unset so ~/.rivetos/.env can fill them.
rivetos_unset_empty_rivetos_vars() {
  local n
  for n in $(rivetos_exported_rivetos_names); do
    if [ -z "${!n}" ]; then
      unset "$n"
    fi
  done
}

# Public name for the stranger DataHub field. v1 maps a postgres URL onto
# RIVETOS_PG_URL (the sidecar still speaks Postgres). HTTPS den / MCP-bridge
# endpoints stay on RIVETOS_DATAHUB_URL only — do not invent a conversion.
rivetos_apply_datahub_url() {
  if [ -n "${RIVETOS_PG_URL:-}" ]; then
    return 0
  fi
  local hub="${RIVETOS_DATAHUB_URL:-}"
  [ -n "$hub" ] || return 0
  case "$hub" in
    postgres://* | postgresql://*)
      export RIVETOS_PG_URL="$hub"
      ;;
  esac
}

rivetos_apply_cloud_defaults() {
  if [ "${RIVETOS_MODE:-}" = "cloud" ] && [ -z "${RIVETOS_CLOUD_URL:-}" ]; then
    export RIVETOS_CLOUD_URL="https://rivetos.cloud"
  fi
}

# Load DB + embedding credentials so the memory tools come up. Without them the
# server still starts, but with echo + web tools only (memory disabled).
#
# Read order: already-set (non-empty) RIVETOS_* from the process / plugin
# dashboard first, then ~/.rivetos/.env for anything still unset. House nodes
# keep working with only the env file.
rivetos_load_env() {
  local env_file="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
  local restore="" n

  rivetos_unset_empty_rivetos_vars

  # Save plugin/process values as `export NAME=quoted`. Do not use
  # `declare -p` here: `declare` inside a function is local (bash 3.2 has
  # no `declare -g`), so a sourced declare would vanish on return.
  restore="$(mktemp "${TMPDIR:-/tmp}/rivetos-env.XXXXXX" 2>/dev/null || true)"
  if [ -n "$restore" ]; then
    : >"$restore"
    for n in $(rivetos_exported_rivetos_names); do
      printf 'export %s=%q\n' "$n" "${!n}" >>"$restore"
    done
  fi

  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file" 2>/dev/null || true
    set +a
  fi

  if [ -n "$restore" ]; then
    # shellcheck disable=SC1090
    . "$restore" 2>/dev/null || true
    rm -f "$restore"
  fi

  rivetos_apply_datahub_url
  rivetos_apply_cloud_defaults
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
  probe="$(dirname "$(rivetos_abs_path "${BASH_SOURCE[0]}")")"
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
