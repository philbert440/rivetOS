#!/usr/bin/env bash
# Stub rivet-ca.sh for rivethub-hub bats tests. Speaks the same env/CLI as
# lib/rivet-ca.sh (vendored from /opt/rivetos/scripts/rivet-ca.sh) without
# calling openssl.
#
# Intentionally noisy on stdout ("issued cert for …", "openssl chatter") so
# tests can prove rivethub-hub redirects CA stdout off the tarball pipe.
# Writes keys as 0644 so tests can prove the hub tightens them to 0600.
# Regenerates distinct crt/key bytes on every issue-node call (renew).
set -euo pipefail

cmd="${1:-}"
shift || true

root="${RIVET_CA_ROOT_DIR:?RIVET_CA_ROOT_DIR unset}"
shared="${RIVET_CA_SHARED_DIR:?RIVET_CA_SHARED_DIR unset}"

if [[ -n "${TEST_TMP:-}" ]]; then
  mkdir -p "${TEST_TMP}"
  {
    printf 'cmd=%s\n' "${cmd}"
    printf 'RIVET_CA_ROOT_DIR=%s\n' "${root}"
    printf 'RIVET_CA_SHARED_DIR=%s\n' "${shared}"
    local_i=1
    for local_a in "$@"; do
      printf 'arg%d=%s\n' "${local_i}" "${local_a}"
      local_i=$((local_i + 1))
    done
  } >"${TEST_TMP}/ca-last-invoke"
fi

case "${cmd}" in
  init)
    mkdir -p "${root}"
    printf 'stub-root-key\n' >"${root}/ca.key"
    printf 'stub-root-crt\n' >"${root}/ca.crt"
    chmod 0600 "${root}/ca.key"
    echo "openssl chatter: generating root"
    ;;
  issue-intermediate)
    mkdir -p "${shared}/intermediate"
    printf 'stub-int-key\n' >"${shared}/intermediate/int.key"
    printf 'stub-int-crt\n' >"${shared}/intermediate/int.crt"
    printf 'stub-chain\n' >"${shared}/intermediate/chain.pem"
    chmod 0600 "${shared}/intermediate/int.key"
    echo "openssl chatter: signing intermediate"
    ;;
  issue-node)
    local_node="${1:-}"
    [[ -n "${local_node}" ]] || { echo "stub rivet-ca: issue-node needs <node-id>" >&2; exit 1; }
    shift || true
    if [[ -n "${TEST_TMP:-}" ]]; then
      printf '%s\n' "$@" >"${TEST_TMP}/ca-last-sans"
    fi
    mkdir -p "${shared}/issued"
    counter="${shared}/issued/.calls"
    n=0
    if [[ -f "${counter}" ]]; then
      n="$(cat "${counter}")"
    fi
    n=$((n + 1))
    printf '%s\n' "${n}" >"${counter}"
    nonce="${n}-${RANDOM}-${SECONDS}-$$"
    printf 'stub-crt-%s-%s\n' "${local_node}" "${nonce}" >"${shared}/issued/${local_node}.crt"
    printf 'stub-key-%s-%s\n' "${local_node}" "${nonce}" >"${shared}/issued/${local_node}.key"
    # World-readable on purpose: hub must chmod 0600.
    chmod 0644 "${shared}/issued/${local_node}.key"
    printf '%s\n' "$@" >"${shared}/issued/${local_node}.sans"
    echo "issued cert for ${local_node}"
    echo "openssl chatter: using configuration from stub"
    ;;
  ""|-h|--help)
    echo "stub rivet-ca.sh (init | issue-intermediate | issue-node)"
    ;;
  *)
    echo "stub rivet-ca: unknown command: ${cmd}" >&2
    exit 1
    ;;
esac
