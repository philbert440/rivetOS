#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
PLUGIN="$TEST_ROOT/integrations/opencode/rivet-memory"
mkdir -p "$PLUGIN/bin" "$PLUGIN/capture/dist" "$TEST_ROOT/bin"
cp "$TEST_DIR/../../bin/opencode-memory-capture.sh" "$PLUGIN/bin/"
touch "$PLUGIN/capture/dist/opencode-memory-capture.js"
cat > "$TEST_ROOT/bin/node" <<'NODE'
#!/usr/bin/env bash
printf '%s' "${RIVETOS_CAPTURE_TRANSPORT:-unset}" > "$CAPTURE_TEST_RESULT"
NODE
chmod +x "$TEST_ROOT/bin/node"
# An isolated installed tree has neither a shared helper nor an /opt fallback.
env -i PATH="$TEST_ROOT/bin:$PATH" HOME="$TEST_ROOT" RIVETOS_ROOT="$TEST_ROOT"   CAPTURE_TEST_RESULT="$TEST_ROOT/result"   bash "$PLUGIN/bin/opencode-memory-capture.sh" SessionEnd 2> "$TEST_ROOT/stderr"
[[ "$(cat "$TEST_ROOT/result")" == pg ]]
grep -Eq 'den transport disabled: rivet-paths.sh not found; using pg' "$TEST_ROOT/stderr"
