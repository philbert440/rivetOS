#!/bin/sh
# Host-side capture sidecar. `rivetos plugins install cowork` writes the
# single-file bundle this script execs. Full-VM Cowork cannot see the
# transcript; this process runs on the host. Node is enough at runtime.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DIST="$ROOT/capture/dist/cli.js"
if [ ! -f "$DIST" ]; then
  echo "cowork capture is not built: rivetos plugins install cowork" >&2
  exit 1
fi
exec node "$DIST" "$@"
