#!/usr/bin/env bash
# Build app/src/main/assets/rivet-shared-overlay.bin — the userspace NFS client + `rivet-shared`
# wrapper baked into the proot rootfs by RivetRuntime.ensureRivetShared().
#
# Contents (extracted with `tar -xzf -C <rootfs>`):
#   opt/rivet-shared/bin/{nfs-ls,nfs-cat,nfs-cp,nfs-stat}  (arm64, from libnfs-utils)
#   opt/rivet-shared/bin/rivet-shared                      (the wrapper, this dir)
#   opt/rivet-shared/lib/libnfs.so.14[.0.0]                (from libnfs14)
#   usr/local/bin/rivet-shared -> /opt/rivet-shared/bin/rivet-shared   (PATH symlink)
#
# After running, bump RIVET_SHARED_OVERLAY_REV in RivetRuntime.kt so it re-provisions on next launch.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
VER="${LIBNFS_VER:-5.0.2-1build1}"
OUT="$REPO/app/src/main/assets/rivet-shared-overlay.bin"
P_MAIN="http://ports.ubuntu.com/ubuntu-ports/pool/main/libn/libnfs"
P_UNIV="http://ports.ubuntu.com/ubuntu-ports/pool/universe/libn/libnfs"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
cd "$work"
curl -fsSL -o libnfs14.deb "$P_MAIN/libnfs14_${VER}_arm64.deb"
curl -fsSL -o libnfs-utils.deb "$P_UNIV/libnfs-utils_${VER}_arm64.deb"
mkdir -p stage; dpkg-deb -x libnfs14.deb stage; dpkg-deb -x libnfs-utils.deb stage

mkdir -p overlay/opt/rivet-shared/bin overlay/opt/rivet-shared/lib overlay/usr/local/bin
cp stage/usr/bin/nfs-ls stage/usr/bin/nfs-cat stage/usr/bin/nfs-cp stage/usr/bin/nfs-stat overlay/opt/rivet-shared/bin/
cp stage/usr/lib/aarch64-linux-gnu/libnfs.so.14.0.0 overlay/opt/rivet-shared/lib/
ln -sf libnfs.so.14.0.0 overlay/opt/rivet-shared/lib/libnfs.so.14
cp "$HERE/bin/rivet-shared" overlay/opt/rivet-shared/bin/rivet-shared
chmod +x overlay/opt/rivet-shared/bin/*
ln -sf /opt/rivet-shared/bin/rivet-shared overlay/usr/local/bin/rivet-shared

tar -czf "$OUT" -C overlay .
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
tar -tvzf "$OUT" | sort -k1
