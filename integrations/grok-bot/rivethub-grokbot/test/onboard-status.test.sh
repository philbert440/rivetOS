#!/usr/bin/env bash
# Persist + status helpers: house fallback, no secret dumps.
set -euo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd -P)"
STATUS="$KIT/bin/rivetos-status.sh"
PERSIST="$KIT/bin/rivetos-onboard-persist.sh"
WRAPPER="$KIT/bin/rivetos-memory-mcp.sh"

failed=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; failed=$((failed + 1)); }

bash -n "$STATUS" && pass "status bash -n" || fail "status bash -n"
bash -n "$PERSIST" && pass "persist bash -n" || fail "persist bash -n"
bash -n "$WRAPPER" && pass "wrapper bash -n" || fail "wrapper bash -n"
bash -n "$KIT/../rivet-memory/bin/rivet-memory-mcp.sh" && pass "sibling launcher bash -n" || fail "sibling launcher bash -n"

HOME_TMP="$(mktemp -d "${TMPDIR:-/tmp}/rivetos-onboard.XXXXXX")"
export HOME="$HOME_TMP"
export RIVETOS_ENV_FILE="$HOME_TMP/.rivetos/.env"
mkdir -p "$HOME_TMP/.rivetos"

SECRET='postgres://tenant:s3cret-do-not-print@datahub.example:5432/mem?sslmode=require'
TOKEN='tok_live_do_not_print'

# Persist local mode
export RIVETOS_MODE=local
export RIVETOS_DATAHUB_URL="$SECRET"
out="$("$PERSIST")"
if [[ "$out" == *"mode=local"* ]]; then
  pass "persist reports mode"
else
  fail "persist should report mode"
fi
if [[ "$out" == *s3cret* ]] || [[ "$out" == *"$SECRET"* ]]; then
  fail "persist leaked DataHub/PG secret"
else
  pass "persist does not print DataHub URL"
fi

# Status must not dump the URL or password
status_out="$("$STATUS")"
if [[ "$status_out" == *"mode: local"* ]]; then
  pass "status shows local mode"
else
  fail "status should show local mode"
fi
if [[ "$status_out" == *"datahub: set"* ]] && [[ "$status_out" == *"pg_url: set"* ]]; then
  pass "status shows datahub/pg set"
else
  fail "status should show datahub/pg as set (mapped)"
fi
if [[ "$status_out" == *s3cret* ]] || [[ "$status_out" == *tok_live* ]] || [[ "$status_out" == *tenant:* ]]; then
  fail "status leaked a secret"
else
  pass "status does not dump secrets"
fi
if [[ "$status_out" == *"datahub.example:5432"* ]]; then
  pass "status probes host:port without userinfo"
else
  # unreachable is fine; host:port should still appear
  if [[ "$status_out" == *"datahub.example"* ]]; then
    pass "status names host without userinfo"
  else
    fail "status should mention endpoint host"
  fi
fi

# House .env fallback: clear process plugin vars, status still sees file
unset RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_PG_URL RIVETOS_CLOUD_TOKEN RIVETOS_CLOUD_URL
status_house="$("$STATUS")"
if [[ "$status_house" == *"house .env fallback"* ]] || [[ "$status_house" == *"mode: local"* ]]; then
  pass "status sees house .env after unsetting process vars"
else
  fail "status should still see persisted .env"
fi
if [[ "$status_house" == *s3cret* ]]; then
  fail "house-fallback status leaked secret"
else
  pass "house-fallback status does not dump secrets"
fi

# Quoted persist: spaces, hash, dollar survive the next load
unset RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_PG_URL RIVETOS_CLOUD_URL RIVETOS_CLOUD_TOKEN
SPECIAL='postgres://u:p@ss word#hash$tick@datahub.example/db'
export RIVETOS_MODE=local
export RIVETOS_DATAHUB_URL="$SPECIAL"
: >"$RIVETOS_ENV_FILE"
"$PERSIST" >/dev/null
if grep -q "RIVETOS_DATAHUB_URL=" "$RIVETOS_ENV_FILE"; then
  pass "persist writes DATAHUB assignment"
else
  fail "persist should write DATAHUB"
fi
unset RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_PG_URL
# shellcheck source=../../../shared/rivet-paths.sh
. "$KIT/../../shared/rivet-paths.sh"
rivetos_load_env
if [ "${RIVETOS_DATAHUB_URL:-}" = "$SPECIAL" ]; then
  pass "quoted persist round-trips through load_env"
else
  fail "load_env should recover quoted special chars"
fi

assert_mode_kept() {
  local label="$1"
  local body="$2"
  local expect="$3"
  printf '%s\n' "$body" >"$RIVETOS_ENV_FILE"
  chmod 600 "$RIVETOS_ENV_FILE"
  export RIVETOS_MODE=local
  export RIVETOS_DATAHUB_URL='postgres://new.example/db'
  "$PERSIST" >/dev/null
  got="$(rivetos_env_file_value "$RIVETOS_ENV_FILE" RIVETOS_MODE)"
  if [ "$got" = "$expect" ]; then
    pass "persist does not clobber $label"
  else
    fail "persist clobbered $label (got ${got:-empty})"
  fi
}

assert_mode_kept "bare workspace" "RIVETOS_MODE=workspace" workspace
assert_mode_kept "export production" "export RIVETOS_MODE=production" production
assert_mode_kept "quoted workspace" 'RIVETOS_MODE="workspace"' workspace
assert_mode_kept "CRLF production" $'RIVETOS_MODE=production\r' production
assert_mode_kept "last-wins workspace" $'RIVETOS_MODE=local\nRIVETOS_MODE=workspace' workspace

# Persist without required local endpoint fails
unset RIVETOS_DATAHUB_URL RIVETOS_PG_URL
export RIVETOS_MODE=local
if "$PERSIST" >/dev/null 2>&1; then
  fail "local persist should require an endpoint"
else
  pass "local persist requires DataHub or PG URL"
fi

# Unsubstituted placeholder is refused (file untouched)
: >"$RIVETOS_ENV_FILE"
export RIVETOS_MODE=cloud
export RIVETOS_CLOUD_URL='${RIVETOS_CLOUD_URL}'
set +e
ph_out="$("$PERSIST" 2>&1)"
ph_rc=$?
set -e
if [ "$ph_rc" -ne 0 ] && [[ "$ph_out" == *"looks like an unsubstituted Cursor placeholder"* ]]; then
  pass "persist refuses unsubstituted placeholders"
else
  fail "persist should refuse unsubstituted placeholders"
fi
if [ ! -s "$RIVETOS_ENV_FILE" ]; then
  pass "placeholder refuse writes nothing"
else
  fail "placeholder refuse mutated the env file"
fi
unset RIVETOS_CLOUD_URL

# Cloud persist without token is allowed (token may stay in plugin form only)
export RIVETOS_MODE=cloud
unset RIVETOS_CLOUD_TOKEN
if "$PERSIST" >/dev/null; then
  pass "cloud persist without token (form-only secret) is ok"
else
  fail "cloud persist should not require token in .env"
fi

# Status redacts cloud_url userinfo
unset RIVETOS_DATAHUB_URL RIVETOS_PG_URL
export RIVETOS_MODE=cloud
export RIVETOS_CLOUD_URL='https://alice:s3cret-cloud@cloud.example:8443/v1'
cloud_out="$("$STATUS")"
if [[ "$cloud_out" == *"s3cret-cloud"* ]] || [[ "$cloud_out" == *"alice:"* ]]; then
  fail "status leaked cloud_url userinfo"
else
  pass "status redacts cloud_url userinfo"
fi
if [[ "$cloud_out" == *"https cloud.example:8443"* ]]; then
  pass "status prints redacted cloud host:port"
else
  fail "status should print redacted cloud scheme host:port"
fi
unset RIVETOS_CLOUD_URL

# Bare host[:port] and IPv6 in status endpoint line
: >"$RIVETOS_ENV_FILE"
export RIVETOS_MODE=local
export RIVETOS_DATAHUB_URL='datahub.example:6543'
bare_out="$("$STATUS")"
if [[ "$bare_out" == *"datahub.example:6543"* ]]; then
  pass "status parses bare host:port"
else
  fail "status should parse bare host:port"
fi
export RIVETOS_DATAHUB_URL='[::1]:5432'
v6_out="$("$STATUS")"
if [[ "$v6_out" == *"::1:5432"* ]]; then
  pass "status parses IPv6 literal"
else
  fail "status should parse bracketed IPv6"
fi
if [[ "$v6_out" == *'['* ]]; then
  fail "status IPv6 line should not include brackets as userinfo"
fi
unset RIVETOS_DATAHUB_URL RIVETOS_PG_URL

# Write through a symlinked env file
REAL_ENV="$HOME_TMP/.rivetos/real.env"
LINK_ENV="$HOME_TMP/.rivetos/link.env"
printf 'RIVETOS_MODE=local\n' >"$REAL_ENV"
ln -s "$REAL_ENV" "$LINK_ENV"
export RIVETOS_ENV_FILE="$LINK_ENV"
export RIVETOS_MODE=local
export RIVETOS_DATAHUB_URL='postgres://symlink.example/db'
"$PERSIST" >/dev/null
if [ -L "$LINK_ENV" ] && grep -q "symlink.example" "$REAL_ENV"; then
  pass "persist writes through symlink"
else
  fail "persist should write through a symlinked env file"
fi
export RIVETOS_ENV_FILE="$HOME_TMP/.rivetos/.env"

# Mixed quotes round-trip through persist + load_env
unset RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_PG_URL RIVETOS_CLOUD_URL RIVETOS_CLOUD_TOKEN
MIXED='p'"'"'ass"word'
export RIVETOS_MODE=local
export RIVETOS_DATAHUB_URL="postgres://u:${MIXED}@datahub.example/db"
: >"$RIVETOS_ENV_FILE"
"$PERSIST" >/dev/null
unset RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_PG_URL
rivetos_load_env
if [ "${RIVETOS_DATAHUB_URL:-}" = "postgres://u:${MIXED}@datahub.example/db" ]; then
  pass "mixed quotes round-trip through persist + load_env"
else
  fail "value with both single and double quotes should round-trip"
fi

# Persist ' + $ in one value. \$ must stay literal through all three readers.
PARSE="$KIT/../rivet-memory/bin/env-parse.mjs"
capture_read() {
  local file="$1"
  local key="$2"
  FILE="$file" KEY="$key" PARSE="$PARSE" node --input-type=module -e '
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
const { parseRivetEnv } = await import(pathToFileURL(process.env.PARSE).href)
const parsed = parseRivetEnv(readFileSync(process.env.FILE, "utf8"))
process.stdout.write(parsed[process.env.KEY] ?? "")
'
}

assert_dollar_roundtrip() {
  local want="$1"
  local label="$2"
  unset RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_PG_URL RIVETOS_CLOUD_URL RIVETOS_CLOUD_TOKEN
  : >"$RIVETOS_ENV_FILE"
  export RIVETOS_MODE=local
  export RIVETOS_DATAHUB_URL="$want"
  "$PERSIST" >/dev/null
  if grep -F '\$' "$RIVETOS_ENV_FILE" >/dev/null; then
    pass "$label persist escapes \$ in double quotes"
  else
    fail "$label persist should write \\\$ for a value that contains both ' and \$"
  fi

  unset RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_PG_URL
  rivetos_load_env
  if [ "${RIVETOS_DATAHUB_URL:-}" = "$want" ]; then
    pass "$label rivet-paths loader"
  else
    fail "$label rivet-paths loader corrupted \$"
  fi

  unset RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_PG_URL
  set -a
  # shellcheck disable=SC1090
  . "$RIVETOS_ENV_FILE"
  set +a
  if [ "${RIVETOS_DATAHUB_URL:-}" = "$want" ]; then
    pass "$label bash source"
  else
    fail "$label bash source corrupted \$"
  fi

  cap="$(capture_read "$RIVETOS_ENV_FILE" RIVETOS_DATAHUB_URL)"
  if [ "$cap" = "$want" ]; then
    pass "$label capture parser"
  else
    fail "$label capture parser corrupted \$"
  fi
}

assert_dollar_roundtrip "a'b\$c" "a'b\$c"
assert_dollar_roundtrip "postgres://u:it's\"q \$HOME@db.example/m" "postgres it's\"q \$HOME"

# BOM-prefixed workspace is kept (no second MODE line)
bom="$(printf '\357\273\277')"
printf '%sRIVETOS_MODE=workspace\n' "$bom" >"$RIVETOS_ENV_FILE"
export RIVETOS_MODE=local
export RIVETOS_DATAHUB_URL='postgres://new.example/db'
"$PERSIST" >/dev/null
got="$(rivetos_env_file_value "$RIVETOS_ENV_FILE" RIVETOS_MODE)"
if [ "$got" = workspace ]; then
  pass "persist does not clobber BOM-prefixed workspace"
else
  fail "BOM-prefixed workspace should be kept (got ${got:-empty})"
fi
mode_n="$(grep -c RIVETOS_MODE "$RIVETOS_ENV_FILE" || true)"
if [ "$mode_n" -eq 1 ]; then
  pass "BOM workspace not followed by a second MODE"
else
  fail "BOM workspace clobber appended another MODE ($mode_n lines)"
fi

# NBSP on a MODE assignment is ambiguous — do not append local
nbsp="$(printf '\302\240')"
printf 'RIVETOS_MODE=%sproduction\n' "$nbsp" >"$RIVETOS_ENV_FILE"
export RIVETOS_MODE=local
export RIVETOS_DATAHUB_URL='postgres://new.example/db'
"$PERSIST" >/dev/null
if grep -q 'RIVETOS_MODE=local' "$RIVETOS_ENV_FILE"; then
  fail "NBSP MODE line should not gain a local assignment"
else
  pass "persist leaves NBSP MODE line alone"
fi

# Non-ASCII comment mentioning RIVETOS_MODE is not a MODE assignment
emdash="$(printf '\342\200\224')"
printf '# RIVETOS_MODE %s pick cloud or local\n' "$emdash" >"$RIVETOS_ENV_FILE"
export RIVETOS_MODE=local
export RIVETOS_DATAHUB_URL='postgres://new.example/db'
"$PERSIST" >/dev/null
got="$(rivetos_env_file_value "$RIVETOS_ENV_FILE" RIVETOS_MODE)"
if [ "$got" = local ]; then
  pass "persist writes mode despite non-ASCII MODE comment"
else
  fail "non-ASCII MODE comment should not strand persist (got ${got:-empty})"
fi

# Same comment next to a real assignment must still rewrite the mode
printf '# RIVETOS_MODE %s note\nRIVETOS_MODE=cloud\n' "$emdash" >"$RIVETOS_ENV_FILE"
export RIVETOS_MODE=local
export RIVETOS_DATAHUB_URL='postgres://new.example/db'
"$PERSIST" >/dev/null
got="$(rivetos_env_file_value "$RIVETOS_ENV_FILE" RIVETOS_MODE)"
if [ "$got" = local ]; then
  pass "persist rewrites mode next to a non-ASCII MODE comment"
else
  fail "comment plus assignment should still write local (got ${got:-empty})"
fi

# bash -x must not leak cloud userinfo or query tokens
unset RIVETOS_DATAHUB_URL RIVETOS_PG_URL
export RIVETOS_MODE=cloud
export RIVETOS_CLOUD_URL='https://alice:s3cret-cloud@cloud.example:8443/v1?token=tok_live_do_not_print'
xout="$(bash -x "$STATUS" 2>&1)" || true
if printf '%s' "$xout" | grep -q 's3cret-cloud\|tok_live_do_not_print'; then
  fail "status leaked a secret under bash -x"
else
  pass "status bash -x does not leak cloud userinfo"
fi
unset RIVETOS_CLOUD_URL

# Scheme-less credentialed endpoints must not print userinfo (stdout/stderr/xtrace)
assert_status_no_secret() {
  local url="$1"
  local secret="$2"
  local which="$3"
  local label="$4"
  local status_out xout
  unset RIVETOS_DATAHUB_URL RIVETOS_PG_URL RIVETOS_CLOUD_URL
  export RIVETOS_MODE=local
  if [ "$which" = cloud ]; then
    export RIVETOS_MODE=cloud
    export RIVETOS_CLOUD_URL="$url"
  else
    export RIVETOS_DATAHUB_URL="$url"
  fi
  status_out="$("$STATUS" 2>&1)" || true
  if printf '%s' "$status_out" | grep -qF "$secret"; then
    fail "$label leaked secret on stdout/stderr"
  else
    pass "$label does not dump secrets"
  fi
  xout="$(bash -x "$STATUS" 2>&1)" || true
  if printf '%s' "$xout" | grep -qF "$secret"; then
    fail "$label leaked secret under bash -x"
  else
    pass "$label bash -x does not leak"
  fi
  unset RIVETOS_DATAHUB_URL RIVETOS_PG_URL RIVETOS_CLOUD_URL
}

assert_status_no_secret 'user:pass@host.example:5432/db' 'user:pass' datahub 'scheme-less user:pass@host:port/path'
assert_status_no_secret 'user:pass@host.example' 'user:pass' datahub 'scheme-less user:pass@host'
assert_status_no_secret 'user:pass@cloud.example' 'user:pass' cloud 'scheme-less cloud_url userinfo'
assert_status_no_secret 'user:p@ss:w0rd@host.example:5432/db' 'p@ss:w0rd' datahub 'scheme-less password with @ and :'
assert_status_no_secret 'u:p@[::1]:5432' 'u:p@' datahub 'scheme-less IPv6 with userinfo'
assert_status_no_secret 'datahub.example/db?password=p@sswor' 'sswor' datahub 'scheme-less @ in query'
assert_status_no_secret 'datahub.example/db@user:pass' 'user:pass' datahub 'scheme-less @ in path'
assert_status_no_secret 'postgres://datahub.example/db?password=p@sswor' 'sswor' datahub 'scheme @ in query'
assert_status_no_secret 'postgres://datahub.example/db@user:pass' 'user:pass' datahub 'scheme @ in path'

# Isolated wrapper: missing sibling must reach the fallback message
ISO="$(mktemp -d "${TMPDIR:-/tmp}/rivetos-wrapper.XXXXXX")"
cp "$WRAPPER" "$ISO/rivetos-memory-mcp.sh"
chmod +x "$ISO/rivetos-memory-mcp.sh"
set +e
wrap_out="$(env -u RIVETOS_ROOT bash "$ISO/rivetos-memory-mcp.sh" 2>&1)"
wrap_rc=$?
set -e
if [ "$wrap_rc" -eq 1 ] && [[ "$wrap_out" == *"launcher not found"* ]]; then
  pass "wrapper missing sibling reaches fallback message"
else
  fail "wrapper should not exit before the not-found message (rc=$wrap_rc)"
fi
rm -rf "$ISO"

# In-tree sibling still present
if [[ -x "$KIT/../rivet-memory/bin/rivet-memory-mcp.sh" ]]; then
  pass "sibling MCP launcher present"
else
  fail "sibling MCP launcher missing"
fi

rm -rf "$HOME_TMP"

if [ "$failed" -ne 0 ]; then
  echo "$failed onboard/status test(s) failed" >&2
  exit 1
fi
echo "onboard-status.test.sh: all ok"
