# RivetHub Packaging for Omarchy

This directory contains packaging artifacts for first-class Omarchy support.

## Files

- **PKGBUILD**: Arch Linux package build script for pacman-installable RivetHub
- **rivethub-wrapper.sh**: Wrapper script that launches RivetHub with Wayland flags
- **rivethub.install**: Post-install/upgrade/remove hooks for desktop database updates
- **README.md**: This file

## Packaging Tiers

### 1. Installable (First-class Omarchy slot)

The PKGBUILD enables RivetHub to appear in Omarchy's **Install > AI** menu row,
alongside ChatGPT and Grok Bot. This requires:

- A pacman-installable package (via Omarchy package repo or AUR)
- A .desktop file with proper Wayland flags and StartupWMClass
- Hicolor icon set for launcher integration
- Session-compatible launch (via uwsm-app)

**Current status**: Packaging artifacts ready. To appear in Install > AI, the
package must be added to the Omarchy package repository (not just AUR).

### 2. Bundled Default

A .desktop file shipped as a default Omarchy launcher entry. **This PR does NOT
request bundling RivetHub as a default app.** That would require a separate
Omarchy tree change.

### 3. Documentation

The rivethub.io site documents the Omarchy setup path. Documentation alone does
not make RivetHub first-class — the Install menu entry requires a pacman package.

## Building the Package

From this directory:

```bash
makepkg -si
```

Or for a clean build:

```bash
makepkg -Ccsi
```

## Installing from AUR (future)

Once published to AUR:

```bash
yay -S rivethub
# or: paru -S rivethub
```

## Omarchy Package Repository

For first-class Install > AI status, this package needs to be added to the
Omarchy package repository. That requires a separate PR to the Omarchy install
scripts and menu configuration.

## Manual Installation (AppImage)

The AppImage can still be installed manually:

```bash
# Download from mesh
curl -LO https://mesh.rivetos.dev/builds/rivethub/rivethub-latest.AppImage
chmod +x rivethub-latest.AppImage

# Install to ~/.local/bin
mkdir -p ~/.local/bin
mv rivethub-latest.AppImage ~/.local/bin/rivethub

# The updater will install .desktop and icons on first run
./~/.local/bin/rivethub
```

## Notes

- The wrapper script sets `ELECTRON_OZONE_PLATFORM_HINT=wayland` and passes
  `--ozone-platform=wayland` to ensure native Wayland rendering
- StartupWMClass is set to `rivethub` to align launcher/window IDs on Hyprland
- The updater (`src/main/updater.ts`) installs .desktop and icons on AppImage
  updates, so a mesh swap doesn't break launcher integration
- Icon resizing should be done with ImageMagick or similar tools for production;
  the current hicolor set uses the 512x512 icon at all sizes as a placeholder
