#!/usr/bin/env bash
# Record the workflow input in the case directory (cwd).
# Input: WORKFLOW_INPUT JSON env { "name": "..." }
# Also accepts argv[1] as the same JSON (script-run-executor convention).
set -eu

RAW="${WORKFLOW_INPUT:-${1:-}}"
if [ -z "${RAW}" ]; then
  echo "prepare.sh: missing WORKFLOW_INPUT / argv[1]" >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  NAME="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["name"])' "${RAW}")"
elif command -v jq >/dev/null 2>&1; then
  NAME="$(printf '%s' "${RAW}" | jq -r '.name')"
else
  echo "prepare.sh: need python3 or jq to parse WORKFLOW_INPUT" >&2
  exit 1
fi

printf '%s\n' "${NAME}" > input.txt

# One-liner summary on stdout for the script executor to journal.
printf '{"bytes":%s}\n' "$(wc -c < input.txt | tr -d ' ')"
