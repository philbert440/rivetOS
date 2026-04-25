#!/usr/bin/env bash
# bootstrap-certs.sh — issue the initial set of node + agent certs for the
# Rivet mesh. Idempotent-ish: rivet-ca.sh will renew (reuse keys) if a cert
# already exists, so re-running is safe.
#
# MUST be run on CT110 (datahub) — that's where the root CA key lives.
#
# After this completes, every CT has a server cert at
#   /rivet-shared/rivet-ca/issued/<node>.{crt,key}
# and every agent has a client cert at
#   /rivet-shared/rivet-ca/issued/<agent>@<node>.{crt,key}
# The chain bundle is at /rivet-shared/rivet-ca/intermediate/chain.pem.

set -euo pipefail

CA="$(dirname "$(readlink -f "$0")")/rivet-ca.sh"
[[ -x "$CA" ]] || { echo "rivet-ca.sh not found or not executable at $CA" >&2; exit 1; }

# Refuse to run anywhere but CT110 — root key is local there.
if [[ ! -f /var/lib/rivet-ca/root/ca.key ]]; then
  echo "bootstrap-certs: no root CA at /var/lib/rivet-ca/root/ca.key — run on CT110 after 'rivet-ca.sh init'" >&2
  exit 1
fi

# Mesh roster: <node-id>:<ip>:<agent-id-or-empty>
# datahub has no agent; agents map 1:1 to their host CT.
NODES=(
  "ct110:10.4.20.110:"
  "ct111:10.4.20.111:opus"
  "ct112:10.4.20.112:grok"
  "ct113:10.4.20.113:gemini"
  "ct114:10.4.20.114:local"
)

echo "==> issuing node (server) certs"
for entry in "${NODES[@]}"; do
  IFS=: read -r node ip _agent <<<"$entry"
  echo "    - $node  ($ip)"
  "$CA" issue-node "$node" "DNS:${node}" "IP:${ip}"
done

echo
echo "==> issuing agent (client) certs"
for entry in "${NODES[@]}"; do
  IFS=: read -r node _ip agent <<<"$entry"
  [[ -n "$agent" ]] || continue
  echo "    - ${agent}@${node}"
  "$CA" issue-agent "$agent" "$node"
done

echo
echo "==> done. issued certs:"
"$CA" list
