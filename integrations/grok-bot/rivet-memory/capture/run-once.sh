#!/usr/bin/env bash
# Grok Bot capture runner: convert transcripts and ingest to RivetOS memory.
# Runs for all models on the grokbot node.
# Requires RIVETOS_PG_URL and RIVETOS_ROOT with built packages; fails closed if missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_JSON="${SCRIPT_DIR}/models.json"
CONVERTER="${CONVERTER:-${SCRIPT_DIR}/convert-transcript.py}"
RIVETOS_ROOT="${RIVETOS_ROOT:-/opt/rivetos}"
INGEST_BIN="${RIVETOS_ROOT}/integrations/grok-bot/rivet-memory/bin/ingest-session.mjs"
SPOOL_DIR="${SCRIPT_DIR}/spool"
STATE_DIR="${HOME}/.rivetos/grokbot-capture-state"
GROKBOT_TRANSCRIPT_ROOT="${GROKBOT_TRANSCRIPT_ROOT:-}"

# Stuck policy — MUST match grok-memory-capture.ts:
# 3+ consecutive failures whose firstFailureMs..lastAttemptMs span is <= 2h,
# and the last attempt is still within that 2h window of now.
STUCK_FAILURE_COUNT=3
STUCK_WINDOW_MS=$((2 * 60 * 60 * 1000))

# Validate dependencies
if [[ ! -f "${CONVERTER}" ]]; then
    echo "ERROR: Converter not found at ${CONVERTER}" >&2
    exit 1
fi

if [[ ! -f "${INGEST_BIN}" ]]; then
    echo "ERROR: Ingest script not found at ${INGEST_BIN}" >&2
    exit 1
fi

# Check jq and python3 available
if ! command -v jq &>/dev/null; then
    echo "ERROR: jq not found in PATH" >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found in PATH" >&2
    exit 1
fi

# GROKBOT_TRANSCRIPT_ROOT is required — fail hard if unset
if [[ -z "${GROKBOT_TRANSCRIPT_ROOT}" ]]; then
    echo "ERROR: GROKBOT_TRANSCRIPT_ROOT not set, cannot locate transcripts" >&2
    exit 1
fi

# Fail-closed check: memory-postgres and sidecar dist must exist
SKIP_INGEST=0
if [[ ! -d "${RIVETOS_ROOT}/node_modules/@rivetos/memory-postgres" ]]; then
    echo "WARN: RivetOS memory-postgres package not built or missing, skipping ingest (fail closed)" >&2
    SKIP_INGEST=1
fi

if [[ ! -f "${RIVETOS_ROOT}/services/mcp-sidecar/dist/memory-write.js" ]]; then
    echo "WARN: RivetOS sidecar dist not built, skipping ingest (fail closed)" >&2
    SKIP_INGEST=1
fi

# Align .env check: ingest-session.mjs loads ~/.rivetos/.env itself, so check there
# rather than requiring RIVETOS_PG_URL in process env
RIVETOS_ENV_FILE="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
if [[ ! -f "${RIVETOS_ENV_FILE}" ]] && [[ -z "${RIVETOS_PG_URL:-}" ]]; then
    echo "WARN: No .env at ${RIVETOS_ENV_FILE} and RIVETOS_PG_URL not set, skipping ingest (fail closed)" >&2
    SKIP_INGEST=1
fi

mkdir -p "${SPOOL_DIR}"
mkdir -p "${STATE_DIR}"

# Publish JSON to dest via temp file in the same directory + rename.
# Never truncate dest before the new body is complete (readers and the next
# counter increment both depend on the previous file remaining intact).
write_state_atomic() {
    local dest="$1"
    local body="$2"
    local dir tmp
    dir="$(dirname -- "${dest}")"
    mkdir -p "${dir}"
    tmp="$(mktemp "${dir}/.state.XXXXXX")"
    if ! printf '%s\n' "${body}" > "${tmp}"; then
        rm -f "${tmp}"
        return 1
    fi
    if ! mv -f "${tmp}" "${dest}"; then
        rm -f "${tmp}"
        return 1
    fi
}

read_prior_state_json() {
    local state_file="$1"
    if [[ -f "${state_file}" ]]; then
        jq -c . "${state_file}" 2>/dev/null || echo '{}'
    else
        echo '{}'
    fi
}

record_failure() {
    local state_file="$1"
    local session_id="$2"
    local last_error="$3"
    local now_ms prior_json json
    now_ms=$(( $(date +%s) * 1000 ))
    prior_json="$(read_prior_state_json "${state_file}")"
    json="$(jq -n \
        --arg sid "${session_id}" \
        --arg err "${last_error}" \
        --argjson now "${now_ms}" \
        --argjson prior "${prior_json}" \
        '
        ($prior.lastStatus // "") as $st |
        ($prior.firstFailureMs) as $ff |
        {
          sessionId: $sid,
          lastAttemptMs: $now,
          lastStatus: "failure",
          lastError: $err,
          consecutiveFailures: (
            if $st == "failure" and ($ff | type) == "number"
            then (($prior.consecutiveFailures // 0) + 1)
            else 1
            end
          ),
          firstFailureMs: (
            if $st == "failure" and ($ff | type) == "number"
            then $ff
            else $now
            end
          )
        }
        ')"
    write_state_atomic "${state_file}" "${json}"
}

record_success() {
    local state_file="$1"
    local session_id="$2"
    local now_ms json
    now_ms=$(( $(date +%s) * 1000 ))
    json="$(jq -n \
        --arg sid "${session_id}" \
        --argjson now "${now_ms}" \
        '{
          sessionId: $sid,
          lastAttemptMs: $now,
          lastStatus: "success",
          consecutiveFailures: 0
        }')"
    write_state_atomic "${state_file}" "${json}"
}

# Returns 0 if the state file describes a stuck session under the shared policy.
session_is_stuck() {
    local state_file="$1"
    local now_ms
    [[ -f "${state_file}" ]] || return 1
    now_ms=$(( $(date +%s) * 1000 ))
    jq -e \
        --argjson now "${now_ms}" \
        --argjson count "${STUCK_FAILURE_COUNT}" \
        --argjson window "${STUCK_WINDOW_MS}" \
        '
        .lastStatus == "failure"
        and ((.consecutiveFailures // 0) >= $count)
        and (.firstFailureMs | type) == "number"
        and (.lastAttemptMs | type) == "number"
        and ((.lastAttemptMs - .firstFailureMs) <= $window)
        and (($now - .lastAttemptMs) <= $window)
        ' "${state_file}" >/dev/null 2>&1
}

warn_if_stuck() {
    local state_file="$1"
    local consecutive last_error
    if session_is_stuck "${state_file}"; then
        consecutive="$(jq -r '.consecutiveFailures // 0' "${state_file}")"
        last_error="$(jq -r '.lastError // "unknown"' "${state_file}")"
        echo "  WARN: Session stuck (${consecutive} consecutive failures within 2h)" >&2
        echo "  Last error: ${last_error}" >&2
        return 0
    fi
    return 1
}

# Parse models.json
if [[ ! -f "${MODELS_JSON}" ]]; then
    echo "ERROR: models.json not found at ${MODELS_JSON}" >&2
    exit 1
fi

models=$(jq -r '.models[] | @json' "${MODELS_JSON}")
transcript_rel=$(jq -r '.transcriptRel' "${MODELS_JSON}")

any_model_failed=0
any_model_processed=0
any_stuck=0

# Process each model
while IFS= read -r model_json; do
    model_id=$(echo "${model_json}" | jq -r '.id')
    model_name=$(echo "${model_json}" | jq -r '.name')
    session_id=$(echo "${model_json}" | jq -r '.sessionId')
    agent_id=$(echo "${model_json}" | jq -r '.agentId')

    echo "Processing model: ${model_name} (${model_id})"

    # Resolve transcript path
    transcript_path="${transcript_rel//<id>/${model_id}}"
    transcript_path="${transcript_path//\$GROKBOT_TRANSCRIPT_ROOT/${GROKBOT_TRANSCRIPT_ROOT}}"

    if [[ ! -f "${transcript_path}" ]]; then
        echo "  SKIP: Transcript not found at ${transcript_path}"
        continue
    fi

    any_model_processed=1

    state_file="${STATE_DIR}/${session_id}.json"

    # Convert
    spool_path="${SPOOL_DIR}/${session_id}.jsonl"
    echo "  Converting: ${transcript_path} -> ${spool_path}"

    if ! python3 "${CONVERTER}" "${transcript_path}" "${spool_path}" 2>&1; then
        echo "  ERROR: Conversion failed for ${model_name}" >&2
        record_failure "${state_file}" "${session_id}" "conversion failed"
        if warn_if_stuck "${state_file}"; then
            any_stuck=1
        fi
        any_model_failed=1
        continue
    fi

    # Ingest (if PG available)
    if [[ "${SKIP_INGEST}" -eq 0 ]]; then
        echo "  Ingesting: ${spool_path} (session=${session_id}, agent=${agent_id})"

        # Capture node exit code separately to avoid grep exit-code confusion
        ingest_output=$(mktemp)
        if node "${INGEST_BIN}" --session-id="${session_id}" --agent="${agent_id}" "${spool_path}" >"${ingest_output}" 2>&1; then
            ingest_rc=0
        else
            ingest_rc=$?
        fi

        # Show output (no filtering of secrets — they're redacted by the system)
        cat "${ingest_output}"
        rm -f "${ingest_output}"

        if [[ ${ingest_rc} -ne 0 ]]; then
            echo "  ERROR: Ingest failed for ${model_name} (exit ${ingest_rc})" >&2
            record_failure "${state_file}" "${session_id}" "ingest exit ${ingest_rc}"
            any_model_failed=1
        else
            record_success "${state_file}" "${session_id}"
        fi
        if warn_if_stuck "${state_file}"; then
            any_stuck=1
        fi
    else
        echo "  SKIP: Ingest (fail closed, see warnings above)"
    fi

    echo "  Done: ${model_name}"
done <<< "${models}"

# All models skipped (no transcripts found) must not look like success
if [[ ${any_model_processed} -eq 0 ]]; then
    echo "ERROR: No models processed (no transcripts found)" >&2
    exit 1
fi

# Report summary
if [[ ${any_stuck} -gt 0 ]]; then
    echo "WARN: Some sessions are stuck (see warnings above)" >&2
fi

if [[ ${any_model_failed} -eq 0 ]]; then
    echo "Capture run complete: all OK"
else
    echo "Capture run complete: some failures (see errors above)" >&2
fi

exit ${any_model_failed}
