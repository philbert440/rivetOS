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
SESSION_SUFFIX="${GROKBOT_SESSION_SUFFIX--v3}"
# Watcher's single size:mtime map. Per-session stuck-policy lived next to it
# under the unsuffixed session id (never copy state.json into STATE_DIR).
OLD_STATE_DIR="${HOME}/.rivetos/capture"
OLD_WATCHER_STATE="${OLD_STATE_DIR}/state.json"
GROKBOT_TRANSCRIPT_ROOT="${GROKBOT_TRANSCRIPT_ROOT:-}"
GROKBOT_AGENTS="${GROKBOT_AGENTS:-${HOME}/agent-data/agents}"
CLI_JS="${SCRIPT_DIR}/dist/cli.js"

# Stuck policy — MUST match grok-memory-capture.ts:
# ≥3 failures whose timestamps fall inside a rolling 2h window ending at now.
# Samples older than 2h (or in the future / clock-rollback) are dropped.
# Success clears the window. A fresh burst of 3 failures within 2h re-alarms
# regardless of older history.
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

# Fail-closed check: memory-postgres and the grok-bot ingest writer must exist
SKIP_INGEST=0
if [[ ! -d "${RIVETOS_ROOT}/node_modules/@rivetos/memory-postgres" ]]; then
    echo "WARN: RivetOS memory-postgres package not built or missing, skipping ingest (fail closed)" >&2
    SKIP_INGEST=1
fi

if [[ ! -f "${RIVETOS_ROOT}/integrations/grok-bot/rivet-memory/capture/dist/ingest-rows.js" ]]; then
    echo "WARN: grok-bot ingest writer not built, skipping ingest (fail closed)" >&2
    SKIP_INGEST=1
fi

# Fall back to models.json overrides (not a leftover models[] array).
overrides_as_models() {
    jq -c '.overrides | to_entries[] | {id:.key, persona:.value.persona, name:.value.persona, sessionId:.value.session, session:.value.session, agentId:.value.agent, agent:.value.agent}' "${MODELS_JSON}"
}

# Align .env check: ingest-session.mjs loads ~/.rivetos/.env itself, so check
# there rather than requiring RIVETOS_PG_URL in process env. Ingest only maps
# postgres:// / postgresql:// DataHub URLs.
RIVETOS_ENV_FILE="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
_rivetos_is_pg_url() {
    case "${1-}" in
        postgres://* | postgresql://*) return 0 ;;
        *) return 1 ;;
    esac
}
_rivetos_pg_ready=0
if _rivetos_is_pg_url "${RIVETOS_PG_URL:-}" || _rivetos_is_pg_url "${RIVETOS_DATAHUB_URL:-}"; then
    _rivetos_pg_ready=1
elif [[ -f "${RIVETOS_ENV_FILE}" ]]; then
    if grep -Eq '^(export[[:space:]]+)?(RIVETOS_PG_URL|RIVETOS_DATAHUB_URL)=.*(postgres|postgresql)://' "${RIVETOS_ENV_FILE}"; then
        _rivetos_pg_ready=1
    fi
fi
if [[ "${_rivetos_pg_ready}" -eq 0 ]]; then
    if [[ -n "${RIVETOS_DATAHUB_URL:-}" ]]; then
        echo "WARN: RIVETOS_DATAHUB_URL is set but is not postgres:// or postgresql://; ingest needs a Postgres DataHub (RIVETOS_PG_URL). Skipping ingest." >&2
    elif [[ ! -f "${RIVETOS_ENV_FILE}" ]]; then
        echo "WARN: No .env at ${RIVETOS_ENV_FILE} and neither RIVETOS_PG_URL nor a postgres RIVETOS_DATAHUB_URL is set, skipping ingest (fail closed)" >&2
    else
        echo "WARN: ${RIVETOS_ENV_FILE} has no postgres:// / postgresql:// RIVETOS_PG_URL or RIVETOS_DATAHUB_URL, skipping ingest (fail closed)" >&2
    fi
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
    local raw=""
    # Empty files make `jq -c .` exit 0 with no output, so `|| echo '{}'`
    # never fires. Require a JSON object; anything else (empty, array,
    # parse error) becomes {}.
    if [[ -s "${state_file}" ]]; then
        raw="$(jq -c 'if type == "object" then . else empty end' "${state_file}" 2>/dev/null || true)"
    fi
    if [[ -z "${raw}" ]]; then
        echo '{}'
    else
        printf '%s\n' "${raw}"
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
        --argjson window "${STUCK_WINDOW_MS}" \
        --argjson prior "${prior_json}" \
        '
        ($prior.lastStatus // "") as $st |
        (if $st == "failure" then
           if ($prior.failureTimestampsMs | type) == "array" then
             $prior.failureTimestampsMs
           else
             (
               [
                 ($prior.firstFailureMs | select(type == "number")),
                 ($prior.lastAttemptMs | select(type == "number"))
               ] | unique
             )
           end
         else [] end) as $prior_ts |
        ($prior_ts + [$now]
          | map(select(type == "number" and ($now - .) >= 0 and ($now - .) <= $window))
          | sort
        ) as $ts |
        {
          sessionId: $sid,
          lastAttemptMs: $now,
          lastStatus: "failure",
          lastError: $err,
          consecutiveFailures: ($ts | length),
          firstFailureMs: (if ($ts | length) > 0 then $ts[0] else $now end),
          failureTimestampsMs: $ts
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
        and (.lastAttemptMs | type) == "number"
        and (($now - .lastAttemptMs) >= 0)
        and (($now - .lastAttemptMs) <= $window)
        and (
          (if (.failureTimestampsMs | type) == "array" then .failureTimestampsMs
           else (
             [(.firstFailureMs | select(type == "number")),
              (.lastAttemptMs | select(type == "number"))] | unique
           )
           end)
          | map(select(type == "number" and ($now - .) >= 0 and ($now - .) <= $window))
          | length
        ) >= $count
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

# Same roster as the watcher: discover-models.mjs (agent profiles + overrides).
# Fall back to models.json overrides only if discovery cannot run.
DISCOVER_JS="${SCRIPT_DIR}/discover-models.mjs"
if [[ ! -f "${MODELS_JSON}" && ! -f "${DISCOVER_JS}" ]]; then
    echo "ERROR: models.json not found at ${MODELS_JSON}" >&2
    exit 1
fi

transcript_rel=$(jq -r '.transcriptRel // empty' "${MODELS_JSON}" 2>/dev/null || true)
if [[ -f "${DISCOVER_JS}" ]]; then
    if roster_json="$(node "${DISCOVER_JS}" --json 2>/dev/null)"; then
        roster_n="$(printf '%s' "${roster_json}" | jq -r '.models | length' 2>/dev/null || echo 0)"
        if [[ -z "${roster_n}" || "${roster_n}" == "0" || "${roster_n}" == "null" ]]; then
            echo "ERROR: discover-models.mjs --json returned an empty roster" >&2
            exit 1
        fi
        models="$(printf '%s' "${roster_json}" | jq -c '.models[]')"
    elif [[ -f "${MODELS_JSON}" ]]; then
        models="$(overrides_as_models)"
    else
        echo "ERROR: cannot discover models (discover failed and no models.json)" >&2
        exit 1
    fi
elif [[ -f "${MODELS_JSON}" ]]; then
    models="$(overrides_as_models)"
else
    echo "ERROR: cannot discover models (no roster and no models.json)" >&2
    exit 1
fi

any_model_failed=0
any_model_processed=0
any_stuck=0

# Process each model
while IFS= read -r model_json; do
    model_id=$(echo "${model_json}" | jq -r '.id')
    model_name=$(echo "${model_json}" | jq -r '.name // .persona')
    session_id=$(echo "${model_json}" | jq -r '.sessionId // .session')
    agent_id=$(echo "${model_json}" | jq -r '.agentId // .agent')
    if [[ -n "${SESSION_SUFFIX}" && "${session_id}" != *"${SESSION_SUFFIX}" ]]; then
        session_id="${session_id}${SESSION_SUFFIX}"
    fi

    echo "Processing model: ${model_name} (${model_id})"

    # Resolve transcript path (roster .transcript, else models.json transcriptRel)
    transcript_path=$(echo "${model_json}" | jq -r '.transcript // empty')
    if [[ -z "${transcript_path}" ]]; then
        transcript_path="${transcript_rel//<id>/${model_id}}"
        transcript_path="${transcript_path//\$GROKBOT_TRANSCRIPT_ROOT/${GROKBOT_TRANSCRIPT_ROOT}}"
    fi

    if [[ ! -f "${transcript_path}" ]]; then
        echo "  SKIP: Transcript not found at ${transcript_path}"
        continue
    fi

    any_model_processed=1

    state_file="${STATE_DIR}/${session_id}.json"
    # Only the original -v3 cutover copies unsuffixed stuck-policy. -v4+ must
    # start with a fresh state file so -v3 cursors are left untouched.
    if [[ "${SESSION_SUFFIX}" == "-v3" ]]; then
        old_stuck="$(node "${SCRIPT_DIR}/live-state.mjs" old-stuck "${OLD_STATE_DIR}" "${session_id}" "${SESSION_SUFFIX}")"
        if [[ ! -f "${state_file}" && -f "${old_stuck}" && "${old_stuck}" != "${OLD_WATCHER_STATE}" ]]; then
            mkdir -p "${STATE_DIR}"
            cp "${old_stuck}" "${state_file}"
        fi
    fi

    # Convert
    spool_path="${SPOOL_DIR}/${session_id}.jsonl"
    echo "  Converting: ${transcript_path} -> ${spool_path}"

    if ! python3 "${CONVERTER}" "${transcript_path}" "${spool_path}" --agent-id "${model_id}" --session "${session_id}" 2>&1; then
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

    # store.db (seq cursor; suffix ${SESSION_SUFFIX}-store — positions are not the jsonl index)
    store_db="${GROKBOT_AGENTS}/${model_id}/store.db"
    if [[ -f "${store_db}" && -f "${CLI_JS}" && "${SKIP_INGEST}" -eq 0 ]]; then
        store_base="${session_id%"${SESSION_SUFFIX}"}"
        store_session="${store_base}${SESSION_SUFFIX}-store"
        if [[ "${session_id}" == *"${SESSION_SUFFIX}-store" ]]; then
            store_session="${session_id}"
        fi
        store_spool="${SPOOL_DIR}/${store_session}.jsonl"
        store_cursor_file="${STATE_DIR}/${store_session}.seq"
        after_seq=-1
        if [[ -s "${store_cursor_file}" ]]; then
            after_seq="$(tr -d '[:space:]' < "${store_cursor_file}" || echo -1)"
        fi
        echo "  Converting store.db seq>${after_seq} -> ${store_spool}"
        if store_out="$(node "${CLI_JS}" convert-store "${store_db}" "${store_spool}" --agent-id "${model_id}" --session "${store_session}" --after-seq="${after_seq}" 2>&1)"; then
            echo "  ${store_out}"
            store_max="$(printf '%s' "${store_out}" | jq -r '.max_seq // empty' 2>/dev/null || true)"
            store_n="$(printf '%s' "${store_out}" | jq -r '.out // 0' 2>/dev/null || echo 0)"
            if [[ "${store_n}" != "0" && -n "${store_n}" ]]; then
                if node "${INGEST_BIN}" --session-id="${store_session}" --agent="${agent_id}" "${store_spool}"; then
                    if [[ -n "${store_max}" && "${store_max}" != "null" ]]; then
                        printf '%s\n' "${store_max}" > "${store_cursor_file}"
                    fi
                else
                    echo "  ERROR: store ingest failed for ${model_name}" >&2
                    any_model_failed=1
                fi
            fi
        else
            echo "  ERROR: store convert failed for ${model_name}: ${store_out}" >&2
            any_model_failed=1
        fi
    fi

    # voice-calls/*.json (suffix ${SESSION_SUFFIX}-voice-<stem> — turn index ≠ jsonl index)
    voice_dir="${GROKBOT_AGENTS}/${model_id}/voice-calls"
    if [[ -d "${voice_dir}" && -f "${CLI_JS}" && "${SKIP_INGEST}" -eq 0 ]]; then
        shopt -s nullglob
        for voice_file in "${voice_dir}"/*.json; do
            voice_stem="$(basename "${voice_file}" .json)"
            voice_base="${session_id%"${SESSION_SUFFIX}"}"
            voice_session="${voice_base}${SESSION_SUFFIX}-voice-${voice_stem}"
            voice_spool="${SPOOL_DIR}/${voice_session}.jsonl"
            echo "  Converting voice ${voice_stem} -> ${voice_spool}"
            if ! node "${CLI_JS}" convert-voice "${voice_file}" "${voice_spool}" --agent-id "${model_id}" --session "${voice_session}"; then
                echo "  ERROR: voice convert failed for ${voice_stem}" >&2
                any_model_failed=1
                continue
            fi
            if ! node "${INGEST_BIN}" --session-id="${voice_session}" --agent="${agent_id}" "${voice_spool}"; then
                echo "  ERROR: voice ingest failed for ${voice_stem}" >&2
                any_model_failed=1
            fi
        done
        shopt -u nullglob
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
