#!/usr/bin/env bash
# Load a GitHub PR into the workflow case directory (cwd).
# Input: WORKFLOW_INPUT JSON env { "repo": "owner/name", "pr": 123 }
# Also accepts argv[1] as the same JSON (script-run-executor convention).
# Requires: gh (or $GH_BIN) authenticated in the node environment.
set -euo pipefail

GH="${GH_BIN:-gh}"

parse_input() {
  local raw="${WORKFLOW_INPUT:-${1:-}}"
  if [[ -z "${raw}" ]]; then
    echo "load-pr.sh: missing WORKFLOW_INPUT / argv[1]" >&2
    exit 1
  fi
  # Prefer python3 (stdlib json); jq optional.
  if command -v python3 >/dev/null 2>&1; then
    REPO="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d["repo"])' "${raw}")"
    PR="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(int(d["pr"]))' "${raw}")"
  elif command -v jq >/dev/null 2>&1; then
    REPO="$(printf '%s' "${raw}" | jq -r '.repo')"
    PR="$(printf '%s' "${raw}" | jq -r '.pr')"
  else
    echo "load-pr.sh: need python3 or jq to parse WORKFLOW_INPUT" >&2
    exit 1
  fi
  if [[ -z "${REPO}" || "${REPO}" == "null" || -z "${PR}" || "${PR}" == "null" ]]; then
    echo "load-pr.sh: repo and pr are required in input JSON" >&2
    exit 1
  fi
}

parse_input "${1:-}"

if ! command -v "${GH}" >/dev/null 2>&1; then
  echo "load-pr.sh: gh binary not found (set GH_BIN or install GitHub CLI)" >&2
  exit 1
fi

"${GH}" pr view "${PR}" --repo "${REPO}" \
  --json title,author,additions,deletions,baseRefName > pr.json

"${GH}" pr diff "${PR}" --repo "${REPO}" > pr.diff

# One-liner summary on stdout for the script executor to journal.
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
import json, os
from pathlib import Path
meta = json.loads(Path("pr.json").read_text(encoding="utf-8"))
diff_bytes = Path("pr.diff").stat().st_size
print(json.dumps({"title": meta.get("title"), "diffBytes": diff_bytes}))
PY
else
  TITLE="$(jq -r '.title' pr.json)"
  DIFF_BYTES="$(wc -c < pr.diff | tr -d ' ')"
  printf '{"title":%s,"diffBytes":%s}\n' "$(jq -n --arg t "${TITLE}" '$t')" "${DIFF_BYTES}"
fi
