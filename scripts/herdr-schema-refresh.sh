#!/usr/bin/env bash
# herdr-schema-refresh — regenerate the pinned herdr API schema reference.
#
# Run this ON THE NODE after bumping the herdr pin (HERDR_VERSION in
# packages/cli/src/lib/herdr.ts), then review the diff:
#
#   scripts/herdr-schema-refresh.sh
#   git diff integrations/herdr/schema/herdr-api.schema.json
#
# The vitest in integrations/herdr/schema/herdr-schema.test.ts asserts every
# method/event the den herdr backend depends on, so a bump that removes or
# reshapes one fails CI with the diff visible in review.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/integrations/herdr/schema/herdr-api.schema.json"
HERDR_BIN="${HERDR_BIN:-$HOME/.local/bin/herdr}"

if [ ! -x "$HERDR_BIN" ]; then
  echo "herdr not found at $HERDR_BIN (set HERDR_BIN, or: rivetos install --herdr)" >&2
  exit 1
fi

echo "refreshing $OUT from $("$HERDR_BIN" --version) ($HERDR_BIN)"
"$HERDR_BIN" api schema --json > "$OUT"
echo "wrote $(wc -c < "$OUT") bytes — run: git diff $OUT"
