#!/usr/bin/env bash
# Claude Code kit standalone: pin, fail-loud capture, userConfig, safe defaults.
# Never prints secret values. Does not call npm/npx on the network.
set -euo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd -P)"
SHARED="$(cd "$KIT/../../shared" && pwd -P)"
HOOK="$KIT/bin/rivet-memory-hook.sh"
LAUNCH="$KIT/bin/rivet-memory-mcp.sh"
MCP_JSON="$KIT/.mcp.json"
PLUGIN_JSON="$KIT/.claude-plugin/plugin.json"

failed=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; failed=$((failed + 1)); }

bash -n "$HOOK" && pass "hook bash -n" || fail "hook bash -n"
bash -n "$LAUNCH" && pass "launcher bash -n" || fail "launcher bash -n"

# Plugin-local copies must match shared (marketplace dir-only install).
assert_match() {
  local name="$1"
  local a="$SHARED/$name"
  local b="$KIT/lib/$name"
  if [ ! -f "$b" ]; then
    fail "plugin lib/$name missing (needed for marketplace-only install)"
    printf 'Fix: cp "%s" "%s"\n' "$a" "$b" >&2
    return
  fi
  if cmp -s "$a" "$b"; then
    pass "lib/$name matches integrations/shared/$name"
  else
    fail "lib/$name drifted from integrations/shared/$name"
    printf 'Fix: cp "%s" "%s"\n' "$a" "$b" >&2
  fi
}
assert_match rivet-paths.sh

# Directly executed files must survive a marketplace copy with mode 755.
for script in "$KIT"/bin/*.sh "$SHARED"/rivetos-*.sh \
  "$SHARED/rivet-paths.test.sh" "$KIT"/test/*.sh \
  "$KIT/../../grok-bot/rivethub-grokbot/test/onboard-status.test.sh" \
  "$KIT/../../grok-bot/rivethub-grokbot/test/mesh-delegate.test.sh"; do
  if [ -x "$script" ] && [ "$(python3 -c 'import os,stat,sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode)))' "$script")" = 0o755 ]; then
    pass "${script##*/} is executable (755)"
  else
    fail "${script##*/} must be mode 755"
  fi
  if [ "$(head -n 1 "$script")" = '#!/usr/bin/env bash' ] && bash -n "$script"; then
    pass "${script##*/} has a bash shebang and valid syntax"
  else
    fail "${script##*/} needs a bash shebang and valid syntax"
  fi
done
for script in "$SHARED/rivet-paths.sh" "$KIT/lib/rivet-paths.sh"; do
  if [ ! -x "$script" ]; then
    pass "sourced ${script##*/} retains origin/main non-executable mode"
  else
    fail "sourced ${script##*/} must remain non-executable"
  fi
done

# userConfig keys
for k in RIVETOS_MODE RIVETOS_DATAHUB_URL RIVETOS_EMBED_URL RIVETOS_EMBED_MODEL RIVETOS_CLOUD_URL RIVETOS_CLOUD_TOKEN RIVETOS_MCP_ENABLE_MEMORY_WRITE; do
  if grep -q "\"$k\"" "$PLUGIN_JSON"; then
    pass "userConfig declares $k"
  else
    fail "userConfig missing $k"
  fi
done
if grep -q '"sensitive": true' "$PLUGIN_JSON"; then
  pass "userConfig marks secrets sensitive"
else
  fail "userConfig should set sensitive: true on secrets"
fi

# Marketplace substitutions must use a plugin-only channel.
if python3 - "$MCP_JSON" "$PLUGIN_JSON" <<'PYJSON'
import json, sys
mcp = json.load(open(sys.argv[1]))['mcpServers']['rivetos']['env']
keys = json.load(open(sys.argv[2]))['userConfig']
assert all(mcp.get('RIVETOS_PLUGIN_OPT_' + k) == '${user_config.' + k + '}' for k in keys)
assert not any(k in mcp for k in keys)
model = keys['RIVETOS_EMBED_MODEL']
assert model['required'] is False and not model.get('sensitive', False)
assert 'text-embedding-3-small' in model['description']
PYJSON
then
  pass ".mcp.json isolates every userConfig key from inherited environment"
else
  fail ".mcp.json must use the plugin-only namespace"
fi

# Safe defaults: shipped MCP env must not enable shell/file/search.
if grep -q 'RIVETOS_MCP_ENABLE_SHELL' "$MCP_JSON"; then
  fail ".mcp.json must not enable shell"
else
  pass ".mcp.json does not enable shell"
fi
if grep -q 'RIVETOS_MCP_ENABLE_FILE' "$MCP_JSON"; then
  fail ".mcp.json must not enable file"
else
  pass ".mcp.json does not enable file"
fi
if grep -q 'RIVETOS_MCP_ENABLE_SEARCH' "$MCP_JSON"; then
  fail ".mcp.json must not enable search"
else
  pass ".mcp.json does not enable search"
fi
if grep -q 'RIVETOS_PLUGIN_ENV' "$MCP_JSON"; then
  pass ".mcp.json sets RIVETOS_PLUGIN_ENV"
else
  fail ".mcp.json should set RIVETOS_PLUGIN_ENV=1"
fi

# Pin is not hardcoded in the launcher (single constant in rivet-paths.sh).
if grep -E 'mcp-sidecar@[0-9]' "$LAUNCH"; then
  fail "launcher must not hardcode @mcp-sidecar@<version>"
else
  pass "launcher does not hardcode the pin"
fi

# Capture fail-loud when ingest cannot run; always exit 0; no secret dump.
ISO="$(mktemp -d "${TMPDIR:-/tmp}/rivetos-hook.XXXXXX")"
mkdir -p "$ISO/bin"
SECRET='postgres://u:s3cret-hook@host.example/db'
set +e
hook_out="$(
  printf '{}' |
    env -u RIVETOS_CLOUD_TOKEN \
      PATH="$ISO/bin" \
      HOME="$ISO" \
      RIVETOS_ROOT="$ISO" \
      RIVETOS_ENV_FILE="$ISO/none.env" \
      RIVETOS_PG_URL="$SECRET" \
      "$BASH" -e "$HOOK" 2>"$ISO/stderr"
)"
hook_rc=$?
set -e
if [ "$hook_rc" -eq 0 ]; then
  pass "hook exits 0 when ingest cannot run"
else
  fail "hook must exit 0 (got $hook_rc)"
fi
if [ -z "$hook_out" ] && [ "$(wc -l <"$ISO/stderr" | tr -d ' ')" = 1 ] &&
   grep -qx 'rivet-memory-hook: capture ingest cannot run: checkout capture handler unavailable; capture skipped' "$ISO/stderr"; then
  pass "hook fails loud on stderr when ingest cannot run"
else
  fail "hook should log capture ingest cannot run"
fi
if grep -q s3cret-hook "$ISO/stderr" || [[ "$hook_out" == *s3cret-hook* ]]; then
  fail "hook leaked a secret"
else
  pass "hook does not dump secrets"
fi

# Test the installed plugin alone, outside the repository's shared/ layout.
cp -R "$KIT" "$ISO/plugin"
LAUNCH="$ISO/plugin/bin/rivet-memory-mcp.sh"
HOOK="$ISO/plugin/bin/rivet-memory-hook.sh"
HOUSE="$ISO/house"
mkdir -p "$HOUSE/services/mcp-sidecar/dist" "$HOUSE/plugins/providers/claude-cli/dist" \
  "$HOUSE/integrations/shared" "$ISO/home/.rivetos"
: >"$HOUSE/nx.json"
# Reference scripts and helper come from main, not the changed worktree.
have_main=0
if git -C "$KIT" rev-parse --verify origin/main >/dev/null 2>&1; then
  have_main=1
  git -C "$KIT" show origin/main:integrations/claude-code/rivet-memory/bin/rivet-memory-mcp.sh >"$ISO/main-mcp.sh"
  git -C "$KIT" show origin/main:integrations/claude-code/rivet-memory/bin/rivet-memory-hook.sh >"$ISO/main-hook.sh"
  git -C "$KIT" show origin/main:integrations/shared/rivet-paths.sh >"$HOUSE/integrations/shared/rivet-paths.sh"
else
  pass "house comparisons # SKIP origin/main not available"
fi
cat >"$HOUSE/services/mcp-sidecar/dist/cli.js" <<'JS'
const names = Object.keys(process.env).filter(k => k.startsWith('RIVETOS_')).sort();
console.log(JSON.stringify({argv: process.argv.slice(1), names}));
// Assert values inside the stub; never print credentials.
if (process.env.RIVETOS_PG_URL !== 'postgres://fixture:fixture-password@db.example/memory' ||
    process.env.RIVETOS_EMBED_URL !== 'https://embed.example' ||
    process.env.RIVETOS_MODE !== 'workspace' || process.env.RIVETOS_MCP_STDIO !== '1' ||
    process.env.RIVETOS_ROOT !== process.env.EXPECT_ROOT) process.exit(9);
JS
cat >"$ISO/home/.rivetos/.env" <<EOF
RIVETOS_ROOT='$HOUSE'
RIVETOS_MODE=workspace
RIVETOS_PG_URL=postgres://fixture:fixture-password@db.example/memory
RIVETOS_EMBED_URL=https://embed.example
RIVETOS_EMBED_MODEL=text-embedding-3-small
EOF
cat >"$ISO/bin/npx" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$NPX_CALLS"
SH
chmod 755 "$ISO/bin/npx"
fixture_env() {
  env -i HOME="$ISO/home" PATH="$ISO/bin:$PATH" RIVETOS_ROOT="$HOUSE" \
    RIVETOS_PLUGIN_ENV=1 NPX_CALLS="$ISO/npx.calls" EXPECT_ROOT="$HOUSE" "$@"
}
fixture_env "$LAUNCH" >"$ISO/kit.out"
if [ "$have_main" -eq 1 ]; then
  if fixture_env "$BASH" "$ISO/main-mcp.sh" >"$ISO/main.out" &&
     fixture_env "$LAUNCH" >"$ISO/kit.out" && cmp -s "$ISO/main.out" "$ISO/kit.out"; then
    pass "house MCP argv and exported RIVETOS names match origin/main"
  else
    fail "house MCP behavior differs from origin/main"
  fi
fi
if node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(JSON.stringify(x.argv) === JSON.stringify([process.argv[2],"--stdio"]) ? 0 : 1)' \
  "$ISO/kit.out" "$HOUSE/services/mcp-sidecar/dist/cli.js"; then
  pass "house MCP executes node cli.js --stdio"
else
  fail "house MCP argv must be cli.js --stdio"
fi
# Empty and literal plugin settings must fall back to the house env file.
for value in placeholder empty; do
  if [ "$value" = placeholder ]; then
    mode='${user_config.RIVETOS_MODE}'
    pg='${user_config.RIVETOS_PG_URL}'
    embed='${user_config.RIVETOS_EMBED_URL}'
    root='${user_config.RIVETOS_ROOT}'
  else
    mode='' pg='' embed='' root=''
  fi
  if fixture_env RIVETOS_MODE="$mode" RIVETOS_PG_URL="$pg" RIVETOS_EMBED_URL="$embed" \
    RIVETOS_ROOT="$root" RIVETOS_DATAHUB_URL='${user_config.RIVETOS_DATAHUB_URL}' \
    RIVETOS_CLOUD_TOKEN='${user_config.RIVETOS_CLOUD_TOKEN}' \
    RIVETOS_CLOUD_URL='${user_config.RIVETOS_CLOUD_URL}' \
    RIVETOS_MCP_ENABLE_MEMORY_WRITE='${user_config.RIVETOS_MCP_ENABLE_MEMORY_WRITE}' \
    "$LAUNCH" >"$ISO/placeholder.out" && cmp -s "$ISO/kit.out" "$ISO/placeholder.out"; then
    pass "house $value settings resolve from env file with RIVETOS_PLUGIN_ENV=1"
  else
    fail "house $value settings shadow env file or change exported names"
  fi
done
if [ ! -e "$ISO/npx.calls" ]; then
  pass "house MCP never invokes npx"
else
  fail "house MCP invoked npx"
fi
# Real inherited values differ from the file; the stub checks without printing secrets.
if fixture_env RIVETOS_PG_URL=postgres://proc.example/db RIVETOS_ROOT="$ISO/absent" \
  "$LAUNCH" >"$ISO/inherited.out" && cmp -s "$ISO/kit.out" "$ISO/inherited.out"; then
  pass "house env file beats inherited PG URL and ROOT"
else
  fail "house env file must beat inherited PG URL and ROOT"
fi

# Both normal and pane capture paths must match main's argv, env names, and stdin.
cat >"$HOUSE/plugins/providers/claude-cli/dist/hooks.js" <<'JS'
console.log(JSON.stringify({argv: process.argv.slice(1),
  names: Object.keys(process.env).filter(k => k.startsWith('RIVETOS_')).sort(),
  payload: require('fs').readFileSync(0, 'utf8')}));
JS
cat >"$HOUSE/integrations/shared/herdr-report-session.mjs" <<'JS'
import fs from 'node:fs';
console.log(JSON.stringify({argv: process.argv.slice(1),
  names: Object.keys(process.env).filter(k => k.startsWith('RIVETOS_')).sort(),
  payload: fs.readFileSync(0, 'utf8')}));
JS
if [ "$have_main" -eq 1 ]; then
  for pane in 0 1; do
    if printf '{"session_id":"fixture"}' | fixture_env HERDR_ENV="$pane" HERDR_PANE_ID=fixture \
        HERDR_SOCKET_PATH="$ISO/socket" "$BASH" "$ISO/main-hook.sh" >"$ISO/main-hook.out" 2>"$ISO/main-hook.err" &&
       printf '{"session_id":"fixture"}' | fixture_env HERDR_ENV="$pane" HERDR_PANE_ID=fixture \
        HERDR_SOCKET_PATH="$ISO/socket" "$HOOK" >"$ISO/kit-hook.out" 2>"$ISO/kit-hook.err" &&
       cmp -s "$ISO/main-hook.out" "$ISO/kit-hook.out" &&
       [ ! -s "$ISO/main-hook.err" ] && [ ! -s "$ISO/kit-hook.err" ] &&
       [ "$(wc -l <"$ISO/kit-hook.out" | tr -d ' ')" = "$((pane + 1))" ]; then
      pass "house capture ingest matches origin/main (pane=$pane)"
    else
      fail "house capture ingest differs from origin/main (pane=$pane)"
    fi
  done
fi
# Exercise both plugin-only channels against conflicting file/process values.
cat >"$HOUSE/services/mcp-sidecar/dist/cli.js" <<'JS'
const e = process.env;
const plugin = e.EXPECT_PLUGIN === '1';
const nofile = e.EXPECT_NOFILE === '1';
const expected = {
  RIVETOS_PG_URL: plugin ? 'postgres://plugin.example/db' : nofile ? 'postgres://proc.example/db' : 'postgres://file.example/db',
  RIVETOS_MODE: plugin ? 'cloud' : 'workspace',
  RIVETOS_CLOUD_TOKEN: plugin ? 'plugin-token' : 'file-token',
  RIVETOS_ROOT: e.EXPECT_ROOT,
};
if (Object.entries(expected).some(([k,v]) => e[k] !== v)) process.exit(9);
JS
cat >"$ISO/precedence.env" <<EOF
RIVETOS_ROOT='$HOUSE'
RIVETOS_PG_URL=postgres://file.example/db
RIVETOS_DATAHUB_URL=postgres://file-hub.example/db
RIVETOS_MODE=workspace
RIVETOS_CLOUD_TOKEN=file-token
EOF
for prefix in RIVETOS_PLUGIN_OPT_ CLAUDE_PLUGIN_OPTION_; do
  for scenario in supplied placeholder empty; do
    expect=0
    case "$scenario" in
      supplied) hub=postgres://plugin.example/db mode=cloud token=plugin-token expect=1 ;;
      placeholder) hub='${user_config.RIVETOS_DATAHUB_URL}' mode='${user_config.RIVETOS_MODE}' token='${user_config.RIVETOS_CLOUD_TOKEN}' ;;
      empty) hub='' mode='' token='' ;;
    esac
    if fixture_env RIVETOS_ENV_FILE="$ISO/precedence.env" \
      RIVETOS_ROOT="$ISO/absent" RIVETOS_PG_URL=postgres://proc.example/db \
      RIVETOS_DATAHUB_URL=postgres://proc-hub.example/db \
      RIVETOS_MODE=local RIVETOS_CLOUD_TOKEN=proc-token EXPECT_PLUGIN="$expect" \
      "${prefix}RIVETOS_DATAHUB_URL=$hub" "${prefix}RIVETOS_MODE=$mode" \
      "${prefix}RIVETOS_CLOUD_TOKEN=$token" "$LAUNCH"; then
      pass "launcher $prefix $scenario precedence"
    else
      fail "launcher $prefix $scenario precedence"
    fi
  done
done
if fixture_env RIVETOS_ENV_FILE="$ISO/no.env" RIVETOS_PG_URL=postgres://proc.example/db \
  RIVETOS_MODE=workspace RIVETOS_CLOUD_TOKEN=file-token EXPECT_NOFILE=1 "$LAUNCH"; then
  pass "launcher preserves inherited values without env file"
else
  fail "launcher lost inherited values without env file"
fi

# A restricted PATH exercises the missing-npx branch without network access.
mkdir "$ISO/no-npx"
for tool in dirname printenv awk; do
  ln -s "$(command -v "$tool")" "$ISO/no-npx/$tool"
done
set +e
fixture_env PATH="$ISO/no-npx" RIVETOS_ROOT="$ISO/absent" \
  RIVETOS_ENV_FILE="$ISO/no.env" \
  "$BASH" "$LAUNCH" >"$ISO/missing.stdout" 2>"$ISO/missing.stderr"
missing_rc=$?
set -e
if [ "$missing_rc" -eq 127 ] && [ ! -s "$ISO/missing.stdout" ] &&
   [ "$(wc -l <"$ISO/missing.stderr")" -eq 1 ] &&
   grep -q 'install Node.js/npm.*RIVETOS_ROOT.*built RivetOS checkout' "$ISO/missing.stderr"; then
  pass "missing npx exits 127 with one actionable stderr line"
else
  fail "missing npx diagnostic or exit status differs"
fi

# No-checkout MCP executes only the recording npx stub; no registry access.
. "$SHARED/rivet-paths.sh"
printf '%s\n' -y "@rivetos/mcp-sidecar@${RIVETOS_MCP_SIDECAR_VERSION}" --stdio >"$ISO/expected-npx"
if fixture_env RIVETOS_ROOT="$ISO/absent" RIVETOS_ENV_FILE="$ISO/no.env" \
  "$LAUNCH" >"$ISO/npx.stdout" 2>"$ISO/npx.stderr" &&
  cmp -s "$ISO/expected-npx" "$ISO/npx.calls" && [ ! -s "$ISO/npx.stdout" ]; then
  pass "standalone MCP invokes npx -y with shared pin and --stdio"
else
  fail "standalone MCP invocation differs from pinned npx contract"
fi
# Even with npx available, missing checkout capture must log and skip.
printf '%s\n' sentinel >"$ISO/npx.calls"
if printf '{}' | fixture_env RIVETOS_ROOT="$ISO/absent" RIVETOS_ENV_FILE="$ISO/no.env" \
  "$HOOK" >"$ISO/capture.stdout" 2>"$ISO/capture.stderr" &&
  [ "$(cat "$ISO/npx.calls")" = sentinel ] && [ ! -s "$ISO/capture.stdout" ] &&
  [ "$(wc -l <"$ISO/capture.stderr" | tr -d ' ')" = 1 ] &&
  grep -q 'capture ingest cannot run:' "$ISO/capture.stderr"; then
  pass "standalone capture logs once and skips without invoking npx"
else
  fail "standalone capture must log once and skip"
fi

rm -rf "$ISO"

if [ "$failed" -ne 0 ]; then
  echo "$failed standalone test(s) failed" >&2
  exit 1
fi
echo "standalone.test.sh: all ok"
