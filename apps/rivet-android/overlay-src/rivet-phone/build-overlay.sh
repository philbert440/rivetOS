#!/usr/bin/env bash
# Build app/src/main/assets/rivet-phone-overlay.bin — phone CLI + device-control skill
# baked into the proot rootfs by RivetRuntime (ensureRivetPhone / equivalent — wired by reviewer).
#
# Contents (extracted with `tar -xzf -C <rootfs>`):
#   opt/rivet-phone/bin/phone
#   opt/rivet-phone/lib/phone.mjs
#   opt/rivet-phone/skills/device-control/SKILL.md
#   opt/register-phone.sh
#   usr/local/bin/phone -> /opt/rivet-phone/bin/phone
#
# The rev marker (opt/.rivet-phone-rev) is deliberately NOT baked into the tar — it is written
# by RivetRuntime.ensureRivetPhone ONLY after register-phone.sh succeeds. Baking it would stamp
# success at extract time, so a single failed registration would wedge the install forever
# (marker == rev → every later launch skips re-provisioning).
#
# After running, bump RIVET_PHONE_OVERLAY_REV in RivetRuntime.kt so it re-provisions on next launch.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/app/src/main/assets/rivet-phone-overlay.bin"
REV="${RIVET_PHONE_OVERLAY_REV:-3}"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p \
  "$work/overlay/opt/rivet-phone/bin" \
  "$work/overlay/opt/rivet-phone/lib" \
  "$work/overlay/opt/rivet-phone/skills/device-control" \
  "$work/overlay/usr/local/bin"

cp "$HERE/bin/phone" "$work/overlay/opt/rivet-phone/bin/phone"
cp "$HERE/lib/phone.mjs" "$work/overlay/opt/rivet-phone/lib/phone.mjs"
cp "$HERE/skills/device-control/SKILL.md" "$work/overlay/opt/rivet-phone/skills/device-control/SKILL.md"
cp "$HERE/register-phone.sh" "$work/overlay/opt/register-phone.sh"

chmod +x \
  "$work/overlay/opt/rivet-phone/bin/phone" \
  "$work/overlay/opt/register-phone.sh"

ln -sf /opt/rivet-phone/bin/phone "$work/overlay/usr/local/bin/phone"

mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$work/overlay" .
echo "built $OUT ($(du -h "$OUT" | cut -f1)) rev=$REV"
tar -tvzf "$OUT" | sort -k6
