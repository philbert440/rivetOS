#!/bin/bash
# RivetHub wrapper — launches the AppImage with Wayland and session flags

# Omarchy already sets ELECTRON_OZONE_PLATFORM_HINT=wayland, but the hint is
# not enough (Slack stayed on XWayland until --ozone-platform=wayland was on
# the Exec line). Explicitly set both the env var and the flag.
export ELECTRON_OZONE_PLATFORM_HINT=wayland

exec /opt/rivethub/rivethub.AppImage --ozone-platform=wayland "$@"
