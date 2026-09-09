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

# Remote/share filesystems that may host GROKBOT_SHARE_ROOT as a subdirectory.
# Local disk/tmpfs/overlay parents (e.g. /home on its own partition) do not
# qualify — those would restore/snapshot on the wrong device.
share_fstype_is_remote() {
    local fstype="$1"
    case "${fstype}" in
        nfs|nfs[0-9]|nfs4|nfs4.*|cifs|smb|smb[0-9]|smb3|smb3.*|9p|ceph|glusterfs|fuse|fuse.*)
            return 0
            ;;
    esac
    return 1
}

# Print "TARGET<TAB>SOURCE<TAB>FSTYPE" for the mount that contains $1.
# Fail closed if mount identity cannot be resolved.
containing_mount_for() {
    local path="$1"
    local target source fstype line
    if command -v findmnt >/dev/null 2>&1; then
        target="$(findmnt -n -o TARGET --target "${path}" 2>/dev/null)" || return 1
        source="$(findmnt -n -o SOURCE --target "${path}" 2>/dev/null)" || return 1
        fstype="$(findmnt -n -o FSTYPE --target "${path}" 2>/dev/null)" || return 1
        [[ -n "${target}" && -n "${fstype}" ]] || return 1
        printf '%s\t%s\t%s\n' "${target}" "${source}" "${fstype}"
        return 0
    fi
    [[ -r /proc/self/mounts ]] || return 1
    line="$(awk -v path="${path}" '
        function unesc(s) {
            gsub(/\\040/, " ", s)
            gsub(/\\011/, "\t", s)
            return s
        }
        {
            src = unesc($1)
            tgt = unesc($2)
            fs = $3
            if (tgt == path || index(path, tgt "/") == 1 || tgt == "/") {
                if (length(tgt) >= bestlen) {
                    bestlen = length(tgt)
                    bestsrc = src
                    besttgt = tgt
                    bestfs = fs
                }
            }
        }
        END {
            if (besttgt != "") printf "%s\t%s\t%s\n", besttgt, bestsrc, bestfs
        }
    ' /proc/self/mounts)" || return 1
    [[ -n "${line}" ]] || return 1
    printf '%s\n' "${line}"
}

share_is_mounted() {
    local target="$1"
    local p mnt_line mnt_target mnt_source mnt_fstype
    [[ -d "${target}" ]] || return 1
    p="$(cd "${target}" && pwd -P)" || return 1

    mnt_line="$(containing_mount_for "${p}")" || return 1
    IFS=$'\t' read -r mnt_target mnt_source mnt_fstype <<<"${mnt_line}"
    [[ -n "${mnt_target}" ]] || return 1

    # Policy: SHARE_ROOT itself is the mount (any fstype, including a local
    # disk dedicated as the recovery share), OR SHARE_ROOT is a subdirectory
    # of a remote/fuse share. A mounted ancestor that is just local storage
    # (e.g. /home on its own partition) does not qualify.
    if [[ "${mnt_target}" == "${p}" ]]; then
        return 0
    fi
    # Subdirectory of a mount: require a remote/fuse source, not a local parent.
    [[ -n "${mnt_source}" ]] || return 1
    share_fstype_is_remote "${mnt_fstype}"
}

mesh_cert_parseable() {
    local cert="$1"
    [[ -s "${cert}" ]] || return 1
    if command -v openssl >/dev/null 2>&1; then
        openssl x509 -in "${cert}" -noout >/dev/null 2>&1
    else
        grep -q -- "-----BEGIN CERTIFICATE-----" "${cert}" \
            && grep -q -- "-----END CERTIFICATE-----" "${cert}"
    fi
}

mesh_roster_parseable() {
    local roster="$1"
    [[ -s "${roster}" ]] || return 1
    jq -e 'type == "object"' "${roster}" >/dev/null 2>&1
}

mesh_identity_complete() {
    local dir="$1"
    [[ -d "${dir}" ]] || return 1
    mesh_cert_parseable "${dir}/node.crt" || return 1
    mesh_roster_parseable "${dir}/roster.json"
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

systemd_exec_start() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//%/%%}"
    printf '"%s"' "${s}"
}

write_capture_unit_files() {
    local dir="$1"
    local scope="${2:-user}"
    local user_line=""
    local env_file exec_start
    mkdir -p "${dir}"
    if [[ "${scope}" == "system" ]]; then
        user_line="User=$(whoami)"
    fi
    env_file="${RIVETOS_ENV_FILE:-${HOME_RIVETOS}/.env}"
    exec_start="$(systemd_exec_start "${CAPTURE_RUNNER}")"
    cat > "${dir}/${SERVICE_NAME}" <<EOF
[Unit]
Description=Grok Bot transcript capture
After=network-online.target

[Service]
Type=oneshot
${user_line}
Environment="RIVETOS_ROOT=${RIVETOS_ROOT}"
Environment="GROKBOT_TRANSCRIPT_ROOT=${GROKBOT_TRANSCRIPT_ROOT:-}"
Environment="RIVETOS_ENV_FILE=${env_file}"
ExecStart=${exec_start}
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

# Confirm the installed oneshot has the current runner, transcript root, and
# credential env — i.e. the scheduled environment, not just "a timer is active".
verify_scheduled_capture_unit() {
    local scope="$1"
    local show=""
    if [[ "${scope}" == "user" ]]; then
        systemctl --user is-enabled --quiet "${TIMER_NAME}" 2>/dev/null || return 1
        systemctl --user is-active --quiet "${TIMER_NAME}" 2>/dev/null || return 1
        show="$(systemctl --user show "${SERVICE_NAME}" -p ExecStart -p Environment --no-pager 2>/dev/null)" || return 1
    else
        systemctl is-enabled --quiet "${TIMER_NAME}" 2>/dev/null || return 1
        systemctl is-active --quiet "${TIMER_NAME}" 2>/dev/null || return 1
        show="$(systemctl show "${SERVICE_NAME}" -p ExecStart -p Environment --no-pager 2>/dev/null)" || return 1
    fi
    [[ -n "${show}" ]] || return 1
    echo "${show}" | grep -Fq "${CAPTURE_RUNNER}" || return 1
    if [[ -n "${GROKBOT_TRANSCRIPT_ROOT:-}" ]]; then
        echo "${show}" | grep -Fq "GROKBOT_TRANSCRIPT_ROOT=${GROKBOT_TRANSCRIPT_ROOT}" || return 1
    fi
    echo "${show}" | grep -Fq "RIVETOS_ENV_FILE=" || return 1
}

install_capture_watcher() {
    local user_dir="${HOME}/.config/systemd/user"
    write_capture_unit_files "${user_dir}" "user"
    if systemctl --user daemon-reload >/dev/null 2>&1 \
        && systemctl --user enable --now "${TIMER_NAME}" >/dev/null 2>&1 \
        && verify_scheduled_capture_unit "user"; then
        echo "  Installed/reconciled and ACTIVE (user): ${TIMER_NAME}"
        return 0
    fi

    if sudo -n true >/dev/null 2>&1; then
        local tmp
        tmp="$(mktemp -d)"
        write_capture_unit_files "${tmp}" "system"
        if sudo -n cp "${tmp}/${SERVICE_NAME}" "${tmp}/${TIMER_NAME}" /etc/systemd/system/ \
            && sudo -n systemctl daemon-reload \
            && sudo -n systemctl enable --now "${TIMER_NAME}" \
            && verify_scheduled_capture_unit "system"; then
            rm -rf "${tmp}"
            echo "  Installed/reconciled and ACTIVE (system): ${TIMER_NAME}"
            return 0
        fi
        rm -rf "${tmp}"
    fi

    echo "ERROR: Capture watcher timer is not ACTIVE with the current unit config" >&2
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
    local abs_hook dest tmp
    abs_hook="$(cd "$(dirname -- "${hook_script}")" && pwd -P)/$(basename -- "${hook_script}")"
    if [[ ! -f "${abs_hook}" ]]; then
        echo "ERROR: Hook script not found at ${abs_hook}" >&2
        return 1
    fi
    mkdir -p "${grok_home}/hooks"
    dest="${grok_home}/hooks/rivet-memory.json"
    tmp="${dest}.tmp.$$"
    # Rewrite template ${RIVETOS_ROOT:-/opt/rivetos}/... to the durable
    # absolute path so a later Grok process without that env still works.
    if ! jq --arg hook "${abs_hook}" '
        .hooks |= map_values(
          map(
            .hooks |= map(
              if .type == "command" and (.command | type == "string")
                 and (.command | test("grok-memory-hook\\.sh"))
              then .command = ($hook + " " + (.command | split(" ") | last))
              else . end
            )
          )
        )
      ' "${hook_src}" > "${tmp}"; then
        rm -f "${tmp}"
        echo "ERROR: Failed to rewrite Grok hook config with durable hook path" >&2
        return 1
    fi
    if ! mv -f "${tmp}" "${dest}"; then
        rm -f "${tmp}"
        echo "ERROR: Failed to restore Grok hook config at ${dest}" >&2
        return 1
    fi
    if [[ ! -f "${dest}" ]] \
        || ! grep -Fq "${abs_hook}" "${dest}" \
        || grep -Fq '${RIVETOS_ROOT' "${dest}"; then
        echo "ERROR: Hook config at ${dest} is not resolved to a durable path" >&2
        return 1
    fi
    echo "  Restored hook config: ${dest}"
    echo "  Hook script: ${abs_hook}"
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

# Returns 0 if a matching row exists for session_key+agent.
# Optional $3 = exact message content that must have been stored (this attempt).
# 1 = queried OK but no row; 2 = could not query (unavailable).
prove_stored_row() {
    local session_key="$1"
    local agent="$2"
    local content_needle="${3:-}"
    if [[ -z "${PG_URL}" ]]; then
        return 2
    fi
    local node_script rc
    # CommonJS so NODE_PATH is honored (ESM import does not search NODE_PATH).
    node_script='const { Pool } = require("pg");
const url = process.env.RIVETOS_PG_URL;
const sessionKey = process.env.PROOF_SESSION_KEY;
const agent = process.env.PROOF_AGENT;
const content = process.env.PROOF_CONTENT || "";
if (!url || !sessionKey || !agent) process.exit(2);
const pool = new Pool({ connectionString: url, max: 1 });
const sql = content
  ? "SELECT m.id FROM ros_messages m JOIN ros_conversations c ON c.id = m.conversation_id WHERE c.session_key = $1 AND c.agent = $2 AND m.content = $3 LIMIT 1"
  : "SELECT id FROM ros_conversations WHERE session_key = $1 AND agent = $2 LIMIT 1";
const params = content ? [sessionKey, agent, content] : [sessionKey, agent];
pool.query(sql, params).then(async (r) => {
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
        PROOF_CONTENT="${content_needle}" \
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

    if ! load_pg_url; then
        echo "ERROR: Door 2 proof unavailable: RIVETOS_PG_URL not set and not in ~/.rivetos/.env" >&2
        return 2
    fi

    local dest="${grok_home}/hooks/rivet-memory.json"
    if [[ ! -f "${dest}" ]]; then
        echo "ERROR: Door 2 proof unavailable: installed hook config missing at ${dest}" >&2
        return 2
    fi
    local cmd hook_bin hook_evt
    cmd="$(jq -r '.hooks.Stop[0].hooks[0].command // empty' "${dest}")"
    if [[ -z "${cmd}" ]]; then
        echo "ERROR: Door 2 proof unavailable: no Stop command in ${dest}" >&2
        return 2
    fi
    if [[ "${cmd}" == *'${'* ]]; then
        echo "ERROR: Door 2 proof failed: installed hook command is not a durable path: ${cmd}" >&2
        return 1
    fi
    hook_evt="${cmd##* }"
    hook_bin="${cmd%" ${hook_evt}"}"
    if [[ ! -f "${hook_bin}" ]]; then
        echo "ERROR: Door 2 proof unavailable: hook command not found at ${hook_bin}" >&2
        return 2
    fi

    local sid token cwd_enc proof_dir now_ms session_key pr i
    sid="setup-prove-$$-$(date +%s)"
    token="rivetos-door2-prove-$$-$(date +%s)-${RANDOM}"
    cwd_enc="$(node -p 'encodeURIComponent("/tmp/rivetos-door2-prove")')" || cwd_enc="%2Ftmp%2Frivetos-door2-prove"
    proof_dir="${grok_home}/sessions/${cwd_enc}/${sid}"
    mkdir -p "${proof_dir}"
    now_ms=$(( $(date +%s) * 1000 ))
    if ! jq -n --arg sid "${sid}" --arg token "${token}" --argjson ts "${now_ms}" \
        '{method:"session/update",params:{sessionId:$sid,update:{sessionUpdate:"user_message_chunk",content:{type:"text",text:$token},_meta:{promptIndex:0}},_meta:{eventId:($sid + "-prove"),agentTimestampMs:$ts}}}' \
        > "${proof_dir}/updates.jsonl"; then
        rm -rf "${proof_dir}"
        echo "ERROR: Door 2 proof unavailable: failed to write proof transcript" >&2
        return 2
    fi
    printf '%s\n' '{"generated_title":"setup door2 prove"}' > "${proof_dir}/summary.json"

    echo "  Door 2: Invoking installed hook ${hook_bin} ${hook_evt}..."
    if ! printf '%s\n' "{\"sessionId\":\"${sid}\"}" \
        | GROK_SESSION_ID="${sid}" "${hook_bin}" "${hook_evt}"; then
        rm -rf "${proof_dir}"
        echo "ERROR: Door 2 hook command failed for session ${sid}" >&2
        return 1
    fi

    session_key="grok-build:${sid}"
    pr=1
    for i in {1..30}; do
        pr=0
        prove_stored_row "${session_key}" "rivet-grok" "${token}" || pr=$?
        if [[ "${pr}" -eq 0 ]]; then
            rm -rf "${proof_dir}"
            echo "  Door 2 proved OK (session ${sid}, known message stored)"
            return 0
        fi
        if [[ "${pr}" -eq 2 ]]; then
            rm -rf "${proof_dir}"
            echo "ERROR: Door 2 proof unavailable: could not query memory store" >&2
            return 2
        fi
        sleep 1
    done
    rm -rf "${proof_dir}"
    echo "ERROR: Door 2 proof failed: known message from this attempt was not stored for ${session_key}" >&2
    return 1
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
    echo "ERROR: ${SHARE_ROOT} is not the mounted recovery share" >&2
    echo "The path must be the share mount itself, or a subdirectory of a remote/fuse share." >&2
    echo "A leftover directory or a subdirectory of unrelated local storage is not enough." >&2
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
