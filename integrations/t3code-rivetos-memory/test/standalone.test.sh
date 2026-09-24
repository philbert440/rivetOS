#!/usr/bin/env bash
# Artifact + launcher contract for the T3 Code rivet-memory prototype.
# Never prints secret values. Does not call npm/npx on the network.
set -euo pipefail

# Keep the apply path on HOME unless a test sets CLAUDE_CONFIG_DIR itself.
unset CLAUDE_CONFIG_DIR
unset CLAUDE_CONFIG_FILE

KIT="$(cd "$(dirname "$0")/.." && pwd -P)"
SHARED="$(cd "$KIT/../shared" && pwd -P)"
REPO="$(cd "$KIT/../.." && pwd -P)"

failed=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; failed=$((failed + 1)); }

bash -n "$KIT/bin/rivet-memory-mcp.sh" && pass "stdio launcher bash -n" || fail "stdio launcher bash -n"
bash -n "$KIT/bin/rivet-memory-mcp-http.sh" && pass "http launcher bash -n" || fail "http launcher bash -n"
bash -n "$KIT/bin/setup-t3code-rivetos-memory.sh" && pass "setup bash -n" || fail "setup bash -n"
bash -n "$KIT/bin/t3code-memory-capture.sh" && pass "capture launcher bash -n" || fail "capture launcher bash -n"
[ -x "$KIT/bin/t3code-memory-capture.sh" ] && pass "capture launcher is executable" || fail "capture launcher is executable"

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
  --exclude-dir=node_modules --exclude-dir=dist \
  "$KIT/README.md" "$KIT/T3.md" "$KIT/plugin.json" "$KIT/t3-plugin.json" "$KIT/mcp.json" "$KIT/mcp-http.json" \
  "$KIT/capture/README.md" "$KIT/capture/src" "$KIT/capture/test" "$KIT/bin" >/dev/null; then
  fail "kit files contain no hardcoded secrets"
else
  pass "kit files contain no hardcoded secrets"
fi

# setup --print must not touch HOME configs
DUMMY="$(mktemp -d "${TMPDIR:-/tmp}/t3code-rivetos.XXXXXX")"
bad_home=""
bak_home=""
cfg_dir=""
cfg_home=""
cleanup() {
  rm -rf "$DUMMY"
  [ -n "$bad_home" ] && rm -rf "$bad_home"
  [ -n "$bak_home" ] && rm -rf "$bak_home"
  [ -n "$cfg_dir" ] && rm -rf "$cfg_dir"
  [ -n "$cfg_home" ] && rm -rf "$cfg_home"
}
trap cleanup EXIT
print_out="$(HOME="$DUMMY" CLAUDE_CONFIG_FILE="$DUMMY/missing.json" \
  RIVETOS_ROOT="$REPO" bash "$KIT/bin/setup-t3code-rivetos-memory.sh" --print)" || print_out=""
if [ -n "$print_out" ]; then
  pass "setup --print exits 0"
else
  fail "setup --print exits 0"
fi
printf '%s' "$print_out" | grep -q 't3code-memory-capture.sh" --watch' \
  && pass "setup --print documents capture sidecar" \
  || fail "setup --print documents capture sidecar"
printf '%s' "$print_out" | grep -F "bash \"$REPO/integrations/t3code-rivetos-memory/bin/rivet-memory-mcp.sh\"" >/dev/null \
  && pass "setup --print quotes the launcher" \
  || fail "setup --print quotes the launcher"
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

status_out="$(HOME="$DUMMY" RIVETOS_T3CODE_STATE="$DUMMY/t3code-capture-state.json" \
  RIVETOS_ENV_FILE="$DUMMY/no.env" bash "$KIT/bin/t3code-memory-capture.sh" --status)" || true
printf '%s' "$status_out" | grep -q 'lastIngestAt: never' \
  && pass "capture --status prints cursor without PG" \
  || fail "capture --status prints cursor without PG"

# Shared path helper still exists (this kit sources it, does not copy it)
[ -f "$SHARED/rivet-paths.sh" ] && pass "shared rivet-paths.sh present" || fail "shared rivet-paths.sh present"

# Non-object ~/.claude.json is refused and left untouched.
bad_home="$(mktemp -d "${TMPDIR:-/tmp}/t3code-badjson.XXXXXX")"
printf '%s\n' '[1, 2]' > "$bad_home/.claude.json"
bad_before="$(cat "$bad_home/.claude.json")"
if HOME="$bad_home" CLAUDE_CONFIG_DIR= RIVETOS_HOME="$bad_home/.rivetos" RIVETOS_ROOT="$REPO" \
  bash "$KIT/bin/setup-t3code-rivetos-memory.sh" --apply >/dev/null 2>&1; then
  fail "non-object ~/.claude.json is refused"
else
  pass "non-object ~/.claude.json is refused"
fi
bad_after="$(cat "$bad_home/.claude.json")"
if [ "$bad_before" = "$bad_after" ] && [ ! -e "$bad_home/.claude.json.bak" ]; then
  pass "non-object ~/.claude.json is untouched"
else
  fail "non-object ~/.claude.json is untouched"
fi

# A real object gets a one-time .bak and is not clobbered on a second write.
bak_home="$(mktemp -d "${TMPDIR:-/tmp}/t3code-bak.XXXXXX")"
printf '%s\n' '{"keep":1}' > "$bak_home/.claude.json"
HOME="$bak_home" CLAUDE_CONFIG_DIR= RIVETOS_HOME="$bak_home/.rivetos" RIVETOS_ROOT="$REPO" \
  bash "$KIT/bin/setup-t3code-rivetos-memory.sh" --apply >/dev/null
if [ -f "$bak_home/.claude.json.bak" ]; then
  pass "setup --apply creates .claude.json.bak"
else
  fail "setup --apply creates .claude.json.bak"
fi
bak_has_keep="$(python3 -c "import json; print(json.load(open('$bak_home/.claude.json.bak')).get('keep'))")"
live_has_rivetos="$(python3 -c "import json; print('rivetos' in json.load(open('$bak_home/.claude.json')).get('mcpServers', {}))")"
[ "$bak_has_keep" = 1 ] && pass "bak is the pre-merge object" || fail "bak is the pre-merge object"
[ "$live_has_rivetos" = True ] && pass "apply still merges rivetos" || fail "apply still merges rivetos"
HOME="$bak_home" CLAUDE_CONFIG_DIR= RIVETOS_HOME="$bak_home/.rivetos" RIVETOS_ROOT="$REPO" \
  bash "$KIT/bin/setup-t3code-rivetos-memory.sh" --apply --force >/dev/null
bak_still="$(python3 -c "import json; print(json.load(open('$bak_home/.claude.json.bak')).get('keep'))")"
[ "$bak_still" = 1 ] && pass "existing .bak is not overwritten" || fail "existing .bak is not overwritten"

# CLAUDE_CONFIG_DIR is the apply path --print advertises.
cfg_dir="$(mktemp -d "${TMPDIR:-/tmp}/t3code-cfgdir.XXXXXX")"
cfg_home="$(mktemp -d "${TMPDIR:-/tmp}/t3code-cfghome.XXXXXX")"
cfg_out="$(HOME="$cfg_home" CLAUDE_CONFIG_DIR="$cfg_dir" RIVETOS_HOME="$cfg_home/.rivetos" RIVETOS_ROOT="$REPO" \
  bash "$KIT/bin/setup-t3code-rivetos-memory.sh" --apply)" || cfg_out=""
if [ -f "$cfg_dir/.claude.json" ] && [ ! -e "$cfg_home/.claude.json" ]; then
  pass "apply honours CLAUDE_CONFIG_DIR"
else
  fail "apply honours CLAUDE_CONFIG_DIR"
fi
printf '%s' "$cfg_out" | grep -F "$cfg_dir/.claude.json" >/dev/null \
  && pass "print shows CLAUDE_CONFIG_DIR path" \
  || fail "print shows CLAUDE_CONFIG_DIR path"

# Non-loopback bind without a token exits non-zero. The override is allowed.
http_rc=0
http_out="$(MCP_HOST=0.0.0.0 RIVETOS_MCP_TOKEN= RIVETOS_MCP_ALLOW_INSECURE_BIND= RIVETOS_ROOT="$REPO" \
  bash "$KIT/bin/rivet-memory-mcp-http.sh" 2>&1)" || http_rc=$?
if [ "$http_rc" -ne 0 ]; then
  pass "non-loopback bind without a token exits non-zero"
else
  fail "non-loopback bind without a token exits non-zero"
fi
printf '%s' "$http_out" | grep -q 'refusing non-loopback' \
  && pass "non-loopback refusal is explicit" \
  || fail "non-loopback refusal is explicit"
allow_out="$(MCP_HOST=0.0.0.0 RIVETOS_MCP_TOKEN= RIVETOS_MCP_ALLOW_INSECURE_BIND=1 RIVETOS_ROOT="$REPO" \
  bash "$KIT/bin/rivet-memory-mcp-http.sh" 2>&1)" || true
if printf '%s' "$allow_out" | grep -q 'refusing non-loopback'; then
  fail "insecure-bind override is allowed"
else
  pass "insecure-bind override is allowed"
fi

if [ "$failed" -ne 0 ]; then
  echo "$failed failed" >&2
  exit 1
fi
echo "ok"
