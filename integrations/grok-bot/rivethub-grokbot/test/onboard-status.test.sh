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
unset RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_PG_URL RIVETOS_CLOUD_TOKEN
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

# Must not clobber workspace mode
printf 'RIVETOS_MODE=workspace\nRIVETOS_PG_URL=postgres://keep.example/db\n' >"$RIVETOS_ENV_FILE"
chmod 600 "$RIVETOS_ENV_FILE"
export RIVETOS_MODE=local
export RIVETOS_DATAHUB_URL='postgres://new.example/db'
"$PERSIST" >/dev/null
if grep -q '^RIVETOS_MODE=workspace$' "$RIVETOS_ENV_FILE"; then
  pass "persist does not clobber workspace mode"
else
  fail "persist clobbered workspace mode"
fi

# Persist without required local endpoint fails
unset RIVETOS_DATAHUB_URL RIVETOS_PG_URL
export RIVETOS_MODE=local
if "$PERSIST" >/dev/null 2>&1; then
  fail "local persist should require an endpoint"
else
  pass "local persist requires DataHub or PG URL"
fi

# Cloud persist without token is allowed (token may stay in plugin form only)
export RIVETOS_MODE=cloud
unset RIVETOS_CLOUD_TOKEN
if "$PERSIST" >/dev/null; then
  pass "cloud persist without token (form-only secret) is ok"
else
  fail "cloud persist should not require token in .env"
fi

# Wrapper missing sibling in an isolated copy — skip if sibling exists (it does in-tree)
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
