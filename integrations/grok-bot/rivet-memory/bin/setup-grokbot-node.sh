#!/usr/bin/env bash
# setup-grokbot-node — unified setup and restore for the Grok Bot capture node
#
# Safe to run on first join and after a computer-update wipe (home or settings gone).
# Idempotent: only brings back what's missing.
#
# Order:
#   1. Share mounted (fail loud if not)
#   2. Restore sealed home bits if missing (env, mesh identity, capture scripts, hooks)
#   3. Plugin present from snapshot or checkout
#   4. Capture watcher scheduler (door 1)
#   5. Grok Build hook wired (door 2, if Grok Build is installed)
#   6. Mesh membership check
#   7. Prove both doors with known sessions
#   8. Write fresh share snapshot
#
# Never prints secrets, PG URLs, tokens, or certs to stdout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
HOME_RIVETOS="${HOME}/.rivetos"
SHARE_ROOT="${GROKBOT_SHARE_ROOT:-}"

usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Unified setup and restore for Grok Bot capture node. Safe to re-run.

Options:
  --share PATH       Override GROKBOT_SHARE_ROOT
  --skip-prove       Skip door-proving step
  --help             Show this help

Environment:
  GROKBOT_SHARE_ROOT     Path to mounted share (required)
  GROKBOT_TRANSCRIPT_ROOT Path to transcript directory
  RIVETOS_ROOT           RivetOS checkout (default: /opt/rivetos)

Examples:
  # First join
  GROKBOT_SHARE_ROOT=/mnt/share ./setup-grokbot-node.sh

  # After wipe, restore from share
  GROKBOT_SHARE_ROOT=/mnt/share ./setup-grokbot-node.sh
EOF
}

SKIP_PROVE=0
while [[ $# -gt 0 ]]; do
    case $1 in
        --share)
            SHARE_ROOT="$2"
            shift 2
            ;;
        --skip-prove)
            SKIP_PROVE=1
            shift
            ;;
        --help)
            usage
            exit 0
            ;;
        *)
            echo "ERROR: Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

echo "=== Grok Bot Node Setup/Restore ==="
echo

# ---------------------------------------------------------------------------
# 1. Share mounted
# ---------------------------------------------------------------------------
echo "[1/8] Checking share mount..."
if [[ -z "${SHARE_ROOT}" ]]; then
    echo "ERROR: GROKBOT_SHARE_ROOT not set" >&2
    echo "The share must be mounted before running setup." >&2
    echo "Set GROKBOT_SHARE_ROOT to the mount point (e.g. /mnt/share)" >&2
    exit 1
fi

if [[ ! -d "${SHARE_ROOT}" ]]; then
    echo "ERROR: Share not found at ${SHARE_ROOT}" >&2
    echo "Mount the share first, then re-run setup." >&2
    exit 1
fi

echo "  Share OK: ${SHARE_ROOT}"

# ---------------------------------------------------------------------------
# 2. Restore sealed home bits if missing
# ---------------------------------------------------------------------------
echo
echo "[2/8] Restoring home bits..."
mkdir -p "${HOME_RIVETOS}"

# .env (DB credentials, never printed)
ENV_FILE="${HOME_RIVETOS}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
    echo "  Checking for .env in share snapshot..."
    SHARE_SNAPSHOT="${SHARE_ROOT}/snapshot/home/.rivetos/.env"
    if [[ -f "${SHARE_SNAPSHOT}" ]]; then
        cp "${SHARE_SNAPSHOT}" "${ENV_FILE}"
        chmod 600 "${ENV_FILE}"
        echo "  Restored .env from share snapshot"
    else
        echo "  WARN: No .env found in share snapshot" >&2
        echo "  Create ${ENV_FILE} with RIVETOS_PG_URL and other credentials" >&2
    fi
else
    echo "  .env already present"
fi

# Mesh identity (certs, roster) — placeholder for when mesh is active
MESH_DIR="${HOME_RIVETOS}/mesh"
if [[ ! -d "${MESH_DIR}" ]]; then
    SHARE_MESH="${SHARE_ROOT}/snapshot/home/.rivetos/mesh"
    if [[ -d "${SHARE_MESH}" ]]; then
        cp -r "${SHARE_MESH}" "${MESH_DIR}"
        echo "  Restored mesh identity from share"
    else
        echo "  No mesh identity to restore (mesh not yet active)"
    fi
else
    echo "  Mesh identity already present"
fi

# ---------------------------------------------------------------------------
# 3. Plugin present
# ---------------------------------------------------------------------------
echo
echo "[3/8] Checking plugin..."
PLUGIN_JSON="${PLUGIN_ROOT}/plugin.json"
if [[ ! -f "${PLUGIN_JSON}" ]]; then
    echo "ERROR: Plugin not found at ${PLUGIN_ROOT}" >&2
    echo "This script must run from the plugin's bin/ directory" >&2
    exit 1
fi
PLUGIN_NAME=$(jq -r '.name' "${PLUGIN_JSON}")
PLUGIN_VERSION=$(jq -r '.version' "${PLUGIN_JSON}")
echo "  Plugin OK: ${PLUGIN_NAME} ${PLUGIN_VERSION}"

# ---------------------------------------------------------------------------
# 4. Capture watcher scheduler (door 1)
# ---------------------------------------------------------------------------
echo
echo "[4/8] Setting up capture watcher (door 1)..."
CAPTURE_RUNNER="${PLUGIN_ROOT}/capture/run-once.sh"
if [[ ! -f "${CAPTURE_RUNNER}" ]]; then
    echo "ERROR: Capture runner not found at ${CAPTURE_RUNNER}" >&2
    exit 1
fi

# Check if systemd timer exists
TIMER_NAME="rivetos-grokbot-capture.timer"
TIMER_PATH="/etc/systemd/system/${TIMER_NAME}"
if systemctl list-unit-files "${TIMER_NAME}" &>/dev/null; then
    echo "  Watcher timer already installed: ${TIMER_NAME}"
    if systemctl is-enabled "${TIMER_NAME}" &>/dev/null; then
        echo "  Timer is enabled"
    else
        echo "  WARN: Timer exists but is not enabled" >&2
        echo "  Run: sudo systemctl enable --now ${TIMER_NAME}" >&2
    fi
else
    echo "  No systemd timer found"
    echo "  To schedule hourly runs, create ${TIMER_PATH}:"
    echo
    cat <<'EOF'
[Unit]
Description=Grok Bot capture watcher
After=network-online.target

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
EOF
    echo
    echo "  And the service at /etc/systemd/system/rivetos-grokbot-capture.service:"
    echo
    cat <<EOF
[Unit]
Description=Grok Bot transcript capture
After=network-online.target

[Service]
Type=oneshot
User=$(whoami)
Environment="RIVETOS_ROOT=${RIVETOS_ROOT}"
Environment="GROKBOT_TRANSCRIPT_ROOT=${GROKBOT_TRANSCRIPT_ROOT:-}"
ExecStart=${CAPTURE_RUNNER}
StandardOutput=journal
StandardError=journal
EOF
    echo
fi

# ---------------------------------------------------------------------------
# 5. Grok Build hook (door 2)
# ---------------------------------------------------------------------------
echo
echo "[5/8] Checking Grok Build hook (door 2)..."
GROK_HOME="${HOME}/.grok"
HOOK_SCRIPT="${RIVETOS_ROOT}/integrations/grok/rivet-memory/bin/grok-memory-hook.sh"

if [[ -d "${GROK_HOME}" ]]; then
    echo "  Grok Build home found"
    if [[ -f "${HOOK_SCRIPT}" ]]; then
        echo "  Hook script present at ${HOOK_SCRIPT}"
        echo "  Configure Grok Build to call this hook on session events"
        echo "  (Grok Build hook config is outside this script's scope)"
    else
        echo "  WARN: Hook script not found at ${HOOK_SCRIPT}" >&2
        echo "  Build the grok-memory capture package or check RIVETOS_ROOT" >&2
    fi
else
    echo "  Grok Build not installed (door 2 N/A)"
fi

# ---------------------------------------------------------------------------
# 6. Mesh membership check
# ---------------------------------------------------------------------------
echo
echo "[6/8] Checking mesh membership..."
if [[ -f "${MESH_DIR}/node.crt" ]] && [[ -f "${MESH_DIR}/roster.json" ]]; then
    NODE_CN=$(openssl x509 -in "${MESH_DIR}/node.crt" -noout -subject 2>/dev/null | sed 's/.*CN = //' || echo "unknown")
    echo "  Node cert present (CN=${NODE_CN})"
    
    ROSTER_MODELS=$(jq -r '.models // [] | length' "${MESH_DIR}/roster.json" 2>/dev/null || echo "?")
    echo "  Roster present (${ROSTER_MODELS} models)"
    
    # Verify this node is in roster
    if jq -e ".models[] | select(.node == \"${NODE_CN}\")" "${MESH_DIR}/roster.json" &>/dev/null; then
        echo "  This node is in roster"
    else
        echo "  WARN: This node (${NODE_CN}) not found in roster" >&2
    fi
else
    echo "  Mesh not configured (certs/roster missing)"
    echo "  Mesh membership is optional for capture"
fi

# ---------------------------------------------------------------------------
# 7. Prove both doors
# ---------------------------------------------------------------------------
if [[ ${SKIP_PROVE} -eq 1 ]]; then
    echo
    echo "[7/8] Skipping door proof (--skip-prove)"
else
    echo
    echo "[7/8] Proving doors..."
    
    # Door 1: Run capture once with existing transcripts
    if [[ -n "${GROKBOT_TRANSCRIPT_ROOT:-}" ]] && [[ -d "${GROKBOT_TRANSCRIPT_ROOT}" ]]; then
        echo "  Door 1: Running capture once..."
        if "${CAPTURE_RUNNER}" 2>&1 | tail -5; then
            echo "  Door 1 proved OK"
        else
            DOOR1_RC=$?
            echo "  Door 1 FAILED (exit ${DOOR1_RC})" >&2
            echo "  Check logs and fix before continuing" >&2
            exit 1
        fi
    else
        echo "  Door 1: Cannot prove (GROKBOT_TRANSCRIPT_ROOT not set or not found)"
        echo "  Set GROKBOT_TRANSCRIPT_ROOT and re-run with at least one transcript present"
    fi
    
    # Door 2: Check hook health (if Grok Build is installed)
    if [[ -d "${GROK_HOME}" ]] && [[ -f "${HOOK_SCRIPT}" ]]; then
        HOOK_CAPTURE="${RIVETOS_ROOT}/integrations/grok/rivet-memory/capture/dist/grok-memory-capture.js"
        if [[ -f "${HOOK_CAPTURE}" ]]; then
            echo "  Door 2: Checking hook health..."
            if node "${HOOK_CAPTURE}" --health 2>&1 | tail -3; then
                echo "  Door 2 proved OK"
            else
                echo "  Door 2 health check failed" >&2
                echo "  Some Grok Build sessions may be stuck" >&2
            fi
        else
            echo "  Door 2: Capture not built, skipping health check"
            echo "  Build with: cd ${RIVETOS_ROOT}/integrations/grok/rivet-memory/capture && npm run build"
        fi
    else
        echo "  Door 2: N/A (Grok Build not installed)"
    fi
fi

# ---------------------------------------------------------------------------
# 8. Write fresh share snapshot
# ---------------------------------------------------------------------------
echo
echo "[8/8] Writing share snapshot..."
SNAPSHOT_DIR="${SHARE_ROOT}/snapshot/home/.rivetos"
mkdir -p "${SNAPSHOT_DIR}"

if [[ -f "${ENV_FILE}" ]]; then
    cp "${ENV_FILE}" "${SNAPSHOT_DIR}/.env"
    echo "  Snapshotted .env"
fi

if [[ -d "${MESH_DIR}" ]]; then
    rm -rf "${SNAPSHOT_DIR}/mesh"
    cp -r "${MESH_DIR}" "${SNAPSHOT_DIR}/mesh"
    echo "  Snapshotted mesh identity"
fi

# Snapshot capture state for recovery
CAPTURE_STATE_DIR="${HOME_RIVETOS}/grokbot-capture-state"
if [[ -d "${CAPTURE_STATE_DIR}" ]]; then
    SNAPSHOT_STATE="${SHARE_ROOT}/snapshot/home/.rivetos/grokbot-capture-state"
    mkdir -p "${SNAPSHOT_STATE}"
    cp -r "${CAPTURE_STATE_DIR}"/* "${SNAPSHOT_STATE}/" 2>/dev/null || true
    echo "  Snapshotted capture state"
fi

echo
echo "=== Setup Complete ==="
echo
echo "Summary:"
echo "  Plugin: ${PLUGIN_NAME} ${PLUGIN_VERSION}"
echo "  Door 1 (watcher): ${CAPTURE_RUNNER}"
echo "  Door 2 (hook): ${HOOK_SCRIPT}"
echo "  Share snapshot: ${SHARE_ROOT}/snapshot/"
echo
echo "Next steps:"
echo "  1. Ensure GROKBOT_TRANSCRIPT_ROOT is set in environment"
echo "  2. Schedule capture watcher (see door 1 notes above)"
echo "  3. Configure Grok Build hooks if applicable"
echo "  4. Monitor capture logs and state"
echo
