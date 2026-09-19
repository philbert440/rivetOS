#!/usr/bin/env bash
# rivetos-status — mode, Tailscale, endpoint reachability. No secret dumps.
#
# Prints a short report to stdout. Never prints PG URLs, tokens, passwords,
# or full connection strings.
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
  echo "rivetos-status: rivet-paths.sh not found" >&2
  exit 1
fi
# shellcheck source=../../../shared/rivet-paths.sh
. "$_rivet_paths"
unset _rivet_paths _rivet_candidate

rivetos_load_env

mode="${RIVETOS_MODE:-}"
if [ -z "$mode" ]; then
  if [ -n "${RIVETOS_PG_URL:-}" ] || [ -n "${RIVETOS_DATAHUB_URL:-}" ]; then
    mode="unset (house .env fallback)"
  else
    mode="unset — run rivetos-onboard"
  fi
fi

echo "rivetos-status"
echo "mode: $mode"
echo "cloud_url: ${RIVETOS_CLOUD_URL:-}"
echo "cloud_token: $([ -n "${RIVETOS_CLOUD_TOKEN:-}" ] && echo set || echo unset)"
echo "datahub: $([ -n "${RIVETOS_DATAHUB_URL:-}" ] && echo set || echo unset)"
echo "pg_url: $([ -n "${RIVETOS_PG_URL:-}" ] && echo set || echo unset)"

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
if [ -z "$endpoint" ]; then
  echo "endpoint: not configured"
  exit 0
fi

probe="$(ENDPOINT="$endpoint" python3 - <<'PY' 2>/dev/null || true
import os
from urllib.parse import urlparse
raw = os.environ.get("ENDPOINT", "")
u = urlparse(raw)
host = u.hostname or ""
if not host:
    print("")
    raise SystemExit(0)
scheme = (u.scheme or "").lower()
if u.port:
    port = u.port
elif scheme.startswith("postgres"):
    port = 5432
elif scheme == "https":
    port = 443
elif scheme == "http":
    port = 80
else:
    port = 443
print(f"{scheme or 'tcp'} {host} {port}")
PY
)"

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
