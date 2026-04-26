#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# setup-mesh-hosts.sh — write/refresh the RivetOS mesh /etc/hosts block
# ──────────────────────────────────────────────────────────────────────────────
#
# Reads a mesh.json (default: /rivet-shared/mesh.json) and rewrites the
# block between
#       # --- BEGIN RIVETOS MESH ---
#       # --- END RIVETOS MESH ---
# in /etc/hosts so that ctNNN.mesh / ctNNN entries resolve to the right IPs.
#
# Idempotent. Safe to run repeatedly. Used during provisioning and during
# `update --mesh` so /etc/hosts heals from drift on every deploy.
#
# Usage:
#   sudo ./setup-mesh-hosts.sh                            # default mesh file
#   sudo ./setup-mesh-hosts.sh /path/to/mesh.json
#   sudo ./setup-mesh-hosts.sh --hosts /etc/hosts.test    # custom hosts file
#
# Exit codes:
#   0  block written/updated (or already correct)
#   1  bad arguments / missing dependencies
#   2  mesh.json not found or unreadable
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BEGIN_MARKER="# --- BEGIN RIVETOS MESH ---"
END_MARKER="# --- END RIVETOS MESH ---"
MESH_FILE="/rivet-shared/mesh.json"
HOSTS_FILE="/etc/hosts"
QUIET=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --hosts) HOSTS_FILE="$2"; shift 2;;
        --quiet|-q) QUIET=true; shift;;
        -h|--help)
            sed -n '2,25p' "$0"
            exit 0
            ;;
        -*)
            echo "Unknown flag: $1" >&2
            exit 1
            ;;
        *)
            MESH_FILE="$1"; shift;;
    esac
done

log() { $QUIET || echo "[setup-mesh-hosts] $*"; }
err() { echo "[setup-mesh-hosts] ERROR: $*" >&2; }

if ! command -v python3 >/dev/null 2>&1; then
    err "python3 is required"
    exit 1
fi

if [[ ! -r "$MESH_FILE" ]]; then
    err "mesh file not readable: $MESH_FILE"
    exit 2
fi

# Build the block from mesh.json. Each node gets:
#   <ip> <name>.mesh <name>
# Sorted by name so the block is stable across runs.
BLOCK=$(python3 - "$MESH_FILE" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)

nodes = data.get('nodes', {})
# Support both Record-shaped and array-shaped mesh.json
if isinstance(nodes, list):
    items = [(n.get('name') or n.get('id'), n.get('host') or n.get('ip')) for n in nodes]
else:
    items = []
    for key, n in nodes.items():
        name = n.get('name') or key
        host = n.get('host') or n.get('ip')
        items.append((name, host))

# Filter out anything missing a name or IP and sort
items = sorted({(n, h) for n, h in items if n and h})

for name, host in items:
    print(f"{host} {name}.mesh {name}")
PY
)

if [[ -z "$BLOCK" ]]; then
    err "no mesh entries found in $MESH_FILE — refusing to write empty block"
    exit 2
fi

NEW_BLOCK="${BEGIN_MARKER}
${BLOCK}
${END_MARKER}"

# Read current hosts file (or empty if missing)
if [[ -f "$HOSTS_FILE" ]]; then
    CURRENT=$(cat "$HOSTS_FILE")
else
    CURRENT=""
fi

# Strip any existing block (between markers, inclusive) using awk
STRIPPED=$(awk -v b="$BEGIN_MARKER" -v e="$END_MARKER" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip   { print }
' <<<"$CURRENT")

# Trim trailing blank lines, then append our block
STRIPPED=$(printf '%s\n' "$STRIPPED" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
NEW_CONTENT="${STRIPPED}

${NEW_BLOCK}"

# Write atomically. Diff before to skip no-op writes.
if [[ "$CURRENT" == "$NEW_CONTENT" ]]; then
    log "no change — /etc/hosts mesh block already current"
    exit 0
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
printf '%s\n' "$NEW_CONTENT" > "$TMP"

# Preserve permissions
if [[ -f "$HOSTS_FILE" ]]; then
    chmod --reference="$HOSTS_FILE" "$TMP" 2>/dev/null || chmod 644 "$TMP"
else
    chmod 644 "$TMP"
fi

mv "$TMP" "$HOSTS_FILE"
trap - EXIT

# Count entries for the log
COUNT=$(grep -c '\.mesh ' <<<"$BLOCK" || true)
log "updated mesh block in $HOSTS_FILE ($COUNT entries)"
