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

if [[ ! -d "${RIVETOS_ROOT}/node_modules/@rivetos/memory-postgres" ]]; then
    echo "WARN: RivetOS packages not built or missing, skipping ingest (fail closed)" >&2
    SKIP_INGEST=1
fi

if [[ -z "${RIVETOS_PG_URL:-}" ]]; then
    echo "WARN: RIVETOS_PG_URL not set, skipping ingest (fail closed)" >&2
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

# Process each model
while IFS= read -r model_json; do
    model_id=$(echo "${model_json}" | jq -r '.id')
    model_name=$(echo "${model_json}" | jq -r '.name')
    session_id=$(echo "${model_json}" | jq -r '.sessionId')
    agent_id=$(echo "${model_json}" | jq -r '.agentId')
    
    echo "Processing model: ${model_name} (${model_id})"
    
    # Resolve transcript path
    if [[ -z "${GROKBOT_TRANSCRIPT_ROOT}" ]]; then
        echo "  SKIP: GROKBOT_TRANSCRIPT_ROOT not set, cannot locate transcript"
        continue
    fi
    
    transcript_path="${transcript_rel//<id>/${model_id}}"
    transcript_path="${transcript_path//\$GROKBOT_TRANSCRIPT_ROOT/${GROKBOT_TRANSCRIPT_ROOT}}"
    
    if [[ ! -f "${transcript_path}" ]]; then
        echo "  SKIP: Transcript not found at ${transcript_path}"
        continue
    fi
    
    # Convert
    spool_path="${SPOOL_DIR}/${session_id}.jsonl"
    echo "  Converting: ${transcript_path} -> ${spool_path}"
    
    if ! python3 "${CONVERTER}" "${transcript_path}" "${spool_path}"; then
        echo "  ERROR: Conversion failed for ${model_name}" >&2
        continue
    fi
    
    # Ingest (if PG available)
    if [[ -z "${SKIP_INGEST:-}" ]]; then
        echo "  Ingesting: ${spool_path} (session=${session_id}, agent=${agent_id})"
        
        if ! node "${INGEST_BIN}" --session-id="${session_id}" --agent="${agent_id}" "${spool_path}" 2>&1 | grep -v 'RIVETOS_PG_URL\|RIVETOS_EMBED'; then
            echo "  WARN: Ingest failed for ${model_name}, continuing" >&2
        fi
    else
        echo "  SKIP: Ingest (fail closed, see warnings above)"
    fi
    
    echo "  Done: ${model_name}"
done <<< "${models}"

echo "Capture run complete"
exit 0
