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

TIMER_NAME="rivetos-grokbot-capture.timer"
SERVICE_NAME="rivetos-grokbot-capture.service"

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

# Exit 3 = setup did not finish restoring triggers. Never print "Setup Complete".
SETUP_INCOMPLETE=0
PG_URL=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

share_is_mounted() {
    local target="$1"
    local p cur root_dev dir_dev
    [[ -d "${target}" ]] || return 1
    p="$(cd "${target}" && pwd -P)"

    if command -v mountpoint >/dev/null 2>&1; then
        cur="${p}"
        while [[ -n "${cur}" && "${cur}" != "/" ]]; do
            if mountpoint -q "${cur}"; then
                return 0
            fi
            cur="$(dirname -- "${cur}")"
        done
        return 1
    fi

    # Fallback when mountpoint(1) is absent: the path must live on a
    # different device than / (a leftover empty mount-point dir does not).
    root_dev="$(stat -c '%d' /)"
    dir_dev="$(stat -c '%d' "${p}")"
    [[ "${dir_dev}" != "${root_dev}" ]]
}

mesh_identity_complete() {
    local dir="$1"
    [[ -d "${dir}" ]] && [[ -f "${dir}/node.crt" ]] && [[ -f "${dir}/roster.json" ]]
}

restore_mesh_identity() {
    local mesh_dir="$1"
    local share_mesh="$2"
    local share_mesh_prev="$3"
    local src="" staging previous parent

    if mesh_identity_complete "${mesh_dir}"; then
        echo "  Mesh identity already present"
        return 0
    fi

    if mesh_identity_complete "${share_mesh}"; then
        src="${share_mesh}"
    elif mesh_identity_complete "${share_mesh_prev}"; then
        src="${share_mesh_prev}"
    fi

    if [[ -z "${src}" ]]; then
        if [[ -d "${mesh_dir}" ]]; then
            echo "  WARN: Local mesh identity incomplete and no complete share copy to repair from" >&2
        else
            echo "  No mesh identity to restore (mesh not yet active)"
        fi
        return 0
    fi

    parent="$(dirname -- "${mesh_dir}")"
    mkdir -p "${parent}"
    staging="${mesh_dir}.staging.$$"
    previous="${mesh_dir}.prev.$$"
    rm -rf "${staging}"
    cp -r "${src}" "${staging}"
    if ! mesh_identity_complete "${staging}"; then
        rm -rf "${staging}"
        echo "ERROR: Staged mesh restore is incomplete; share copy retained" >&2
        return 1
    fi
    if [[ -d "${mesh_dir}" ]]; then
        rm -rf "${previous}"
        mv "${mesh_dir}" "${previous}"
    fi
    if ! mv "${staging}" "${mesh_dir}"; then
        if [[ -d "${previous}" && ! -d "${mesh_dir}" ]]; then
            mv "${previous}" "${mesh_dir}"
        fi
        rm -rf "${staging}"
        echo "ERROR: Failed to restore mesh identity from share" >&2
        return 1
    fi
    if ! mesh_identity_complete "${mesh_dir}"; then
        rm -rf "${mesh_dir}"
        if [[ -d "${previous}" ]]; then
            mv "${previous}" "${mesh_dir}"
        fi
        echo "ERROR: Restored mesh identity is incomplete; share copy retained" >&2
        return 1
    fi
    rm -rf "${previous}"
    echo "  Restored mesh identity from share"
    return 0
}

write_capture_unit_files() {
    local dir="$1"
    local scope="${2:-user}"
    local user_line=""
    mkdir -p "${dir}"
    if [[ "${scope}" == "system" ]]; then
        user_line="User=$(whoami)"
    fi
    cat > "${dir}/${SERVICE_NAME}" <<EOF
[Unit]
Description=Grok Bot transcript capture
After=network-online.target

[Service]
Type=oneshot
${user_line}
Environment="RIVETOS_ROOT=${RIVETOS_ROOT}"
Environment="GROKBOT_TRANSCRIPT_ROOT=${GROKBOT_TRANSCRIPT_ROOT:-}"
ExecStart=${CAPTURE_RUNNER}
StandardOutput=journal
StandardError=journal
EOF
    cat > "${dir}/${TIMER_NAME}" <<EOF
[Unit]
Description=Grok Bot capture watcher

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

install_capture_watcher() {
    if systemctl --user is-active --quiet "${TIMER_NAME}" 2>/dev/null; then
        echo "  Watcher timer ACTIVE (user): ${TIMER_NAME}"
        return 0
    fi
    if systemctl is-active --quiet "${TIMER_NAME}" 2>/dev/null; then
        echo "  Watcher timer ACTIVE (system): ${TIMER_NAME}"
        return 0
    fi

    local user_dir="${HOME}/.config/systemd/user"
    write_capture_unit_files "${user_dir}" "user"
    if systemctl --user daemon-reload >/dev/null 2>&1 \
        && systemctl --user enable --now "${TIMER_NAME}" >/dev/null 2>&1 \
        && systemctl --user is-active --quiet "${TIMER_NAME}"; then
        echo "  Installed and ACTIVE (user): ${TIMER_NAME}"
        return 0
    fi

    if sudo -n true >/dev/null 2>&1; then
        local tmp
        tmp="$(mktemp -d)"
        write_capture_unit_files "${tmp}" "system"
        if sudo -n cp "${tmp}/${SERVICE_NAME}" "${tmp}/${TIMER_NAME}" /etc/systemd/system/ \
            && sudo -n systemctl daemon-reload \
            && sudo -n systemctl enable --now "${TIMER_NAME}" \
            && systemctl is-active --quiet "${TIMER_NAME}"; then
            rm -rf "${tmp}"
            echo "  Installed and ACTIVE (system): ${TIMER_NAME}"
            return 0
        fi
        rm -rf "${tmp}"
    fi

    echo "ERROR: Capture watcher timer is not ACTIVE" >&2
    echo "Could not install/start ${TIMER_NAME} as a user or system unit." >&2
    echo "Enable lingering / fix systemd --user, or install the units, then re-run." >&2
    return 1
}

restore_grok_hooks() {
    local grok_home="$1"
    local hook_script="$2"
    if [[ ! -d "${grok_home}" ]]; then
        echo "  Grok Build not installed (door 2 N/A)"
        return 0
    fi
    local hook_src="${RIVETOS_ROOT}/integrations/grok/rivet-memory/hooks/hooks.json"
    if [[ ! -f "${hook_script}" ]]; then
        echo "ERROR: Hook script not found at ${hook_script}" >&2
        echo "Build the grok-memory capture package or check RIVETOS_ROOT" >&2
        return 1
    fi
    if [[ ! -f "${hook_src}" ]]; then
        echo "ERROR: Hook config not found at ${hook_src}" >&2
        return 1
    fi
    mkdir -p "${grok_home}/hooks"
    local dest="${grok_home}/hooks/rivet-memory.json"
    cp "${hook_src}" "${dest}"
    if [[ ! -f "${dest}" ]] || ! grep -q 'grok-memory-hook.sh' "${dest}"; then
        echo "ERROR: Failed to restore Grok hook config at ${dest}" >&2
        return 1
    fi
    echo "  Restored hook config: ${dest}"
    echo "  Hook script: ${hook_script}"
    return 0
}

load_pg_url() {
    PG_URL="${RIVETOS_PG_URL:-}"
    if [[ -n "${PG_URL}" ]]; then
        return 0
    fi
    local envf="${RIVETOS_ENV_FILE:-${HOME_RIVETOS}/.env}"
    [[ -f "${envf}" ]] || return 1
    local line val
    while IFS= read -r line || [[ -n "${line}" ]]; do
        if [[ "${line}" =~ ^[[:space:]]*RIVETOS_PG_URL[[:space:]]*=[[:space:]]*(.*)$ ]]; then
            val="${BASH_REMATCH[1]}"
            val="${val#"${val%%[![:space:]]*}"}"
            val="${val%"${val##*[![:space:]]}"}"
            if [[ "${#val}" -ge 2 ]]; then
                if [[ "${val}" == \"*\" || "${val}" == \'*\' ]]; then
                    val="${val:1:${#val}-2}"
                fi
            fi
            PG_URL="${val}"
            [[ -n "${PG_URL}" ]]
            return
        fi
    done < "${envf}"
    return 1
}

ingest_packages_ok() {
    [[ -d "${RIVETOS_ROOT}/node_modules/@rivetos/memory-postgres" ]] \
        && [[ -f "${RIVETOS_ROOT}/services/mcp-sidecar/dist/memory-write.js" ]]
}

# Returns 0 if a conversation row exists for session_key+agent.
# 1 = queried OK but no row; 2 = could not query (unavailable).
prove_stored_row() {
    local session_key="$1"
    local agent="$2"
    if [[ -z "${PG_URL}" ]]; then
        return 2
    fi
    local node_script rc
    # CommonJS so NODE_PATH is honored (ESM import does not search NODE_PATH).
    node_script='const { Pool } = require("pg");
const url = process.env.RIVETOS_PG_URL;
const sessionKey = process.env.PROOF_SESSION_KEY;
const agent = process.env.PROOF_AGENT;
if (!url || !sessionKey || !agent) process.exit(2);
const pool = new Pool({ connectionString: url, max: 1 });
pool.query(
  "SELECT id FROM ros_conversations WHERE session_key = $1 AND agent = $2 LIMIT 1",
  [sessionKey, agent],
).then(async (r) => {
  await pool.end().catch(() => {});
  process.exit(r.rows.length > 0 ? 0 : 1);
}).catch(async () => {
  await pool.end().catch(() => {});
  process.exit(2);
});'
    rc=0
    NODE_PATH="${RIVETOS_ROOT}/node_modules:${RIVETOS_ROOT}/integrations/grok/rivet-memory/capture/node_modules${NODE_PATH:+:${NODE_PATH}}" \
        RIVETOS_PG_URL="${PG_URL}" \
        PROOF_SESSION_KEY="${session_key}" \
        PROOF_AGENT="${agent}" \
        node --input-type=commonjs -e "${node_script}" || rc=$?
    return "${rc}"
}

prove_door1() {
    if [[ -z "${GROKBOT_TRANSCRIPT_ROOT:-}" || ! -d "${GROKBOT_TRANSCRIPT_ROOT}" ]]; then
        echo "ERROR: Door 1 proof unavailable: GROKBOT_TRANSCRIPT_ROOT not set or not found" >&2
        return 2
    fi
    if ! ingest_packages_ok; then
        echo "ERROR: Door 1 proof unavailable: ingest packages not built" >&2
        return 2
    fi
    if ! load_pg_url; then
        echo "ERROR: Door 1 proof unavailable: RIVETOS_PG_URL not set and not in ~/.rivetos/.env" >&2
        return 2
    fi

    echo "  Door 1: Running capture once..."
    if ! "${CAPTURE_RUNNER}"; then
        echo "ERROR: Door 1 capture run failed" >&2
        return 1
    fi

    local models_json="${PLUGIN_ROOT}/capture/models.json"
    local transcript_rel proved=0
    transcript_rel="$(jq -r '.transcriptRel' "${models_json}")"

    local model_json model_id session_id agent_id tpath pr
    while IFS= read -r model_json; do
        model_id="$(echo "${model_json}" | jq -r '.id')"
        session_id="$(echo "${model_json}" | jq -r '.sessionId')"
        agent_id="$(echo "${model_json}" | jq -r '.agentId')"
        tpath="${transcript_rel//<id>/${model_id}}"
        tpath="${tpath//\$GROKBOT_TRANSCRIPT_ROOT/${GROKBOT_TRANSCRIPT_ROOT}}"
        if [[ ! -f "${tpath}" ]]; then
            continue
        fi
        pr=0
        prove_stored_row "${session_id}" "${agent_id}" || pr=$?
        if [[ "${pr}" -eq 2 ]]; then
            echo "ERROR: Door 1 proof unavailable: could not query memory store" >&2
            return 2
        fi
        if [[ "${pr}" -ne 0 ]]; then
            echo "ERROR: Door 1 proof failed: no stored row for ${session_id} (${agent_id})" >&2
            return 1
        fi
        echo "  Door 1 stored row OK: ${session_id}"
        proved=1
    done < <(jq -c '.models[]' "${models_json}")

    if [[ "${proved}" -eq 0 ]]; then
        echo "ERROR: Door 1 proof unavailable: no transcripts found to prove" >&2
        return 2
    fi
    echo "  Door 1 proved OK"
    return 0
}

prove_door2() {
    local grok_home="$1"
    if [[ ! -d "${grok_home}" ]]; then
        echo "  Door 2: N/A (Grok Build not installed)"
        return 0
    fi

    local capture_js="${RIVETOS_ROOT}/integrations/grok/rivet-memory/capture/dist/grok-memory-capture.js"
    local capture_ts="${RIVETOS_ROOT}/integrations/grok/rivet-memory/capture/src/grok-memory-capture.ts"
    local -a capture_cmd
    if [[ -f "${capture_js}" ]]; then
        capture_cmd=(node "${capture_js}")
    elif [[ -f "${capture_ts}" ]]; then
        capture_cmd=(npx --yes tsx "${capture_ts}")
    else
        echo "ERROR: Door 2 proof unavailable: capture worker not present" >&2
        return 2
    fi
    if ! load_pg_url; then
        echo "ERROR: Door 2 proof unavailable: RIVETOS_PG_URL not set and not in ~/.rivetos/.env" >&2
        return 2
    fi

    local sid="" d
    shopt -s nullglob
    for d in "${grok_home}/sessions"/*/*/; do
        if [[ -f "${d}updates.jsonl" ]]; then
            sid="$(basename -- "${d%/}")"
            break
        fi
    done
    shopt -u nullglob
    if [[ -z "${sid}" ]]; then
        echo "ERROR: Door 2 proof unavailable: no Grok session transcript under ${grok_home}/sessions" >&2
        return 2
    fi

    local spool
    spool="$(mktemp "${TMPDIR:-/tmp}/rivetos-grok-prove.XXXXXX.json")"
    jq -n --arg sid "${sid}" '{kind:"ingest",sessionId:$sid,sourceEvent:"setup-prove"}' > "${spool}"
    if ! "${capture_cmd[@]}" --worker "${spool}"; then
        rm -f "${spool}"
        echo "ERROR: Door 2 ingest of session ${sid} failed" >&2
        return 1
    fi
    rm -f "${spool}"

    local session_key="grok-build:${sid}" pr=0
    prove_stored_row "${session_key}" "rivet-grok" || pr=$?
    if [[ "${pr}" -eq 2 ]]; then
        echo "ERROR: Door 2 proof unavailable: could not query memory store" >&2
        return 2
    fi
    if [[ "${pr}" -ne 0 ]]; then
        echo "ERROR: Door 2 proof failed: no stored row for ${session_key}" >&2
        return 1
    fi
    echo "  Door 2 proved OK (session ${sid})"
    return 0
}

snapshot_mesh_identity() {
    local mesh_dir="$1"
    local dest="$2"
    local staging previous

    if [[ ! -d "${mesh_dir}" ]]; then
        return 0
    fi
    if ! mesh_identity_complete "${mesh_dir}"; then
        echo "  WARN: Local mesh identity incomplete; not replacing share snapshot" >&2
        if mesh_identity_complete "${dest}"; then
            echo "  Previous complete snapshot retained"
        fi
        return 0
    fi

    staging="${dest}.staging.$$"
    previous="${dest}.prev"
    rm -rf "${staging}"
    mkdir -p "$(dirname -- "${dest}")"
    cp -r "${mesh_dir}" "${staging}"
    if ! mesh_identity_complete "${staging}"; then
        rm -rf "${staging}"
        echo "ERROR: Staged mesh snapshot incomplete; previous backup retained" >&2
        return 1
    fi

    if [[ -d "${dest}" ]]; then
        rm -rf "${previous}"
        mv "${dest}" "${previous}"
    fi
    if ! mv "${staging}" "${dest}"; then
        if [[ -d "${previous}" && ! -d "${dest}" ]]; then
            mv "${previous}" "${dest}"
        fi
        rm -rf "${staging}"
        echo "ERROR: Failed to publish mesh snapshot; previous backup retained" >&2
        return 1
    fi
    if ! mesh_identity_complete "${dest}"; then
        rm -rf "${dest}"
        if [[ -d "${previous}" ]]; then
            mv "${previous}" "${dest}"
        fi
        echo "ERROR: Published mesh snapshot failed verification; restored previous" >&2
        return 1
    fi
    rm -rf "${previous}"
    echo "  Snapshotted mesh identity"
    return 0
}

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

if ! share_is_mounted "${SHARE_ROOT}"; then
    echo "ERROR: ${SHARE_ROOT} is not a mountpoint (share is not mounted)" >&2
    echo "A leftover directory is not enough — mount the share, then re-run." >&2
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

MESH_DIR="${HOME_RIVETOS}/mesh"
SHARE_MESH="${SHARE_ROOT}/snapshot/home/.rivetos/mesh"
SHARE_MESH_PREV="${SHARE_ROOT}/snapshot/home/.rivetos/mesh.prev"
restore_mesh_identity "${MESH_DIR}" "${SHARE_MESH}" "${SHARE_MESH_PREV}"

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

if ! install_capture_watcher; then
    SETUP_INCOMPLETE=1
fi

# ---------------------------------------------------------------------------
# 5. Grok Build hook (door 2)
# ---------------------------------------------------------------------------
echo
echo "[5/8] Checking Grok Build hook (door 2)..."
GROK_HOME="${HOME}/.grok"
HOOK_SCRIPT="${RIVETOS_ROOT}/integrations/grok/rivet-memory/bin/grok-memory-hook.sh"

if ! restore_grok_hooks "${GROK_HOME}" "${HOOK_SCRIPT}"; then
    SETUP_INCOMPLETE=1
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

    door1_rc=0
    prove_door1 || door1_rc=$?
    if [[ "${door1_rc}" -ne 0 ]]; then
        echo "  Door 1 proof did not succeed (status ${door1_rc})" >&2
        echo "  Re-run after fixing ingest, or pass --skip-prove explicitly." >&2
        exit 1
    fi

    door2_rc=0
    prove_door2 "${GROK_HOME}" || door2_rc=$?
    if [[ "${door2_rc}" -ne 0 ]]; then
        echo "  Door 2 proof did not succeed (status ${door2_rc})" >&2
        echo "  Re-run after fixing ingest, or pass --skip-prove explicitly." >&2
        exit 1
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
    tmp_env="${SNAPSHOT_DIR}/.env.tmp.$$"
    cp "${ENV_FILE}" "${tmp_env}"
    chmod 600 "${tmp_env}"
    mv -f "${tmp_env}" "${SNAPSHOT_DIR}/.env"
    echo "  Snapshotted .env"
fi

snapshot_mesh_identity "${MESH_DIR}" "${SNAPSHOT_DIR}/mesh"

# Snapshot capture state for recovery
CAPTURE_STATE_DIR="${HOME_RIVETOS}/grokbot-capture-state"
if [[ -d "${CAPTURE_STATE_DIR}" ]]; then
    SNAPSHOT_STATE="${SHARE_ROOT}/snapshot/home/.rivetos/grokbot-capture-state"
    mkdir -p "${SNAPSHOT_STATE}"
    cp -r "${CAPTURE_STATE_DIR}"/* "${SNAPSHOT_STATE}/" 2>/dev/null || true
    echo "  Snapshotted capture state"
fi

echo
if [[ "${SETUP_INCOMPLETE}" -ne 0 ]]; then
    echo "=== Setup INCOMPLETE ==="
    echo
    echo "Triggers were not fully installed or are not ACTIVE."
    echo "Capture may not run until the watcher timer is ACTIVE"
    echo "and (if Grok Build is installed) hook config is restored."
    echo "Re-run this script after fixing systemd/hooks."
    echo
    exit 3
fi

echo "=== Setup Complete ==="
echo
echo "Summary:"
echo "  Plugin: ${PLUGIN_NAME} ${PLUGIN_VERSION}"
echo "  Door 1 (watcher): ${CAPTURE_RUNNER}"
echo "  Door 2 (hook): ${HOOK_SCRIPT}"
echo "  Share snapshot: ${SHARE_ROOT}/snapshot/"
echo
echo "Next steps:"
echo "  1. Ensure GROKBOT_TRANSCRIPT_ROOT is set in the watcher unit environment"
echo "  2. Monitor capture logs and state"
echo
