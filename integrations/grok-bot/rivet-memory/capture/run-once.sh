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
GROKBOT_TRANSCRIPT_ROOT="${GROKBOT_TRANSCRIPT_ROOT:-}"

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

# Parse models.json
if [[ ! -f "${MODELS_JSON}" ]]; then
    echo "ERROR: models.json not found at ${MODELS_JSON}" >&2
    exit 1
fi

models=$(jq -r '.models[] | @json' "${MODELS_JSON}")
transcript_rel=$(jq -r '.transcriptRel' "${MODELS_JSON}")

any_model_failed=0
any_model_processed=0

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
    
    # Convert
    spool_path="${SPOOL_DIR}/${session_id}.jsonl"
    echo "  Converting: ${transcript_path} -> ${spool_path}"
    
    if ! python3 "${CONVERTER}" "${transcript_path}" "${spool_path}" 2>&1; then
        echo "  ERROR: Conversion failed for ${model_name}" >&2
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
            any_model_failed=1
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

echo "Capture run complete"
exit ${any_model_failed}
