#!/bin/bash
# Install device-control skill into user skill dirs (Grok + Claude).
# Idempotent; run from RivetRuntime after rivet-phone-overlay extract (same style as register-memory.sh).
set -eu
HOME="${HOME:-/home/rivet}"
SRC=/opt/rivet-phone/skills/device-control
install -d "$HOME/.grok/skills/device-control" "$HOME/.claude/skills/device-control"
# Prefer symlink so one copy under /opt stays canonical; fall back to cp -a
ln -sfn "$SRC/SKILL.md" "$HOME/.grok/skills/device-control/SKILL.md" \
  || cp -af "$SRC/SKILL.md" "$HOME/.grok/skills/device-control/SKILL.md"
ln -sfn "$SRC/SKILL.md" "$HOME/.claude/skills/device-control/SKILL.md" \
  || cp -af "$SRC/SKILL.md" "$HOME/.claude/skills/device-control/SKILL.md"
# PATH already has /usr/local/bin/phone via overlay symlink
echo "rivet-phone registered (skills → ~/.grok/skills + ~/.claude/skills)"
