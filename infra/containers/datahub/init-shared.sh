#!/bin/bash
set -e

# Ensure shared directory structure exists for inter-agent collaboration.
# These directories are the contract between agents:
#   plans/      — coordination plans, task assignments
#   docs/       — shared documentation, architecture notes
#   status/     — agent status files, health reports
#   whiteboard/ — free-form scratch space for agent communication

mkdir -p /shared/plans /shared/docs /shared/status /shared/whiteboard
chmod -R 777 /shared

echo "[RivetOS] Shared directory structure ready."
