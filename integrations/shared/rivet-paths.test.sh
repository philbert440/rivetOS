#!/usr/bin/env bash
# Unit tests for rivetos_load_env read order (plugin vars → .env fallback).
# Never prints secret values; failures mention key names only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=./rivet-paths.sh
. "$ROOT/rivet-paths.sh"

failed=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; failed=$((failed + 1)); }

with_envfile() {
  local body="$1"
  ENV_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rivetos-paths.XXXXXX")"
  export RIVETOS_ENV_FILE="$ENV_DIR/.env"
  printf '%s\n' "$body" >"$RIVETOS_ENV_FILE"
  chmod 600 "$RIVETOS_ENV_FILE"
}

cleanup_env() {
  unset RIVETOS_MODE RIVETOS_PG_URL RIVETOS_DATAHUB_URL RIVETOS_CLOUD_TOKEN RIVETOS_CLOUD_URL RIVETOS_ENV_FILE
  if [ -n "${ENV_DIR:-}" ]; then
    rm -rf "$ENV_DIR"
    unset ENV_DIR
  fi
}

# 1. Plugin / process var wins over .env
cleanup_env
with_envfile 'RIVETOS_PG_URL=postgres://env-file.example/db
RIVETOS_MODE=local'
export RIVETOS_PG_URL='postgres://plugin.example/db'
rivetos_load_env
if [ "$RIVETOS_PG_URL" = 'postgres://plugin.example/db' ]; then
  pass "plugin PG URL wins over .env"
else
  fail "plugin PG URL should win over .env"
fi
cleanup_env

# 2. Empty plugin placeholder falls back to .env
with_envfile 'RIVETOS_PG_URL=postgres://from-env.example/db'
export RIVETOS_PG_URL=''
rivetos_load_env
if [ "$RIVETOS_PG_URL" = 'postgres://from-env.example/db' ]; then
  pass "empty plugin placeholder falls back to .env"
else
  fail "empty plugin placeholder should fall back to .env"
fi
cleanup_env

# 3. House .env only (no plugin vars)
with_envfile 'RIVETOS_PG_URL=postgres://house.example/db'
rivetos_load_env
if [ "$RIVETOS_PG_URL" = 'postgres://house.example/db' ]; then
  pass "house .env fallback still works"
else
  fail "house .env fallback broken"
fi
cleanup_env

# 4. DATAHUB postgres maps to PG_URL when PG unset
with_envfile ''
export RIVETOS_DATAHUB_URL='postgres://datahub.example:5432/mem'
rivetos_load_env
if [ "${RIVETOS_PG_URL:-}" = 'postgres://datahub.example:5432/mem' ]; then
  pass "DATAHUB postgres URL maps to PG_URL"
else
  fail "DATAHUB postgres URL should map to PG_URL"
fi
cleanup_env

# 5. Existing PG_URL not overwritten by DATAHUB
with_envfile ''
export RIVETOS_PG_URL='postgres://keep.example/db'
export RIVETOS_DATAHUB_URL='postgres://other.example/db'
rivetos_load_env
if [ "$RIVETOS_PG_URL" = 'postgres://keep.example/db' ]; then
  pass "existing PG_URL not overwritten by DATAHUB"
else
  fail "DATAHUB must not overwrite existing PG_URL"
fi
cleanup_env

# 6. HTTPS DATAHUB does not become PG_URL
with_envfile ''
export RIVETOS_DATAHUB_URL='https://den.example.ts.net'
rivetos_load_env
if [ -z "${RIVETOS_PG_URL:-}" ] && [ "$RIVETOS_DATAHUB_URL" = 'https://den.example.ts.net' ]; then
  pass "HTTPS DATAHUB is not converted to PG_URL"
else
  fail "HTTPS DATAHUB must not become PG_URL"
fi
cleanup_env

# 7. cloud mode default URL
with_envfile ''
export RIVETOS_MODE=cloud
rivetos_load_env
if [ "${RIVETOS_CLOUD_URL:-}" = 'https://rivetos.cloud' ]; then
  pass "cloud mode default CLOUD_URL"
else
  fail "cloud mode should default CLOUD_URL"
fi
cleanup_env

# 8. plugin cloud URL wins over default
with_envfile ''
export RIVETOS_MODE=cloud
export RIVETOS_CLOUD_URL='https://cloud.example'
rivetos_load_env
if [ "$RIVETOS_CLOUD_URL" = 'https://cloud.example' ]; then
  pass "explicit CLOUD_URL preserved"
else
  fail "explicit CLOUD_URL should be preserved"
fi
cleanup_env

# 9. literal unsubstituted ${VAR} counts as unset
with_envfile 'RIVETOS_PG_URL=postgres://from-env.example/db'
export RIVETOS_PG_URL='${RIVETOS_PG_URL}'
rivetos_load_env
if [ "$RIVETOS_PG_URL" = 'postgres://from-env.example/db' ]; then
  pass "literal \${RIVETOS_PG_URL} placeholder falls back to .env"
else
  fail "literal \${RIVETOS_PG_URL} should count as unset"
fi
cleanup_env

# 10. quoted special chars parse without sourcing
with_envfile "RIVETOS_PG_URL='postgres://u:p@ss word#hash\$tick@h/db'"
rivetos_load_env
if [ "${RIVETOS_PG_URL:-}" = 'postgres://u:p@ss word#hash$tick@h/db' ]; then
  pass "quoted special chars round-trip via parse"
else
  fail "quoted special chars should parse without source"
fi
cleanup_env

# 11. export prefix + last-wins
with_envfile 'export RIVETOS_MODE=local
RIVETOS_MODE="cloud"'
rivetos_load_env
if [ "${RIVETOS_MODE:-}" = 'cloud' ]; then
  pass "export prefix + last-wins"
else
  fail "last RIVETOS_MODE assignment should win"
fi
cleanup_env

# 12. plugin DATAHUB postgres wins over legacy file PG_URL
with_envfile 'RIVETOS_PG_URL=postgres://old.example/db'
export RIVETOS_DATAHUB_URL='postgres://new.example/db'
rivetos_load_env
if [ "${RIVETOS_PG_URL:-}" = 'postgres://new.example/db' ]; then
  pass "plugin DATAHUB overwrites file PG_URL"
else
  fail "plugin DATAHUB should overwrite legacy file PG_URL"
fi
cleanup_env

# 13. parse helpers: export / quotes / CRLF
line=$'export RIVETOS_MODE="production"\r'
if rivetos_parse_env_line "$line" && [ "$_rivetos_env_key" = RIVETOS_MODE ] && [ "$_rivetos_env_val" = production ]; then
  pass "parse export + quotes + CRLF"
else
  fail "parse should handle export, quotes, CRLF"
fi

# 14. redact via stdin, never userinfo
redacted="$(printf '%s' 'https://alice:s3cret-cloud@cloud.example:8443/v1' | rivetos_redact_endpoint 443)"
if [ "$redacted" = 'https cloud.example 8443' ]; then
  pass "redact drops userinfo"
else
  fail "redact should print scheme host port without userinfo"
fi
if printf '%s' "$redacted" | grep -q s3cret; then
  fail "redact leaked userinfo"
fi

# 15. bare host and IPv6
bare="$(printf '%s' 'datahub.example' | rivetos_redact_endpoint 5432)"
if [ "$bare" = 'tcp datahub.example 5432' ]; then
  pass "bare host parses"
else
  fail "bare host should be host + default port"
fi
bare_port="$(printf '%s' 'datahub.example:6543' | rivetos_redact_endpoint 5432)"
if [ "$bare_port" = 'tcp datahub.example 6543' ]; then
  pass "bare host:port parses"
else
  fail "bare host:port should keep the port"
fi
v6="$(printf '%s' '[::1]:5432' | rivetos_redact_endpoint 5432)"
if [ "$v6" = 'tcp ::1 5432' ]; then
  pass "IPv6 literal parses"
else
  fail "bracketed IPv6 should parse"
fi
cleanup_env

if [ "$failed" -ne 0 ]; then
  echo "$failed rivet-paths test(s) failed" >&2
  exit 1
fi
echo "rivet-paths.test.sh: all ok"
