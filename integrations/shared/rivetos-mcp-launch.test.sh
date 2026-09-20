#!/usr/bin/env bash
# Launcher branch selection: built checkout vs npx. Never fetches npm.
# Never prints secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=./rivet-paths.sh
. "$ROOT/rivet-paths.sh"

failed=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; failed=$((failed + 1)); }

bash -n "$ROOT/rivet-paths.sh" && pass "rivet-paths bash -n" || fail "rivet-paths bash -n"
bash -n "$ROOT/rivetos-onboard-persist.sh" && pass "persist bash -n" || fail "persist bash -n"
bash -n "$ROOT/rivetos-status.sh" && pass "status bash -n" || fail "status bash -n"

# Pin surface: spec strings use the one constant.
spec="$(rivetos_npx_mcp_spec)"
if [ "$spec" = "@rivetos/mcp-sidecar@${RIVETOS_MCP_SIDECAR_VERSION}" ]; then
  pass "npx mcp spec uses the pin constant"
else
  fail "npx mcp spec should be @rivetos/mcp-sidecar@<pin>"
fi
cap="$(rivetos_npx_capture_spec)"
if [ "$cap" = "@rivetos/provider-claude-cli@${RIVETOS_MCP_SIDECAR_VERSION}" ]; then
  pass "npx capture spec uses the same pin"
else
  fail "npx capture spec should share the pin"
fi

# With a built checkout: RIVETOS_ROOT pointing at this repo (walk-up also works).
REPO="$(cd "$ROOT/../.." && pwd -P)"
export RIVETOS_ROOT="$REPO"
if [ -f "$REPO/services/mcp-sidecar/dist/cli.js" ]; then
  kind="$(rivetos_resolve_mcp_launch)"
  case "$kind" in
    checkout\ "$REPO/services/mcp-sidecar/dist/cli.js")
      pass "built checkout selects checkout branch"
      ;;
    *)
      fail "built checkout should print checkout <cli.js>"
      ;;
  esac
else
  # Tree exists but sidecar not built → existing error, not npx.
  set +e
  kind="$(rivetos_resolve_mcp_launch 2>/dev/null)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    pass "unbuilt checkout keeps the build-error path (not npx)"
  else
    fail "unbuilt checkout must not silently take npx"
  fi
fi
unset RIVETOS_ROOT

# Without a checkout: dummy RIVETOS_ROOT that is not a RivetOS tree.
DUMMY="$(mktemp -d "${TMPDIR:-/tmp}/rivetos-npx-branch.XXXXXX")"
export RIVETOS_ROOT="$DUMMY"
kind="$(rivetos_resolve_mcp_launch)"
if [ "$kind" = npx ]; then
  pass "no checkout selects npx branch"
else
  fail "no checkout should print npx"
fi

cap_kind="$(rivetos_resolve_capture "$DUMMY")"
if [ "$cap_kind" = npx ]; then
  pass "no checkout capture selects npx"
else
  fail "no checkout capture should print npx"
fi
unset RIVETOS_ROOT

# Explicit tree that looks like RivetOS but has no dist → error, not npx.
TREE="$(mktemp -d "${TMPDIR:-/tmp}/rivetos-tree.XXXXXX")"
: >"$TREE/nx.json"
mkdir -p "$TREE/services/mcp-sidecar"
export RIVETOS_ROOT="$TREE"
set +e
kind="$(rivetos_resolve_mcp_launch 2>/dev/null)"
rc=$?
set -e
if [ "$rc" -ne 0 ] && [ "$kind" != npx ]; then
  pass "unbuilt dummy tree does not fall through to npx"
else
  fail "unbuilt dummy tree should error rather than npx"
fi
unset RIVETOS_ROOT

# Claude launcher print mode: checkout vs npx without spawning node/npx.
LAUNCH="$ROOT/../claude-code/rivet-memory/bin/rivet-memory-mcp.sh"
bash -n "$LAUNCH" && pass "claude mcp launcher bash -n" || fail "claude mcp launcher bash -n"

if [ -f "$REPO/services/mcp-sidecar/dist/cli.js" ]; then
  out="$(RIVETOS_ROOT="$REPO" RIVETOS_ENV_FILE="$DUMMY/no.env" RIVETOS_PG_URL=postgres://fixture.example/db RIVETOS_MCP_LAUNCH_PRINT=1 bash "$LAUNCH" 2>&1 >"$DUMMY/stdout")"
  case "$out" in
    checkout\ *)
      pass "claude launcher print: checkout when tree is built"
      ;;
    *)
      fail "claude launcher print should be checkout <path> with a built tree"
      ;;
  esac
fi

out="$(RIVETOS_ROOT="$DUMMY" RIVETOS_ENV_FILE="$DUMMY/no.env" RIVETOS_PG_URL=postgres://fixture.example/db RIVETOS_MCP_LAUNCH_PRINT=1 bash "$LAUNCH" 2>&1 >"$DUMMY/stdout")"
if [ "$out" = npx ]; then
  pass "claude launcher print: npx without a checkout"
else
  fail "claude launcher print should be npx without a checkout"
fi

if [ ! -s "$DUMMY/stdout" ]; then
  pass "launcher print mode leaves JSON-RPC stdout empty"
else
  fail "launcher print mode wrote to stdout"
fi

# Print mode never includes secrets.
SECRET='postgres://tenant:s3cret-launch@datahub.example/db'
mix="$(RIVETOS_ROOT="$DUMMY" RIVETOS_MCP_LAUNCH_PRINT=1 RIVETOS_PG_URL="$SECRET" bash "$LAUNCH" 2>&1)" || true
if printf '%s' "$mix" | grep -q s3cret-launch; then
  fail "launcher leaked a secret in print mode"
else
  pass "launcher print mode does not dump secrets"
fi

# Exercise the real exec path with a local stub: diagnostic never owns exit status.
mkdir -p "$TREE/services/mcp-sidecar/dist" "$DUMMY/bin"
: >"$TREE/services/mcp-sidecar/dist/cli.js"
cat >"$DUMMY/bin/node" <<'SH'
#!/usr/bin/env bash
[ "${RIVETOS_EMBED_MODEL:-}" = "$EXPECT_MODEL" ] || exit 91
printf '%s\n' server-stdout
exit 23
SH
chmod 755 "$DUMMY/bin/node"
for scenario in pg datahub pg_datahub model no_database no_embed placeholder file_model; do
  for prefix in RIVETOS_PLUGIN_OPT_ CLAUDE_PLUGIN_OPTION_; do
    pg='' hub='' embed=https://fixture:embed-secret@embed.example model='' expected_model=''
    : >"$DUMMY/launch.env"
    case "$scenario" in
      pg|no_embed|placeholder|file_model) pg=postgres://fixture:pg-secret@db.example/db ;;
      pg_datahub) hub=postgresql://fixture:hub-secret@hub.example/db ;;
      datahub|model) hub=https://fixture:hub-secret@hub.example ;;
    esac
    [ "$scenario" != no_embed ] || embed=''
    [ "$scenario" != model ] || { model=text-embedding-3-small; expected_model="$model"; }
    [ "$scenario" != placeholder ] || model='${user_config.RIVETOS_EMBED_MODEL}'
    if [ "$scenario" = file_model ]; then
      printf 'RIVETOS_EMBED_MODEL=file-model\n' >"$DUMMY/launch.env"
      model='${user_config.RIVETOS_EMBED_MODEL}' expected_model=file-model
    fi
    rc=0
    env -i PATH="$DUMMY/bin:$PATH" HOME="$DUMMY" RIVETOS_ROOT="$TREE" \
      RIVETOS_ENV_FILE="$DUMMY/launch.env" RIVETOS_PG_URL="$pg" RIVETOS_CLOUD_TOKEN=fixture \
      EXPECT_MODEL="$expected_model" "${prefix}RIVETOS_DATAHUB_URL=$hub" \
      "${prefix}RIVETOS_EMBED_URL=$embed" "${prefix}RIVETOS_EMBED_MODEL=$model" \
      bash "$LAUNCH" >"$DUMMY/out" 2>"$DUMMY/err" || rc=$?
    expected=0
    case "$scenario" in pg|pg_datahub|placeholder) expected=1 ;; esac
    if [ "$rc" -eq 23 ] && [ "$(cat "$DUMMY/out")" = server-stdout ] &&
       [ "$(wc -l <"$DUMMY/err")" -eq "$expected" ] &&
       [ "$(grep -c RIVETOS_EMBED_MODEL "$DUMMY/err" || true)" -eq "$expected" ] &&
       ! grep -Eq 'embed-secret|pg-secret|hub-secret' "$DUMMY/err"; then
      pass "launcher embed diagnostic preserves exec: $scenario $prefix"
    else
      fail "launcher embed diagnostic: $scenario $prefix"
    fi
  done
done

rm -rf "$DUMMY" "$TREE"

if [ "$failed" -ne 0 ]; then
  echo "$failed mcp-launch test(s) failed" >&2
  exit 1
fi
echo "rivetos-mcp-launch.test.sh: all ok"
