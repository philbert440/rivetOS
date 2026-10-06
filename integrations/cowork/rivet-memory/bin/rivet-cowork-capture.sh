#!/bin/sh
# Host-side capture sidecar. Build the capture package once (npm run build
# in capture/) so Desktop can spawn this. Full-VM Cowork cannot see the
# transcript; this process runs on the host.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DIST="$ROOT/capture/dist/cli.js"
if [ ! -f "$DIST" ]; then
  echo "cowork capture is not built: npm run build in $ROOT/capture" >&2
  exit 1
fi
exec node "$DIST" "$@"
