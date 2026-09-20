#!/usr/bin/env bash
# rivet-paths.sh — shared RivetOS install-root discovery for the per-integration
# rivet-memory-mcp.sh launchers (and anything else that needs the install root).
#
# Source this file; it only defines functions — nothing runs at source time:
#
#   rivetos_load_env           Load credentials by parsing KEY=VALUE
#                              (export prefix, quotes, last-wins). Never
#                              sources the file. Default (main): the env
#                              file wins, matching historical harness
#                              launchers. Unquoted $VAR, ${VAR},
#                              ${VAR:-default}, ${VAR-default}, and a
#                              leading ~ or ~/… expand (so $HOME/rivetos
#                              and ~/rivetos still work). The same $VAR
#                              / ${VAR} / ${VAR:-default} / ${VAR-default}
#                              forms expand inside double quotes (bash);
#                              \$ is a literal dollar (persist). a~b and
#                              "~/x" stay literal. Unquoted # is a comment
#                              only after whitespace or at line start
#                              (KEY=#x and KEY=a#b keep the hash).
#                              Double-quoted escapes match bash: only
#                              \\ \" \$ \` lose their backslash.
#                              $( ) and backticks do not expand. Other
#                              ${…} operators, concatenated quotes, and
#                              a trailing-backslash continuation stay
#                              literal and emit one stderr warning that
#                              names the key (never the value).
#                              When RIVETOS_PLUGIN_ENV=1, already-set
#                              (non-empty, non-placeholder) process /
#                              plugin vars win, and a plugin postgres
#                              RIVETOS_DATAHUB_URL maps onto
#                              RIVETOS_PG_URL even when the env file
#                              still has a legacy PG URL. Call BEFORE
#                              rivetos_find_root so a RIVETOS_ROOT set
#                              in the env file is honored.
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

# Match packages/cli parseEnvLine on export prefix, quotes, last-wins.
# Double-quoted escapes match bash (not CLI's historical \n→newline).
# Sets _rivetos_env_key, _rivetos_env_val, _rivetos_env_quote, and
# optionally _rivetos_env_unsupported. Returns 1 if the line is a
# comment, blank, or malformed.
rivetos_has_non_ascii() {
  local LC_ALL=C LANG=C
  local s="$1" i=0 c
  while [ "$i" -lt "${#s}" ]; do
    c="${s:i:1}"
    case "$c" in
      [[:print:]] | [[:cntrl:]]) ;;
      *) return 0 ;;
    esac
    i=$((i + 1))
  done
  return 1
}

# Consume one $ / ${…} construct at s[i] (s[i] is $). Writes
# _rivetos_consume_out and _rivetos_consume_next_i. Never prints a value.
# ${VAR:-default} / ${VAR-default} recurse through rivetos_expand_params
# for the default. Unsupported operators / $( stay literal and set
# _rivetos_expand_unsupported.
rivetos_consume_dollar() {
  local s="$1"
  local i="$2"
  local n name rest body default val j ch
  _rivetos_consume_out='$'
  _rivetos_consume_next_i=$((i + 1))
  if [ "$((i + 1))" -ge "${#s}" ]; then
    return 0
  fi
  n="${s:$((i + 1)):1}"
  if [ "$n" = '(' ]; then
    _rivetos_expand_unsupported="${_rivetos_expand_unsupported:-command substitution}"
    return 0
  fi
  if [ "$n" = '{' ]; then
    rest="${s:$((i + 2))}"
    case "$rest" in
      *'}'*) body="${rest%%\}*}" ;;
      *) return 0 ;;
    esac
    if [[ "$body" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      _rivetos_consume_out="${!body-}"
      _rivetos_consume_next_i=$((i + 3 + ${#body}))
      return 0
    fi
    if [[ "$body" =~ ^[A-Za-z_][A-Za-z0-9_]*:- ]]; then
      name="${body%%:-*}"
      default="${body#*:-}"
      rivetos_expand_params "$default"
      default="$_rivetos_expand_out"
      val="${!name-}"
      if [ -n "$val" ]; then
        _rivetos_consume_out="$val"
      else
        _rivetos_consume_out="$default"
      fi
      _rivetos_consume_next_i=$((i + 3 + ${#body}))
      return 0
    fi
    if [[ "$body" =~ ^[A-Za-z_][A-Za-z0-9_]*- ]]; then
      name="${body%%-*}"
      default="${body#*-}"
      rivetos_expand_params "$default"
      default="$_rivetos_expand_out"
      if declare -p "$name" >/dev/null 2>&1; then
        _rivetos_consume_out="${!name}"
      else
        _rivetos_consume_out="$default"
      fi
      _rivetos_consume_next_i=$((i + 3 + ${#body}))
      return 0
    fi
    _rivetos_expand_unsupported="${_rivetos_expand_unsupported:-parameter expansion operator}"
    _rivetos_consume_out='${'
    _rivetos_consume_out+="$body"
    _rivetos_consume_out+='}'
    _rivetos_consume_next_i=$((i + 3 + ${#body}))
    return 0
  fi
  if [[ "$n" =~ [A-Za-z_] ]]; then
    rest="${s:$((i + 1))}"
    name=""
    j=0
    while [ "$j" -lt "${#rest}" ]; do
      ch="${rest:j:1}"
      case "$ch" in
        [A-Za-z0-9_]) name+="$ch" ;;
        *) break ;;
      esac
      j=$((j + 1))
    done
    _rivetos_consume_out="${!name-}"
    _rivetos_consume_next_i=$((i + 1 + ${#name}))
  fi
}

# $VAR / ${VAR} / ${VAR:-default} / ${VAR-default} from the environment.
# No command substitution. Writes the result to _rivetos_expand_out (not
# stdout) so the caller is not a subshell and can read
# _rivetos_expand_unsupported. Never prints a value.
rivetos_expand_params() {
  local s="$1" out="" i=0 c
  while [ "$i" -lt "${#s}" ]; do
    c="${s:i:1}"
    if [ "$c" = '`' ]; then
      _rivetos_expand_unsupported="${_rivetos_expand_unsupported:-backticks}"
      out+="$c"
      i=$((i + 1))
      continue
    fi
    if [ "$c" = '$' ]; then
      rivetos_consume_dollar "$s" "$i"
      out+="$_rivetos_consume_out"
      i="$_rivetos_consume_next_i"
      continue
    fi
    out+="$c"
    i=$((i + 1))
  done
  _rivetos_expand_out="$out"
}

rivetos_parse_env_line() {
  local raw="$1"
  local line rest key val bom
  bom="$(printf '\357\273\277')"
  case "$raw" in
    "$bom"*) raw="${raw#"$bom"}" ;;
  esac
  line="${raw%$'\r'}"
  line="$(rivetos_trim "$line")"
  [ -n "$line" ] || return 1
  [ "${line:0:1}" = "#" ] && return 1
  _rivetos_env_quote=none
  _rivetos_env_unsupported=""

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
  val="$(rivetos_trim "${line#*=}")"
  case "$val" in
    \'*) _rivetos_env_quote=single ;;
    \"*) _rivetos_env_quote=double ;;
    *) _rivetos_env_quote=none ;;
  esac
  if [ "$_rivetos_env_quote" = none ]; then
    case "$val" in
      *\\) _rivetos_env_unsupported="trailing-backslash continuation" ;;
    esac
  fi
  rivetos_unquote_env_value "$val"
  val="$_rivetos_unquote_out"
  _rivetos_env_key="$key"
  _rivetos_env_val="$val"
  return 0
}

rivetos_unquote_env_value() {
  local s i c n out rest
  s="$(rivetos_trim "$1")"
  _rivetos_unquote_out=""
  # bash: # starts a comment at line start or after whitespace, not at
  # the first character of an unquoted value (KEY=#x stays #x).
  if [ -z "$s" ]; then
    return 0
  fi
  if [ "${s:0:1}" = "'" ]; then
    s="${s:1}"
    case "$s" in
      *"'"*)
        _rivetos_unquote_out="${s%%\'*}"
        rest="${s#*\'}"
        rest="$(rivetos_trim "$rest")"
        if [ -n "$rest" ] && [ "${rest:0:1}" != "#" ]; then
          _rivetos_env_unsupported="${_rivetos_env_unsupported:-concatenated quotes}"
        fi
        ;;
      *) _rivetos_unquote_out="$s" ;;
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
        rest="${s:$((i + 1))}"
        rest="$(rivetos_trim "$rest")"
        if [ -n "$rest" ] && [ "${rest:0:1}" != "#" ]; then
          _rivetos_env_unsupported="${_rivetos_env_unsupported:-concatenated quotes}"
        fi
        break
      fi
      if [ "$c" = '\' ] && [ "$((i + 1))" -lt "${#s}" ]; then
        n="${s:$((i + 1)):1}"
        case "$n" in
          \\ | \" | \$ | \`) out+="$n" ;;
          *) out+="\\$n" ;;
        esac
        i=$((i + 2))
        continue
      fi
      # Unescaped $NAME / ${NAME} / ${NAME:-d} expand here so \$ (already
      # handled above) stays a literal dollar — persist round-trips.
      if [ "$c" = '$' ]; then
        rivetos_consume_dollar "$s" "$i"
        out+="$_rivetos_consume_out"
        i="$_rivetos_consume_next_i"
        continue
      fi
      if [ "$c" = '`' ]; then
        _rivetos_env_unsupported="${_rivetos_env_unsupported:-backticks}"
      fi
      out+="$c"
      i=$((i + 1))
    done
    _rivetos_unquote_out="$out"
    return 0
  fi
  _rivetos_unquote_out="$(printf '%s' "$s" | sed 's/[[:space:]]\{1,\}#.*$//')"
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
  local line val construct
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    _rivetos_env_unsupported=""
    _rivetos_expand_unsupported=""
    if rivetos_parse_env_line "$line"; then
      val="$_rivetos_env_val"
      construct="${_rivetos_env_unsupported:-}"
      # Unquoted ~ / ~/… → $HOME (replace the leading ~, do not prepend
      # onto it — ${val#~/} tilde-expands the pattern and leaves ~/ in
      # place). Double-quoted $VAR is expanded during unquote so that
      # \$ (persist) stays a literal dollar; do not expand again.
      if [ "${_rivetos_env_quote:-none}" = "none" ]; then
        case "$val" in
          "~" | "~/"*) val="${HOME-}${val:1}" ;;
          "~"*)
            case "$val" in
              *'$'* | *'`'*) ;;
              *) construct="${construct:-unquoted ~user tilde expansion}" ;;
            esac
            ;;
        esac
        rivetos_expand_params "$val"
        val="$_rivetos_expand_out"
      fi
      if [ -z "$construct" ] && [ -n "${_rivetos_expand_unsupported:-}" ]; then
        construct="$_rivetos_expand_unsupported"
      fi
      if [ -n "$construct" ]; then
        echo "rivet-paths: ${_rivetos_env_key} uses unsupported ${construct} (kept literal)" >&2
      fi
      export "${_rivetos_env_key}=${val}"
    fi
  done <"$file"
}

# Encode so bash source, this parser, and packages/cli parseEnvLine
# recover the same bytes. Unquoted allowlist, else single quotes, else
# double quotes with \ " $ ` escaped (when the value contains ').
# Returns 1 for newline or unsubstituted ${IDENT}.
rivetos_encode_env_value() {
  local val="$1" nl=$'\n' i=0 c out
  case "$val" in
    *"$nl"*) return 1 ;;
  esac
  if rivetos_is_effective_unset "$val" && [ -n "$val" ]; then
    return 1
  fi
  if [ -n "$val" ] && [ "${val#\~}" != "$val" ]; then
    :
  elif [[ "$val" =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]]; then
    printf '%s' "$val"
    return 0
  fi
  case "$val" in
    *"'"*)
      out='"'
      while [ "$i" -lt "${#val}" ]; do
        c="${val:i:1}"
        case "$c" in
          \\) out+='\\' ;;
          \") out+='\"' ;;
          \$) out+='\$' ;;
          \`) out+='\`' ;;
          *) out+="$c" ;;
        esac
        i=$((i + 1))
      done
      printf '%s' "$out\""
      ;;
    *)
      printf "'%s'" "$val"
      ;;
  esac
}

# URL on stdin. Prints "scheme host port" or "unparseable". Never echoes
# userinfo or the raw value. $1 is the default port for a bare host[:port]
# (no ://). Bare values drop userinfo at the last @, then /path ?query
# #fragment, then parse host[:port] / [v6]:port.
rivetos_redact_endpoint() {
  local default_port="${1:-5432}"
  python3 -c '
import sys
from urllib.parse import urlparse

raw = sys.stdin.read().strip()
default_port = int(sys.argv[1]) if len(sys.argv) > 1 else 5432
if not raw:
    raise SystemExit(0)

def unparseable():
    print("unparseable")
    raise SystemExit(0)

def emit(scheme, host, port):
    if not host:
        unparseable()
    print(f"{scheme} {host} {port}")

def authority_only(s):
    if "@" in s:
        s = s.rsplit("@", 1)[-1]
    out = []
    in_br = False
    for ch in s:
        if ch == "[":
            in_br = True
            out.append(ch)
        elif ch == "]":
            in_br = False
            out.append(ch)
        elif (not in_br) and ch in "/?#":
            break
        else:
            out.append(ch)
    return "".join(out)

try:
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

    raw = authority_only(raw)
    if not raw:
        unparseable()

    scheme = "tcp"
    host = ""
    port = default_port
    if raw.startswith("["):
        end = raw.find("]")
        if end == -1:
            unparseable()
        host = raw[1:end]
        rest = raw[end + 1 :]
        if rest.startswith(":") and rest[1:].isdigit():
            port = int(rest[1:])
        elif rest:
            unparseable()
    elif raw.count(":") == 1:
        left, right = raw.rsplit(":", 1)
        if left and right.isdigit():
            host = left
            port = int(right)
        else:
            unparseable()
    else:
        host = raw
    emit(scheme, host, port)
except SystemExit:
    raise
except Exception:
    unparseable()
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
# Default: env file wins (same as main / historical harness launchers).
# RIVETOS_PLUGIN_ENV=1: process / plugin values win after stripping
# placeholders, and a plugin postgres DataHub overwrites a file-only PG URL.
rivetos_load_env() {
  local env_file="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
  local restore="" n plugin_datahub plugin_pg plugin_mode=0

  if [ "${RIVETOS_PLUGIN_ENV:-}" = "1" ]; then
    plugin_mode=1
    rivetos_unset_empty_rivetos_vars
    plugin_datahub="${RIVETOS_DATAHUB_URL:-}"
    plugin_pg="${RIVETOS_PG_URL:-}"
    for n in $(rivetos_exported_rivetos_names); do
      restore="${restore}$(printf 'export %s=%q\n' "$n" "${!n}")"$'\n'
    done
  fi

  if [ -f "$env_file" ]; then
    rivetos_apply_env_file "$env_file"
  fi

  if [ "$plugin_mode" -eq 1 ] && [ -n "$restore" ]; then
    eval "$restore"
  fi

  if [ "$plugin_mode" -eq 1 ] && rivetos_is_postgres_url "$plugin_datahub" && rivetos_is_effective_unset "$plugin_pg"; then
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
