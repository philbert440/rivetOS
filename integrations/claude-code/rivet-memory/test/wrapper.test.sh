#!/usr/bin/env bash
# Installed-plugin case: no ../lib, no shared tree, and no /opt helper.
# The env exported to node must be RIVETOS_CAPTURE_TRANSPORT=pg.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
WRAPPER="$ROOT/../bin/rivet-memory-hook.sh"
failed=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; failed=$((failed + 1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/claude-hook-wrapper.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

install="$TMP/a/b/c/d/plugin"
mkdir -p "$install/bin" "$TMP/root/plugins/providers/claude-cli/dist" "$TMP/fakebin"
cp "$WRAPPER" "$install/bin/rivet-memory-hook.sh"
: > "$TMP/root/plugins/providers/claude-cli/dist/hooks.js"

cat > "$TMP/fakebin/node" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "${RIVETOS_CAPTURE_TRANSPORT-}" > "$NODE_ENV_OUT"
exit 0
EOF
chmod +x "$TMP/fakebin/node"

out="$TMP/transport"
stderr="$TMP/stderr"
env -u RIVETOS_CAPTURE_TRANSPORT -u HERDR_ENV \
  RIVETOS_ENV_FILE="$TMP/no-such-env" \
  RIVETOS_ROOT="$TMP/root" \
  NODE_ENV_OUT="$out" \
  PATH="$TMP/fakebin:$PATH" \
  bash "$install/bin/rivet-memory-hook.sh" \
  >"$TMP/stdout" 2>"$stderr" || true

if [ ! -f "$out" ]; then
  fail "node was not invoked"
elif [ "$(cat "$out")" = "pg" ]; then
  pass "node sees RIVETOS_CAPTURE_TRANSPORT=pg"
else
  fail "node saw RIVETOS_CAPTURE_TRANSPORT=$(cat "$out")"
fi
  pass "stderr says den transport is disabled"
else
  fail "stderr missing pg fallback line"
fi

if [ "$failed" -ne 0 ]; then
  echo "$failed wrapper test(s) failed" >&2
  exit 1
fi
echo "wrapper.test.sh: all ok"
