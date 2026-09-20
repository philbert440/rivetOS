#!/usr/bin/env bash
# rivetos-status — mode, Tailscale, endpoint reachability. No secret dumps.
#
# Prints a short report to stdout. Never prints PG URLs, tokens, passwords,
# or full connection strings.
set -euo pipefail

# Disable xtrace on purpose: status must never leak secrets in a
# `bash -x` trace (placement matches rivetos-onboard-persist.sh).
case "$-" in
  *x*) set +x ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
_rivet_paths=""
for _rivet_candidate in \
  "$SCRIPT_DIR/rivet-paths.sh" \
  "${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/rivet-paths.sh"; do
  if [ -f "$_rivet_candidate" ]; then
    _rivet_paths="$_rivet_candidate"
    break
  fi
done
if [ -z "$_rivet_paths" ]; then
  echo "rivetos-status: rivet-paths.sh not found" >&2
  exit 1
fi
# shellcheck source=./rivet-paths.sh
. "$_rivet_paths"
unset _rivet_paths _rivet_candidate

export RIVETOS_PLUGIN_ENV=1
if [ "${_rivetos_status_plugin_options:-0}" = 1 ]; then
  rivetos_collect_plugin_options
fi
rivetos_load_env

_rivetos_status_flag() {
  if rivetos_is_effective_unset "${1-}"; then
    echo unset
  else
    echo set
  fi
}

# Redact to "scheme host:port", or "set" / "unset". URL arrives on stdin.
_rivetos_status_redact() {
  local raw="${1-}"
  local default_port="${2:-5432}"
  local probe
  if rivetos_is_effective_unset "$raw"; then
    echo unset
    return 0
  fi
  probe="$(printf '%s' "$raw" | rivetos_redact_endpoint "$default_port" 2>/dev/null || true)"
  if [ "$probe" = unparseable ]; then
    echo unparseable
    return 0
  fi
  if [ -z "$probe" ]; then
    echo set
    return 0
  fi
  printf '%s %s:%s\n' "$(printf '%s' "$probe" | awk '{print $1}')" "$(printf '%s' "$probe" | awk '{print $2}')" "$(printf '%s' "$probe" | awk '{print $3}')"
}

mode="${RIVETOS_MODE:-}"
if rivetos_is_effective_unset "$mode"; then
  if ! rivetos_is_effective_unset "${RIVETOS_PG_URL:-}" || ! rivetos_is_effective_unset "${RIVETOS_DATAHUB_URL:-}"; then
    mode="unset (house .env fallback)"
  else
    mode="unset — run rivetos-onboard"
  fi
fi

echo "rivetos-status"
echo "mode: $mode"
echo "cloud_url: $(_rivetos_status_redact "${RIVETOS_CLOUD_URL:-}" 443)"
echo "cloud_token: $(_rivetos_status_flag "${RIVETOS_CLOUD_TOKEN:-}")"
echo "datahub: $(_rivetos_status_flag "${RIVETOS_DATAHUB_URL:-}")"
echo "pg_url: $(_rivetos_status_flag "${RIVETOS_PG_URL:-}")"
echo "embed_url: $(_rivetos_status_flag "${RIVETOS_EMBED_URL:-}")"
echo "embed_model: $(_rivetos_status_flag "${RIVETOS_EMBED_MODEL:-}")"
echo "memory_write: $(_rivetos_status_flag "${RIVETOS_MCP_ENABLE_MEMORY_WRITE:-}")"

# Configuration problems are informational; preserve the reachability exit contract.
if rivetos_embed_model_missing; then
  echo "problem: RIVETOS_EMBED_MODEL is required when RIVETOS_EMBED_URL and Postgres memory are enabled"
fi

if command -v tailscale >/dev/null 2>&1; then
  ts_json="$(tailscale status --json 2>/dev/null || true)"
  if [ -n "$ts_json" ] && command -v jq >/dev/null 2>&1; then
    ts_state="$(printf '%s' "$ts_json" | jq -r '.BackendState // "unknown"' 2>/dev/null || echo unknown)"
    ts_online="$(printf '%s' "$ts_json" | jq -r '.Self.Online // false' 2>/dev/null || echo false)"
    echo "tailscale: $ts_state online=$ts_online"
  else
    if tailscale status >/dev/null 2>&1; then
      echo "tailscale: up"
    else
      echo "tailscale: installed (status failed)"
    fi
  fi
else
  if [ "${RIVETOS_MODE:-}" = "cloud" ]; then
    echo "tailscale: n/a (cloud mode)"
  else
    echo "tailscale: not installed"
  fi
fi

# Reachability: host:port only. Never echo the URL (may contain userinfo).
endpoint="${RIVETOS_DATAHUB_URL:-${RIVETOS_PG_URL:-${RIVETOS_CLOUD_URL:-}}}"
if rivetos_is_effective_unset "$endpoint"; then
  echo "endpoint: not configured"
  exit 0
fi

default_port=5432
case "$endpoint" in
  https://*) default_port=443 ;;
  http://*) default_port=80 ;;
esac

probe="$(printf '%s' "$endpoint" | rivetos_redact_endpoint "$default_port" 2>/dev/null || true)"

if [ "$probe" = unparseable ]; then
  echo "endpoint: unparseable"
  exit 0
fi
if [ -z "$probe" ]; then
  echo "endpoint: set (could not parse host — not probed)"
  exit 0
fi

scheme="$(printf '%s' "$probe" | awk '{print $1}')"
host="$(printf '%s' "$probe" | awk '{print $2}')"
port="$(printf '%s' "$probe" | awk '{print $3}')"

reachable=0
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "import socket,sys; s=socket.create_connection((sys.argv[1], int(sys.argv[2])), 3); s.close()" "$host" "$port" 2>/dev/null; then
    reachable=1
  fi
fi

if [ "$reachable" -eq 1 ]; then
  echo "endpoint: reachable ($scheme $host:$port)"
else
  echo "endpoint: unreachable ($scheme $host:$port)"
fi
