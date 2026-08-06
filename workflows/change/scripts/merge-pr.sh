#!/usr/bin/env bash
# Squash-merge a GitHub PR. cwd = caseDir.
# Input: WORKFLOW_INPUT / argv[1] JSON { "repo": "owner/name", "pr": 123 }
set -eu

GH="${GH_BIN:-gh}"

raw="${WORKFLOW_INPUT:-${1:-}}"
if [[ -z "${raw}" ]]; then
  echo "merge-pr.sh: missing WORKFLOW_INPUT / argv[1]" >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  REPO="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d["repo"])' "${raw}")"
  PR="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(int(d["pr"]))' "${raw}")"
elif command -v jq >/dev/null 2>&1; then
  REPO="$(printf '%s' "${raw}" | jq -r '.repo')"
  PR="$(printf '%s' "${raw}" | jq -r '.pr')"
else
  echo "merge-pr.sh: need python3 or jq to parse WORKFLOW_INPUT" >&2
  exit 1
fi

if ! command -v "${GH}" >/dev/null 2>&1; then
  echo "merge-pr.sh: gh binary not found (set GH_BIN or install GitHub CLI)" >&2
  exit 1
fi

"${GH}" pr merge "${PR}" --repo "${REPO}" --squash

if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import json,sys; print(json.dumps({"merged": True, "pr": int(sys.argv[1]), "repo": sys.argv[2]}))' "${PR}" "${REPO}"
elif command -v jq >/dev/null 2>&1; then
  jq -n --argjson pr "${PR}" --arg repo "${REPO}" '{merged:true, pr:$pr, repo:$repo}'
else
  echo "merge-pr.sh: need python3 or jq for JSON output" >&2
  exit 1
fi
