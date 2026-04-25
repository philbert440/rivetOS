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
#
# Roster is loaded from (in order of precedence):
#   1. $MESH_NODES_FILE (env override)
#   2. /rivet-shared/rivet-ca/mesh-nodes.conf  (operator-managed, NFS)
#   3. ./mesh-nodes.conf next to this script   (local override)
#   4. ./mesh-nodes.example.conf               (placeholder, doc IPs only)
#
# Format: one entry per line, blank lines and #-comments ignored:
#   ct110:192.0.2.110:
#   ct111:192.0.2.111:opus
ROSTER_FILE=""
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
for candidate in \
  "${MESH_NODES_FILE:-}" \
  "/rivet-shared/rivet-ca/mesh-nodes.conf" \
  "${SCRIPT_DIR}/mesh-nodes.conf" \
  "${SCRIPT_DIR}/mesh-nodes.example.conf"
do
  [[ -n "$candidate" && -f "$candidate" ]] || continue
  ROSTER_FILE="$candidate"
  break
done

if [[ -z "$ROSTER_FILE" ]]; then
  echo "bootstrap-certs: no mesh roster found. Create /rivet-shared/rivet-ca/mesh-nodes.conf" >&2
  echo "  (see scripts/mesh-nodes.example.conf for format)" >&2
  exit 1
fi

echo "==> using roster: $ROSTER_FILE"
NODES=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line//[

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
\t\r ']/}"
  [[ -z "$line" ]] && continue
  NODES+=("$line")
done < "$ROSTER_FILE"

if [[ ${#NODES[@]} -eq 0 ]]; then
  echo "bootstrap-certs: roster $ROSTER_FILE has no entries" >&2
  exit 1
fi

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
