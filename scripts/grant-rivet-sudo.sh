#!/usr/bin/env bash
# grant-rivet-sudo.sh — give rivet user passwordless sudo + fix PrivateTmp on units
# Run as root on each node (CT110, CT111, desktop, etc.)
#
# Idempotent: safe to re-run.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (try: sudo $0)" >&2
  exit 1
fi

# 1. Sudoers drop-in
SUDOERS=/etc/sudoers.d/rivet
echo 'rivet ALL=(ALL) NOPASSWD: ALL' > "$SUDOERS"
chmod 0440 "$SUDOERS"
chown root:root "$SUDOERS"
visudo -c -f "$SUDOERS"
echo "✓ $SUDOERS installed"

# 2. Patch systemd units that have PrivateTmp so sudo's /run/sudo works
UNITS=(rivetos.service rivet-embedder.service rivet-compactor.service)
CHANGED=0

for unit in "${UNITS[@]}"; do
  unit_path="/etc/systemd/system/$unit"
  [[ -f "$unit_path" ]] || continue

  # Already patched?
  if grep -q '^ReadWritePaths=.*\b/run/sudo\b' "$unit_path"; then
    echo "✓ $unit already has ReadWritePaths=/run/sudo"
    continue
  fi

  # Only relevant if PrivateTmp or ProtectSystem is on
  if ! grep -qE '^(PrivateTmp|ProtectSystem)=' "$unit_path"; then
    echo "✓ $unit has no PrivateTmp/ProtectSystem — skipping"
    continue
  fi

  # Insert ReadWritePaths under [Service]
  cp -a "$unit_path" "${unit_path}.bak.$(date +%s)"
  awk '
    BEGIN { added = 0 }
    /^\[Service\]/ && !added { print; print "ReadWritePaths=/run/sudo"; added = 1; next }
    { print }
  ' "$unit_path" > "${unit_path}.new"
  mv "${unit_path}.new" "$unit_path"
  echo "✓ patched $unit"
  CHANGED=1
done

if [[ $CHANGED -eq 1 ]]; then
  systemctl daemon-reload
  for unit in "${UNITS[@]}"; do
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      echo "→ restarting $unit"
      systemctl restart "$unit"
    fi
  done
fi

echo
echo "Done. Verifying:"
sudo -u rivet -n true && echo "✓ rivet has passwordless sudo" || echo "✗ rivet sudo check failed"
