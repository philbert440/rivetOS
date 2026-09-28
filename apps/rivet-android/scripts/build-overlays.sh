#!/usr/bin/env bash
# Build RivetHub overlay tarballs into app/src/main/assets/.
# These archives are gitignored — generate them at app build time, never commit.
#
# Always available (offline):
#   phone   — overlay-src/rivet-phone/build-overlay.sh
#
# Optional (need network or prior monorepo builds):
#   shared, net-tools — overlay-src/*/build-overlay.sh (fetch Ubuntu arm64 debs)
#   memory            — MEMORY_PLUGIN_STASH=<dir> plus overlay-src/rivet-memory hooks
#   den               — DEN_BUNDLE=<esbuild bundle> (home/rivet/rivet-den/den-server.bundle.mjs)
#   web               — WEB_DIST=<rivethub-web dist dir>
#
# Usage:
#   scripts/build-overlays.sh              # phone only
#   scripts/build-overlays.sh --all        # phone + whatever optional inputs exist
#   BUILD_NETWORK_OVERLAYS=1 scripts/build-overlays.sh --all
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
ASSETS="$APP/app/src/main/assets"
SRC="$APP/overlay-src"
mkdir -p "$ASSETS"

build_phone() {
  bash "$SRC/rivet-phone/build-overlay.sh"
}

build_shared() {
  bash "$SRC/rivet-shared/build-overlay.sh"
}

build_net_tools() {
  bash "$SRC/net-tools/build-overlay.sh"
}

build_memory() {
  local stash="${MEMORY_PLUGIN_STASH:-}"
  if [[ -z "$stash" || ! -d "$stash" ]]; then
    echo "skip memory overlay (set MEMORY_PLUGIN_STASH to the plugin tree)" >&2
    return 0
  fi
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  mkdir -p "$work/overlay"
  cp -a "$stash/." "$work/overlay/"
  if [[ -f "$SRC/rivet-memory/rivet-memory-offline.sh" ]]; then
    cp "$SRC/rivet-memory/rivet-memory-offline.sh" "$work/overlay/opt/rivet-memory-offline.sh"
  fi
  if [[ -f "$SRC/rivet-memory/claude/rivet-memory-hook.sh" ]]; then
    mkdir -p "$work/overlay/opt/rivet-memory/bin"
    cp "$SRC/rivet-memory/claude/rivet-memory-hook.sh" \
      "$work/overlay/opt/rivet-memory/bin/rivet-memory-hook.sh"
  fi
  if [[ -f "$SRC/rivet-memory/grok/grok-memory-hook.sh" ]]; then
    mkdir -p "$work/overlay/opt/rivet-memory-grok/bin"
    cp "$SRC/rivet-memory/grok/grok-memory-hook.sh" \
      "$work/overlay/opt/rivet-memory-grok/bin/grok-memory-hook.sh"
  fi
  tar -czf "$ASSETS/rivet-memory-overlay.bin" -C "$work/overlay" .
  echo "built $ASSETS/rivet-memory-overlay.bin"
}

build_den() {
  local bundle="${DEN_BUNDLE:-}"
  if [[ -z "$bundle" || ! -f "$bundle" ]]; then
    echo "skip den overlay (set DEN_BUNDLE to den-server.bundle.mjs)" >&2
    return 0
  fi
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  mkdir -p "$work/home/rivet/rivet-den"
  cp "$bundle" "$work/home/rivet/rivet-den/den-server.bundle.mjs"
  tar -czf "$ASSETS/rivet-den-overlay.bin" -C "$work" home
  echo "built $ASSETS/rivet-den-overlay.bin"
}

build_web() {
  local dist="${WEB_DIST:-}"
  if [[ -z "$dist" || ! -d "$dist" ]]; then
    echo "skip web overlay (set WEB_DIST to rivethub-web dist/)" >&2
    return 0
  fi
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  mkdir -p "$work/home/rivet/rivethub-web"
  cp -a "$dist" "$work/home/rivet/rivethub-web/dist"
  tar -czf "$ASSETS/rivet-web-overlay.bin" -C "$work" home
  echo "built $ASSETS/rivet-web-overlay.bin"
}

ALL=0
if [[ "${1:-}" == "--all" ]]; then ALL=1; fi

build_phone
if [[ "$ALL" -eq 1 ]]; then
  if [[ "${BUILD_NETWORK_OVERLAYS:-}" == "1" ]]; then
    build_shared
    build_net_tools
  else
    echo "skip shared/net-tools (set BUILD_NETWORK_OVERLAYS=1 to fetch debs)" >&2
  fi
  build_memory
  build_den
  build_web
fi
