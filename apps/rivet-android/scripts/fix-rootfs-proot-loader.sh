#!/usr/bin/env bash
# Flatten the dynamic linker path so proot can resolve node/bash INTERP.
#
# Ubuntu 24.04 usr-merge ships:
#   /lib -> usr/lib
#   /usr/lib/ld-linux-aarch64.so.1 -> aarch64-linux-gnu/ld-linux-aarch64.so.1
# Node/bash request INTERP /lib/ld-linux-aarch64.so.1. proot's guest interpreter
# resolution fails that double symlink with:
#   proot error: execve("/usr/local/bin/node"): No such file or directory
# even when readlink -f succeeds on the host.
#
# This script makes /lib a real directory and places a REAL copy of the loader at
# /lib/ld-linux-aarch64.so.1 (zero symlink hops for INTERP). Multiarch libs stay
# reachable via lib/aarch64-linux-gnu -> ../usr/lib/aarch64-linux-gnu.
#
# Usage:
#   fix-rootfs-proot-loader.sh /path/to/rootfs
#   fix-rootfs-proot-loader.sh /path/to/rivet-rootfs.bin   # repacks in place
set -euo pipefail

TARGET="${1:?usage: $0 <rootfs-dir|rivet-rootfs.bin>}"

fix_tree() {
  local R="$1"
  local REAL="$R/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1"
  if [[ ! -f "$REAL" ]]; then
    echo "error: missing real loader at $REAL" >&2
    exit 1
  fi
  chmod 755 "$REAL" 2>/dev/null || true

  # usr/lib/ld-linux → real file
  cp -a --remove-destination "$REAL" "$R/usr/lib/ld-linux-aarch64.so.1.new"
  mv -f "$R/usr/lib/ld-linux-aarch64.so.1.new" "$R/usr/lib/ld-linux-aarch64.so.1"
  chmod 755 "$R/usr/lib/ld-linux-aarch64.so.1"

  # /lib: real dir + real loader (INTERP path)
  if [[ -L "$R/lib" ]]; then
    rm -f "$R/lib"
  fi
  mkdir -p "$R/lib"
  cp -a --remove-destination "$REAL" "$R/lib/ld-linux-aarch64.so.1"
  chmod 755 "$R/lib/ld-linux-aarch64.so.1"
  if [[ ! -e "$R/lib/aarch64-linux-gnu" ]]; then
    ln -s ../usr/lib/aarch64-linux-gnu "$R/lib/aarch64-linux-gnu"
  fi

  # /lib64: same (some aarch64 ELFs; node uses /lib)
  if [[ -L "$R/lib64" ]]; then
    rm -f "$R/lib64"
  fi
  mkdir -p "$R/lib64"
  cp -a --remove-destination "$REAL" "$R/lib64/ld-linux-aarch64.so.1"
  chmod 755 "$R/lib64/ld-linux-aarch64.so.1"
  if [[ ! -e "$R/lib64/aarch64-linux-gnu" ]]; then
    ln -s ../usr/lib/aarch64-linux-gnu "$R/lib64/aarch64-linux-gnu"
  fi

  # Assertions
  [[ -d "$R/lib" && ! -L "$R/lib" ]]
  [[ -f "$R/lib/ld-linux-aarch64.so.1" && ! -L "$R/lib/ld-linux-aarch64.so.1" ]]
  [[ -f "$R/usr/lib/ld-linux-aarch64.so.1" && ! -L "$R/usr/lib/ld-linux-aarch64.so.1" ]]
  echo "fixed: $R/lib/ld-linux-aarch64.so.1 is a real file (zero-hop INTERP)"
}

if [[ -d "$TARGET" ]]; then
  fix_tree "$TARGET"
elif [[ -f "$TARGET" ]]; then
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  mkdir -p "$WORK/rootfs"
  tar -xzf "$TARGET" -C "$WORK/rootfs"
  fix_tree "$WORK/rootfs"
  # busybox-safe: expand hardlinks; keep intentional symlinks (bin/sbin, multiarch)
  tar --hard-dereference -czf "$WORK/out.bin" -C "$WORK/rootfs" .
  mv -f "$WORK/out.bin" "$TARGET"
  echo "repacked: $TARGET"
else
  echo "error: not a directory or file: $TARGET" >&2
  exit 1
fi
