#!/usr/bin/env bash
# Artifact + launcher contract for the T3 Code rivet-memory prototype.
# Never prints secret values. Does not call npm/npx on the network.
set -euo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd -P)"
SHARED="$(cd "$KIT/../../shared" && pwd -P)"
REPO="$(cd "$KIT/../../.." && pwd -P)"

failed=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; failed=$((failed + 1)); }

bash -n "$KIT/bin/rivet-memory-mcp.sh" && pass "stdio launcher bash -n" || fail "stdio launcher bash -n"
bash -n "$KIT/bin/rivet-memory-mcp-http.sh" && pass "http launcher bash -n" || fail "http launcher bash -n"
bash -n "$KIT/bin/setup-t3code-rivetos-memory.sh" && pass "setup bash -n" || fail "setup bash -n"

for f in plugin.json t3-plugin.json mcp.json mcp-http.json; do
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$KIT/$f" \
    && pass "$f is JSON" || fail "$f is JSON"
done

name="$(python3 -c "import json; print(json.load(open('$KIT/t3-plugin.json'))['name'])")"
if printf '%s' "$name" | grep -Eq '^[a-z0-9-]+$'; then
  pass "t3-plugin name matches [a-z0-9-]"
else
  fail "t3-plugin name matches [a-z0-9-]"
fi

mcp_url="$(python3 -c "import json; print(json.load(open('$KIT/t3-plugin.json'))['mcpUrl'])")"
case "$mcp_url" in
  http://127.0.0.1:*/mcp) pass "t3-plugin mcpUrl is loopback /mcp" ;;
  *) fail "t3-plugin mcpUrl is loopback /mcp" ;;
esac

http_type="$(python3 -c "import json; print(json.load(open('$KIT/mcp-http.json'))['mcpServers']['rivetos']['type'])")"
[ "$http_type" = http ] && pass "mcp-http type is http" || fail "mcp-http type is http"

headers="$(python3 -c "import json; print('headers' in json.load(open('$KIT/mcp-http.json'))['mcpServers']['rivetos'])")"
[ "$headers" = False ] && pass "mcp-http has no headers" || fail "mcp-http has no headers"

if grep -R -n -E 'postgres://[^[:space:]]+:[^[:space:]]+@|sk-[A-Za-z0-9]|RIVETOS_CLOUD_TOKEN=.+' \
  "$KIT/README.md" "$KIT/plugin.json" "$KIT/t3-plugin.json" "$KIT/mcp.json" "$KIT/mcp-http.json" >/dev/null; then
  fail "kit files contain no hardcoded secrets"
else
  pass "kit files contain no hardcoded secrets"
fi

# setup --print must not touch HOME configs
DUMMY="$(mktemp -d "${TMPDIR:-/tmp}/t3code-rivetos.XXXXXX")"
trap 'rm -rf "$DUMMY"' EXIT
if ! HOME="$DUMMY" CLAUDE_CONFIG_FILE="$DUMMY/missing.json" \
  RIVETOS_ROOT="$REPO" bash "$KIT/bin/setup-t3code-rivetos-memory.sh" --print >/dev/null; then
  fail "setup --print exits 0"
else
  pass "setup --print exits 0"
fi
if [ -e "$DUMMY/.claude.json" ] || [ -e "$DUMMY/.rivetos" ]; then
  fail "setup --print writes no home files"
else
  pass "setup --print writes no home files"
fi

# --apply writes generated files and a Claude merge; --remove undoes them
HOME="$DUMMY" CLAUDE_CONFIG_FILE="$DUMMY/.claude.json" \
  RIVETOS_HOME="$DUMMY/.rivetos" RIVETOS_ROOT="$REPO" \
  bash "$KIT/bin/setup-t3code-rivetos-memory.sh" --apply >/dev/null
if [ -f "$DUMMY/.rivetos/t3code-rivetos-memory/t3-plugin.json" ] \
  && [ -f "$DUMMY/.claude.json" ]; then
  pass "setup --apply writes state + Claude MCP"
else
  fail "setup --apply writes state + Claude MCP"
fi
has_rivetos="$(python3 -c "import json; print('rivetos' in json.load(open('$DUMMY/.claude.json')).get('mcpServers', {}))")"
[ "$has_rivetos" = True ] && pass "Claude merge has rivetos" || fail "Claude merge has rivetos"

HOME="$DUMMY" CLAUDE_CONFIG_FILE="$DUMMY/.claude.json" \
  RIVETOS_HOME="$DUMMY/.rivetos" RIVETOS_ROOT="$REPO" \
  bash "$KIT/bin/setup-t3code-rivetos-memory.sh" --remove >/dev/null
if [ ! -e "$DUMMY/.rivetos/t3code-rivetos-memory" ]; then
  pass "setup --remove deletes state dir"
else
  fail "setup --remove deletes state dir"
fi
has_rivetos="$(python3 -c "import json; print('rivetos' in json.load(open('$DUMMY/.claude.json')).get('mcpServers', {}))")"
[ "$has_rivetos" = False ] && pass "setup --remove drops Claude rivetos" || fail "setup --remove drops Claude rivetos"

# Launchers resolve without spawning the sidecar
export RIVETOS_ENV_FILE="$DUMMY/no.env"
export RIVETOS_PG_URL='postgres://fixture.example/db'
export RIVETOS_MCP_LAUNCH_PRINT=1
if [ -f "$REPO/services/mcp-sidecar/dist/cli.js" ]; then
  out="$(RIVETOS_ROOT="$REPO" bash "$KIT/bin/rivet-memory-mcp.sh" 2>&1 >/dev/null)" || true
  case "$out" in
    checkout\ *) pass "stdio launcher print: checkout when built" ;;
    *) fail "stdio launcher print: checkout when built" ;;
  esac
  out="$(RIVETOS_ROOT="$REPO" bash "$KIT/bin/rivet-memory-mcp-http.sh" 2>&1 >/dev/null)" || true
  case "$out" in
    checkout\ *) pass "http launcher print: checkout when built" ;;
    *) fail "http launcher print: checkout when built" ;;
  esac
else
  pass "sidecar not built — skip checkout print (helpers still ran)"
fi

# Shared path helper still exists (this kit sources it, does not copy it)
[ -f "$SHARED/rivet-paths.sh" ] && pass "shared rivet-paths.sh present" || fail "shared rivet-paths.sh present"

if [ "$failed" -ne 0 ]; then
  echo "$failed failed" >&2
  exit 1
fi
echo "ok"
