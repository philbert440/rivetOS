#!/usr/bin/env bash
# rivet-paths.sh — shared RivetOS install-root discovery for the per-integration
# rivet-memory-mcp.sh launchers (and anything else that needs the install root).
#
# Source this file; it only defines functions — nothing runs at source time:
#
#   rivetos_load_env           Load credentials. Plugin / process RIVETOS_*
#                              vars win (same as packages/cli loadRivetEnv);
#                              empty values and unsubstituted ${VAR}
#                              placeholders count as unset. Then fill gaps
#                              from $RIVETOS_ENV_FILE or ~/.rivetos/.env by
#                              parsing KEY=VALUE (export prefix, quotes,
#                              last-wins). Never sources the file. A plugin
#                              postgres RIVETOS_DATAHUB_URL maps onto
#                              RIVETOS_PG_URL even when the env file still
#                              has a legacy PG URL. Call BEFORE
#                              rivetos_find_root so a RIVETOS_ROOT set in
#                              the env file is honored.
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

# Empty string or a leftover Cursor / marketplace `${NAME}` placeholder.
# Same rule as ingest-session.mjs. Never prints the value.
rivetos_is_effective_unset() {
  local v="${1-}"
  [ -z "$v" ] && return 0
  [[ "$v" =~ ^\$\{[A-Z0-9_]+\}$ ]]
}

rivetos_is_postgres_url() {
  case "${1-}" in
    postgres://* | postgresql://*) return 0 ;;
    *) return 1 ;;
  esac
}

rivetos_trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Match packages/cli parseEnvLine / unquoteEnvValue (export prefix, quotes,
# last-wins). Sets _rivetos_env_key and _rivetos_env_val. Returns 1 if the
# line is a comment, blank, or malformed.
rivetos_parse_env_line() {
  local raw="$1"
  local line rest key val
  line="${raw%$'\r'}"
  line="$(rivetos_trim "$line")"
  [ -n "$line" ] || return 1
  [ "${line:0:1}" = "#" ] && return 1

  if [ "${line#export}" != "$line" ]; then
    rest="${line#export}"
    if [[ "$rest" =~ ^[[:space:]] ]]; then
      line="$(rivetos_trim "$rest")"
    fi
  fi

  case "$line" in
    *=*) ;;
    *) return 1 ;;
  esac
  key="$(rivetos_trim "${line%%=*}")"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  val="$(rivetos_unquote_env_value "${line#*=}")"
  _rivetos_env_key="$key"
  _rivetos_env_val="$val"
  return 0
}

rivetos_unquote_env_value() {
  local s i c n out
  s="$(rivetos_trim "$1")"
  if [ -z "$s" ] || [ "${s:0:1}" = "#" ]; then
    printf ''
    return 0
  fi
  if [ "${s:0:1}" = "'" ]; then
    s="${s:1}"
    case "$s" in
      *"'"*) printf '%s' "${s%%\'*}" ;;
      *) printf '%s' "$s" ;;
    esac
    return 0
  fi
  if [ "${s:0:1}" = '"' ]; then
    s="${s:1}"
    out=""
    i=0
    while [ "$i" -lt "${#s}" ]; do
      c="${s:i:1}"
      if [ "$c" = '"' ]; then
        break
      fi
      if [ "$c" = '\' ] && [ "$((i + 1))" -lt "${#s}" ]; then
        n="${s:$((i + 1)):1}"
        case "$n" in
          n) out+=$'\n' ;;
          t) out+=$'\t' ;;
          r) out+=$'\r' ;;
          *) out+="$n" ;;
        esac
        i=$((i + 2))
        continue
      fi
      out+="$c"
      i=$((i + 1))
    done
    printf '%s' "$out"
    return 0
  fi
  printf '%s' "$s" | sed 's/[[:space:]]\{1,\}#.*$//'
}

# Last assignment of KEY wins (systemd / CLI semantics).
rivetos_env_file_value() {
  local file="$1"
  local want="$2"
  local line found=""
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    if rivetos_parse_env_line "$line" && [ "$_rivetos_env_key" = "$want" ]; then
      found="$_rivetos_env_val"
    fi
  done <"$file"
  printf '%s' "$found"
}

# Export every parsed assignment. Later lines overwrite earlier ones.
rivetos_apply_env_file() {
  local file="$1"
  local line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    if rivetos_parse_env_line "$line"; then
      export "${_rivetos_env_key}=${_rivetos_env_val}"
    fi
  done <"$file"
}

# Single-quote with '\'' escaping so a sourced file cannot expand $ or `.
rivetos_quote_env_value() {
  local s="$1"
  printf "'%s'" "${s//\'/\'\\\'\'}"
}

# URL on stdin. Prints "scheme host port" or nothing. Never echoes userinfo.
# $1 is the default port for a bare host[:port] (no ://).
rivetos_redact_endpoint() {
  local default_port="${1:-5432}"
  python3 -c '
import sys
from urllib.parse import urlparse

raw = sys.stdin.read().strip()
default_port = int(sys.argv[1]) if len(sys.argv) > 1 else 5432
if not raw:
    raise SystemExit(0)

def emit(scheme, host, port):
    if host:
        print(f"{scheme} {host} {port}")

if "://" in raw:
    u = urlparse(raw)
    host = u.hostname or ""
    scheme = (u.scheme or "").lower() or "tcp"
    if u.port:
        port = u.port
    elif scheme.startswith("postgres"):
        port = 5432
    elif scheme == "https":
        port = 443
    elif scheme == "http":
        port = 80
    else:
        port = default_port
    emit(scheme or "tcp", host, port)
    raise SystemExit(0)

scheme = "tcp"
host = ""
port = default_port
if raw.startswith("["):
    end = raw.find("]")
    if end == -1:
        raise SystemExit(0)
    host = raw[1:end]
    rest = raw[end + 1 :]
    if rest.startswith(":") and rest[1:].isdigit():
        port = int(rest[1:])
elif raw.count(":") == 1:
    left, right = raw.rsplit(":", 1)
    if left and right.isdigit():
        host = left
        port = int(right)
    else:
        host = raw
else:
    host = raw
emit(scheme, host, port)
' "$default_port"
}

# Cursor / marketplace substitution can inject empty ${VAR} placeholders.
# Treat those as unset so ~/.rivetos/.env can fill them.
rivetos_unset_empty_rivetos_vars() {
  local n
  for n in $(rivetos_exported_rivetos_names); do
    if rivetos_is_effective_unset "${!n}"; then
      unset "$n"
    fi
  done
}

# Public name for the stranger DataHub field. v1 maps a postgres URL onto
# RIVETOS_PG_URL (the sidecar still speaks Postgres). HTTPS den / MCP-bridge
# endpoints stay on RIVETOS_DATAHUB_URL only — do not invent a conversion.
# Pass "force" to overwrite an existing PG URL (plugin DataHub re-onboard).
rivetos_apply_datahub_url() {
  local force="${1-}"
  if [ "$force" != "force" ] && ! rivetos_is_effective_unset "${RIVETOS_PG_URL:-}"; then
    return 0
  fi
  local hub="${RIVETOS_DATAHUB_URL:-}"
  rivetos_is_effective_unset "$hub" && return 0
  if rivetos_is_postgres_url "$hub"; then
    export RIVETOS_PG_URL="$hub"
  fi
}

rivetos_apply_cloud_defaults() {
  if [ "${RIVETOS_MODE:-}" = "cloud" ] && rivetos_is_effective_unset "${RIVETOS_CLOUD_URL:-}"; then
    export RIVETOS_CLOUD_URL="https://rivetos.cloud"
  fi
}

# Load DB + embedding credentials so the memory tools come up. Without them the
# server still starts, but with echo + web tools only (memory disabled).
#
# Read order: already-set (non-empty, non-placeholder) RIVETOS_* from the
# process / plugin dashboard first, then ~/.rivetos/.env for anything still
# unset. Every harness launcher that sources this file shares that order.
# It matches packages/cli loadRivetEnv (process wins). A stale shell export
# therefore beats the env file, same as a plugin var.
rivetos_load_env() {
  local env_file="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
  local restore="" n plugin_datahub plugin_pg

  rivetos_unset_empty_rivetos_vars
  plugin_datahub="${RIVETOS_DATAHUB_URL:-}"
  plugin_pg="${RIVETOS_PG_URL:-}"

  # Keep the restore string in memory. Do not use declare -p: declare
  # inside a function is local (bash 3.2 has no declare -g).
  for n in $(rivetos_exported_rivetos_names); do
    restore="${restore}$(printf 'export %s=%q\n' "$n" "${!n}")"$'\n'
  done

  if [ -f "$env_file" ]; then
    rivetos_apply_env_file "$env_file"
  fi

  if [ -n "$restore" ]; then
    eval "$restore"
  fi

  # Plugin DataHub wins over a leftover file PG URL. A process PG URL
  # still wins when both were set in the plugin / shell.
  if rivetos_is_postgres_url "$plugin_datahub" && rivetos_is_effective_unset "$plugin_pg"; then
    rivetos_apply_datahub_url force
  else
    rivetos_apply_datahub_url
  fi
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
