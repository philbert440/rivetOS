#!/usr/bin/env bash
# Thin wrapper — implementation lives in integrations/shared/ (lib/ copy for
# marketplace installs that only have this plugin directory).
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
_impl=""
for _c in \
  "$_here/../lib/rivetos-status.sh" \
  "$_here/../../../shared/rivetos-status.sh" \
  "${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/rivetos-status.sh"; do
  if [ -f "$_c" ]; then
    _impl="$_c"
    break
  fi
done
if [ -z "$_impl" ]; then
  echo "rivetos-status: shared helper not found" >&2
  exit 1
fi
# shellcheck source=../../../shared/rivetos-status.sh
. "$_impl"
