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
  unset RIVETOS_MODE RIVETOS_PG_URL RIVETOS_DATAHUB_URL RIVETOS_CLOUD_TOKEN RIVETOS_CLOUD_URL RIVETOS_ENV_FILE RIVETOS_PLUGIN_ENV RIVETOS_ROOT
  if [ -n "${ENV_DIR:-}" ]; then
    rm -rf "$ENV_DIR"
    unset ENV_DIR
  fi
}

# 1. Plugin / process var wins over .env only when flagged
cleanup_env
with_envfile 'RIVETOS_PG_URL=postgres://env-file.example/db
RIVETOS_MODE=local'
export RIVETOS_PLUGIN_ENV=1
export RIVETOS_PG_URL='postgres://plugin.example/db'
rivetos_load_env
if [ "$RIVETOS_PG_URL" = 'postgres://plugin.example/db' ]; then
  pass "plugin PG URL wins over .env when RIVETOS_PLUGIN_ENV=1"
else
  fail "plugin PG URL should win over .env when RIVETOS_PLUGIN_ENV=1"
fi
cleanup_env

# 1b. Flag unset → env file wins (identical to main)
with_envfile 'RIVETOS_PG_URL=postgres://env-file.example/db'
export RIVETOS_PG_URL='postgres://process.example/db'
rivetos_load_env
if [ "$RIVETOS_PG_URL" = 'postgres://env-file.example/db' ]; then
  pass "env file wins when RIVETOS_PLUGIN_ENV is unset"
else
  fail "env file should win when RIVETOS_PLUGIN_ENV is unset"
fi
cleanup_env

# 2. Empty plugin placeholder falls back to .env
with_envfile 'RIVETOS_PG_URL=postgres://from-env.example/db'
export RIVETOS_PLUGIN_ENV=1
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
export RIVETOS_PLUGIN_ENV=1
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
export RIVETOS_PLUGIN_ENV=1
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

# 16b. double-quoted \$ is a literal $ (persist form; do not expand)
with_envfile "RIVETOS_PG_URL=\"a'b\\\$c\""
export HOME=/tmp/rivetos-home-probe
rivetos_load_env
if [ "${RIVETOS_PG_URL:-}" = "a'b\$c" ]; then
  pass "double-quoted \\\$ is literal dollar"
else
  fail "loader must not expand \\\$ inside double quotes"
fi
cleanup_env

# 16. unquoted $HOME expands (house files, same as source on main)
_saved_home="$HOME"
with_envfile 'RIVETOS_ROOT=$HOME/rivetos'
export HOME=/tmp/rivetos-home-probe
rivetos_load_env
if [ "${RIVETOS_ROOT:-}" = '/tmp/rivetos-home-probe/rivetos' ]; then
  pass "unquoted \$HOME expands"
else
  fail "RIVETOS_ROOT=\$HOME/rivetos should expand"
fi
HOME="$_saved_home"
unset _saved_home
cleanup_env

# 17. scheme-less credentialed endpoints: last @, drop path, never leak
assert_redact() {
  local raw="$1"
  local expect="$2"
  local secret="$3"
  local label="$4"
  local port="${5:-5432}"
  local got xout
  got="$(printf '%s' "$raw" | rivetos_redact_endpoint "$port" 2>&1)"
  if [ "$got" = "$expect" ]; then
    pass "$label"
  else
    fail "$label (redacted form did not match)"
  fi
  if printf '%s' "$got" | grep -qF "$secret"; then
    fail "$label leaked secret on stdout/stderr"
  else
    pass "$label no leak on stdout/stderr"
  fi
  xout="$(printf '%s' "$raw" | { set -x; rivetos_redact_endpoint "$port"; } 2>&1)"
  if printf '%s' "$xout" | grep -qF "$secret"; then
    fail "$label leaked secret under bash -x"
  else
    pass "$label no leak under bash -x"
  fi
}

assert_redact 'user:pass@host.example:5432/db' 'tcp host.example 5432' 'user:pass' 'bare user:pass@host:port/path'
assert_redact 'user:pass@host.example' 'tcp host.example 5432' 'user:pass' 'bare user:pass@host'
assert_redact 'user:pass@cloud.example' 'tcp cloud.example 443' 'user:pass' 'bare cloud_url userinfo' 443
assert_redact 'user:p@ss:w0rd@host.example:5432/db' 'tcp host.example 5432' 'p@ss:w0rd' 'password with @ and :'
assert_redact 'u:p@[::1]:5432' 'tcp ::1 5432' 'u:p@' 'IPv6 literal with userinfo'
assert_redact 'user:pass@' 'unparseable' 'user:pass' 'empty host after @ is unparseable'
assert_redact 'datahub.example/db?password=p@sswor' 'tcp datahub.example 5432' 'sswor' 'bare @ in query'
assert_redact 'datahub.example/db@user:pass' 'tcp datahub.example 5432' 'user:pass' 'bare @ in path'
assert_redact 'postgres://datahub.example/db?password=p@sswor' 'postgres datahub.example 5432' 'sswor' 'scheme @ in query'
assert_redact 'postgres://datahub.example/db@user:pass' 'postgres datahub.example 5432' 'user:pass' 'scheme @ in path'

# 18. supported shapes match bash source
assert_matches_source() {
  local body="$1"
  local key="$2"
  local label="$3"
  local parser_val source_val err
  _saved_home="$HOME"
  export HOME=/tmp/rivetos-home-probe
  with_envfile "$body"
  unset EMPTY MISSING FOO "$key" 2>/dev/null || true
  rivetos_load_env 2>"$ENV_DIR/load.err"
  err="$(cat "$ENV_DIR/load.err")"
  parser_val="${!key-}"
  if printf '%s' "$err" | grep -q unsupported; then
    fail "$label should not warn"
  fi
  unset "$key" || true
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV_FILE"
  set +a
  source_val="${!key-}"
  if [ "$parser_val" = "$source_val" ]; then
    pass "$label matches source"
  else
    fail "$label parser/source mismatch"
  fi
  HOME="$_saved_home"
  unset _saved_home
  cleanup_env
}

assert_matches_source 'RIVETOS_ROOT=~' RIVETOS_ROOT 'unquoted ~'
assert_matches_source 'RIVETOS_ROOT=~/rivetos' RIVETOS_ROOT 'unquoted ~/'
assert_matches_source 'RIVETOS_ROOT=~/skills' RIVETOS_ROOT 'unquoted ~/skills'
assert_matches_source 'RIVETOS_ROOT=a~b' RIVETOS_ROOT 'unquoted a~b stays literal'
assert_matches_source 'RIVETOS_ROOT="~/rivetos"' RIVETOS_ROOT 'double-quoted ~/ stays literal'
assert_matches_source 'RIVETOS_ROOT=${MISSING:-fallback}' RIVETOS_ROOT '${NAME:-default} unset'
assert_matches_source $'EMPTY=\nRIVETOS_ROOT=${EMPTY:-fallback}' RIVETOS_ROOT '${NAME:-default} empty'
assert_matches_source $'EMPTY=\nRIVETOS_ROOT=${EMPTY-fallback}' RIVETOS_ROOT '${NAME-default} empty stays empty'
assert_matches_source 'RIVETOS_ROOT=${MISSING-fallback}' RIVETOS_ROOT '${NAME-default} unset'
assert_matches_source 'RIVETOS_ROOT="a\nb"' RIVETOS_ROOT 'double-quoted \\n stays two chars'
assert_matches_source 'RIVETOS_ROOT="a\tb"' RIVETOS_ROOT 'double-quoted \\t stays two chars'
assert_matches_source 'RIVETOS_ROOT="a\pb"' RIVETOS_ROOT 'double-quoted \\p stays two chars'
assert_matches_source 'RIVETOS_ROOT="$HOME/rivetos"' RIVETOS_ROOT 'double-quoted $HOME expands'
assert_matches_source $'FOO=bar\nRIVETOS_ROOT="${FOO}/x"' RIVETOS_ROOT 'double-quoted ${NAME}'
assert_matches_source 'RIVETOS_ROOT="${MISSING:-fallback}"' RIVETOS_ROOT 'double-quoted ${NAME:-default}'
assert_matches_source 'RIVETOS_ROOT=#c0ffee' RIVETOS_ROOT 'unquoted #value is not a comment'
assert_matches_source 'RIVETOS_ROOT=a#b' RIVETOS_ROOT 'unquoted mid-word hash'
assert_matches_source 'RIVETOS_ROOT=a #b' RIVETOS_ROOT 'unquoted whitespace-hash is a comment'
assert_matches_source 'RIVETOS_ROOT= #c' RIVETOS_ROOT 'unquoted space-hash is a comment'
assert_matches_source $'RIVETOS_ROOT=\t#c' RIVETOS_ROOT 'unquoted tab-hash is a comment'
assert_matches_source 'RIVETOS_ROOT=' RIVETOS_ROOT 'empty value'
assert_matches_source 'RIVETOS_ROOT= ' RIVETOS_ROOT 'whitespace-only value'

# 19. full-line # … is a comment (not an assignment)
_saved_home="$HOME"
with_envfile '# RIVETOS_ROOT=/commented-out
RIVETOS_MODE=local'
export HOME=/tmp/rivetos-home-probe
rivetos_load_env 2>"$ENV_DIR/load.err"
err="$(cat "$ENV_DIR/load.err")"
if [ -z "${RIVETOS_ROOT:-}" ] && [ "${RIVETOS_MODE:-}" = local ]; then
  pass 'full-line # comment is not an assignment'
else
  fail 'full-line # comment must not assign RIVETOS_ROOT'
fi
if printf '%s' "$err" | grep -q unsupported; then
  fail 'full-line # comment should not warn'
else
  pass 'full-line # comment does not warn'
fi
HOME="$_saved_home"
unset _saved_home
cleanup_env

# 19b. KEY= #comment is empty (effective unset), matching bash source
with_envfile 'RIVETOS_PG_URL= # disabled'
rivetos_load_env 2>"$ENV_DIR/load.err"
if rivetos_is_effective_unset "${RIVETOS_PG_URL:-}"; then
  pass 'KEY= #comment is effective unset'
else
  fail 'KEY= #comment should be empty'
fi
cleanup_env

# 19c. launcher-style load under bash -x must not trace env-file secrets
with_envfile 'RIVETOS_PG_URL=s3cret-xtrace-load'
xout="$( { set -x; rivetos_load_env; } 2>&1 )"
if printf '%s' "$xout" | grep -qF 's3cret-xtrace-load'; then
  fail 'load_env leaked secret under bash -x'
else
  pass 'load_env does not leak under bash -x'
fi
cleanup_env

# 20. unsupported shapes warn with the key, never the value
assert_warns() {
  local body="$1"
  local key="$2"
  local secret="$3"
  local label="$4"
  local err
  with_envfile "$body"
  rivetos_load_env 2>"$ENV_DIR/load.err"
  err="$(cat "$ENV_DIR/load.err")"
  if printf '%s' "$err" | grep -q "$key" && printf '%s' "$err" | grep -q unsupported; then
    pass "$label warns with key"
  else
    fail "$label should warn naming $key"
  fi
  if [ -n "$secret" ] && printf '%s' "$err" | grep -qF "$secret"; then
    fail "$label warning leaked value"
  else
    pass "$label warning does not print value"
  fi
  cleanup_env
}

assert_warns 'RIVETOS_PG_URL=${FOO:+s3cret-warn-value}' RIVETOS_PG_URL 's3cret-warn-value' '${+} operator'
assert_warns 'RIVETOS_ROOT=${FOO#pat}' RIVETOS_ROOT '${FOO#pat}' '${#} operator'
assert_warns "RIVETOS_ROOT='a'\\''b'" RIVETOS_ROOT "a'b" "concatenated quotes"
assert_warns 'RIVETOS_ROOT=foo\' RIVETOS_ROOT 'foo\' 'trailing-backslash continuation'
assert_warns 'RIVETOS_ROOT=$(echo s3cret-cmd)' RIVETOS_ROOT 's3cret-cmd' 'command substitution'
assert_warns 'RIVETOS_ROOT="$(echo s3cret-dq)"' RIVETOS_ROOT 's3cret-dq' 'double-quoted command substitution'
assert_warns 'RIVETOS_ROOT=`echo s3cret-tick`' RIVETOS_ROOT 's3cret-tick' 'backticks'

if [ "$failed" -ne 0 ]; then
  echo "$failed rivet-paths test(s) failed" >&2
  exit 1
fi
echo "rivet-paths.test.sh: all ok"
