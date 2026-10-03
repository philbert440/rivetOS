#!/usr/bin/env bats
# Pure-logic tests for bin/rivethub-hub. openssl/rivet-ca.sh is the stub in
# test/fixtures/rivet-ca.sh (no real CA). Requires bats >= 1.5 is nice-to-have
# but these tests avoid `run --separate-stderr` so older bats works: enroll
# stdout is captured with redirections.

HUB="${BATS_TEST_DIRNAME}/../bin/rivethub-hub"
STUB_CA="${BATS_TEST_DIRNAME}/fixtures/rivet-ca.sh"

setup() {
  TEST_TMP="$(mktemp -d)"
  export TEST_TMP
  export RIVETHUB_ROOT="${TEST_TMP}/hub"
  export RIVETHUB_CA_SCRIPT="${STUB_CA}"
  export RIVETHUB_ADVERTISE_HOST="192.0.2.1"
  export RIVETHUB_NODE_NAME="datahub"
}

teardown() {
  rm -rf "${TEST_TMP}"
}

hub() {
  bash "${HUB}" "$@"
}

# ---------------------------------------------------------------------------
# usage / refusal
# ---------------------------------------------------------------------------

@test "root -h prints usage and mentions enroll" {
  run hub -h
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"enroll"* ]]
  [[ "${output}" == *"ca-init"* ]]
}

@test "enroll -h prints enroll usage" {
  run hub enroll -h
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"advertise-host"* ]]
}

@test "enroll refuses missing args" {
  run hub enroll
  [ "${status}" -ne 0 ]
  run hub enroll only-name
  [ "${status}" -ne 0 ]
}

@test "renew refuses missing args" {
  run hub renew
  [ "${status}" -ne 0 ]
}

@test "unknown command is refused" {
  run hub definitely-not-a-command
  [ "${status}" -ne 0 ]
}

@test "enroll refuses invalid node names" {
  hub ca-init
  run hub enroll 'NodeA' 192.0.2.10
  [ "${status}" -ne 0 ]
  run hub enroll 'foo_bar' 192.0.2.10
  [ "${status}" -ne 0 ]
  run hub enroll 'foo.bar' 192.0.2.10
  [ "${status}" -ne 0 ]
  run hub enroll --not-a-name 192.0.2.10
  [ "${status}" -ne 0 ]
  run hub enroll 'node-a-' 192.0.2.10
  [ "${status}" -ne 0 ]
}

@test "enroll accepts [a-z0-9-]* names that do not trail a hyphen" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >"${TEST_TMP}/out" 2>"${TEST_TMP}/err"
  enroll_rc=$?
  [ "${enroll_rc}" -eq 0 ]
  [ -s "${TEST_TMP}/out" ]
}

# ---------------------------------------------------------------------------
# ca-init idempotence / --force
# ---------------------------------------------------------------------------

@test "ca-init creates layout and does not overwrite without --force" {
  hub ca-init
  [ -f "${RIVETHUB_ROOT}/ca-root/ca.key" ]
  [ -f "${RIVETHUB_ROOT}/shared/rivet-ca/intermediate/int.crt" ]
  [ -f "${RIVETHUB_ROOT}/shared/rivet-ca/intermediate/ca-chain.pem" ]
  printf 'MARKER\n' >>"${RIVETHUB_ROOT}/ca-root/ca.key"
  hub ca-init
  grep -q MARKER "${RIVETHUB_ROOT}/ca-root/ca.key"
}

@test "ca-init --force recreates the CA and clears issued leaves" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >"${TEST_TMP}/out" 2>"${TEST_TMP}/err"
  [ -f "${RIVETHUB_ROOT}/shared/rivet-ca/issued/node-a.key" ]
  printf 'MARKER\n' >>"${RIVETHUB_ROOT}/ca-root/ca.key"
  hub ca-init --force
  ! grep -q MARKER "${RIVETHUB_ROOT}/ca-root/ca.key"
  [ -f "${RIVETHUB_ROOT}/ca-root/ca.key" ]
  [ -f "${RIVETHUB_ROOT}/shared/rivet-ca/intermediate/int.crt" ]
  [ ! -f "${RIVETHUB_ROOT}/shared/rivet-ca/issued/node-a.key" ]
}

# ---------------------------------------------------------------------------
# mesh.json merge under lock (sequential enrolls)
# ---------------------------------------------------------------------------

@test "two sequential enrolls preserve both mesh.json entries" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >"${TEST_TMP}/a.b64" 2>"${TEST_TMP}/a.err"
  hub enroll node-b 192.0.2.11 >"${TEST_TMP}/b.b64" 2>"${TEST_TMP}/b.err"
  mesh="${RIVETHUB_ROOT}/shared/mesh.json"
  [ -f "${mesh}" ]
  python3 - "${mesh}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert isinstance(data["version"], int)
assert isinstance(data["updatedAt"], int)
assert isinstance(data["nodes"], dict), "nodes must be a record, not an array"
assert "node-a" in data["nodes"]
assert "node-b" in data["nodes"]
a = data["nodes"]["node-a"]
b = data["nodes"]["node-b"]
for n, host in ((a, "192.0.2.10"), (b, "192.0.2.11")):
    assert n["id"] in ("node-a", "node-b")
    assert n["name"]
    assert n["host"] == host
    assert isinstance(n["port"], int)
    assert n["status"]
print("ok")
PY
}

@test "re-enroll updates host and keeps the other node" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >/dev/null 2>"${TEST_TMP}/e1.err"
  hub enroll node-b 192.0.2.11 >/dev/null 2>"${TEST_TMP}/e2.err"
  hub enroll node-a 192.0.2.99 >/dev/null 2>"${TEST_TMP}/e3.err"
  python3 - "${RIVETHUB_ROOT}/shared/mesh.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert set(data["nodes"]) == {"node-a", "node-b"}
assert data["nodes"]["node-a"]["host"] == "192.0.2.99"
assert data["nodes"]["node-b"]["host"] == "192.0.2.11"
PY
}

# ---------------------------------------------------------------------------
# tarball contract
# ---------------------------------------------------------------------------

@test "enroll stdout is only a base64 tarball with the expected members" {
  hub ca-init
  mkdir -p "${TEST_TMP}/bundle"
  hub enroll node-a 192.0.2.10 >"${TEST_TMP}/out" 2>"${TEST_TMP}/err"
  [ -s "${TEST_TMP}/out" ]
  grep -q "rivethub-hub:" "${TEST_TMP}/err"
  # stdout must not contain the log prefix or CA chatter (fixture is noisy)
  ! grep -q "rivethub-hub:" "${TEST_TMP}/out"
  ! grep -q "issued cert" "${TEST_TMP}/out"
  ! grep -q "openssl chatter" "${TEST_TMP}/out"
  grep -qE 'issued cert|openssl chatter' "${TEST_TMP}/err"
  listing="$(base64 -d <"${TEST_TMP}/out" | tar -tzf - | sed 's|^\./||' | sort | tr -d '\r')"
  expected="$(printf '%s\n' ca-chain.pem mesh.json node-a.crt node-a.key node-config-snippet.yaml)"
  [ "${listing}" = "${expected}" ]
  base64 -d <"${TEST_TMP}/out" | tar -xzf - -C "${TEST_TMP}/bundle"
  python3 - "${TEST_TMP}/bundle/mesh.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert "node-a" in data["nodes"]
assert data["nodes"]["node-a"]["host"] == "192.0.2.10"
assert data["nodes"]["node-a"]["id"] == "node-a"
PY
  grep -q "stub-crt-node-a-" "${TEST_TMP}/bundle/node-a.crt"
  grep -q "stub-key-node-a-" "${TEST_TMP}/bundle/node-a.key"
}

@test "renew of unknown node is refused" {
  hub ca-init
  run hub renew node-a
  [ "${status}" -ne 0 ]
}

@test "renew of enrolled node emits the same tarball members" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >/dev/null 2>"${TEST_TMP}/enroll.err"
  hub renew node-a >"${TEST_TMP}/out" 2>"${TEST_TMP}/renew.err"
  listing="$(base64 -d <"${TEST_TMP}/out" | tar -tzf - | sed 's|^\./||' | sort | tr -d '\r')"
  expected="$(printf '%s\n' ca-chain.pem mesh.json node-a.crt node-a.key node-config-snippet.yaml)"
  [ "${listing}" = "${expected}" ]
}

@test "renew re-issues a distinct leaf that still pairs" {
  hub ca-init
  mkdir -p "${TEST_TMP}/enroll" "${TEST_TMP}/renew"
  hub enroll node-a 192.0.2.10 >"${TEST_TMP}/enroll.b64" 2>"${TEST_TMP}/enroll.err"
  base64 -d <"${TEST_TMP}/enroll.b64" | tar -xzf - -C "${TEST_TMP}/enroll"
  hub renew node-a >"${TEST_TMP}/renew.b64" 2>"${TEST_TMP}/renew.err"
  base64 -d <"${TEST_TMP}/renew.b64" | tar -xzf - -C "${TEST_TMP}/renew"
  ! cmp -s "${TEST_TMP}/enroll/node-a.crt" "${TEST_TMP}/renew/node-a.crt"
  ! cmp -s "${TEST_TMP}/enroll/node-a.key" "${TEST_TMP}/renew/node-a.key"
  enroll_nonce="$(sed -n 's/^stub-crt-node-a-//p' "${TEST_TMP}/enroll/node-a.crt")"
  renew_nonce="$(sed -n 's/^stub-crt-node-a-//p' "${TEST_TMP}/renew/node-a.crt")"
  [ -n "${enroll_nonce}" ]
  [ -n "${renew_nonce}" ]
  [ "${enroll_nonce}" != "${renew_nonce}" ]
  grep -qx "stub-key-node-a-${enroll_nonce}" "${TEST_TMP}/enroll/node-a.key"
  grep -qx "stub-key-node-a-${renew_nonce}" "${TEST_TMP}/renew/node-a.key"
}

@test "mesh-export prints current mesh.json" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >/dev/null 2>"${TEST_TMP}/e.err"
  hub mesh-export >"${TEST_TMP}/exported.json"
  python3 - "${TEST_TMP}/exported.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert "node-a" in data["nodes"]
PY
}

@test "mesh-export refuses when mesh.json is missing" {
  run hub mesh-export
  [ "${status}" -ne 0 ]
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

@test "status reports absent CA on a fresh root" {
  run hub status
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"ca root:       absent"* ]]
  [[ "${output}" == *"mesh.json:     absent"* ]]
  [[ "${output}" == *"users.json:    absent"* ]]
}

@test "status reports users.json valid vs invalid" {
  hub ca-init
  mkdir -p "${RIVETHUB_ROOT}/shared/rivetos"
  printf '{ "ok": true }\n' >"${RIVETHUB_ROOT}/shared/rivetos/users.json"
  run hub status
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"users.json:    present  valid"* ]]
  [[ "${output}" == *"${RIVETHUB_ROOT}/shared/rivetos/users.json"* ]]
  printf 'not-json\n' >"${RIVETHUB_ROOT}/shared/rivetos/users.json"
  run hub status
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"users.json:    present  invalid JSON"* ]]
}

@test "status does not look at shared/users.json (installer path is shared/rivetos/users.json)" {
  hub ca-init
  mkdir -p "${RIVETHUB_ROOT}/shared"
  printf '{ "ok": true }\n' >"${RIVETHUB_ROOT}/shared/users.json"
  run hub status
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"users.json:    absent"* ]]
  [[ "${output}" == *"/shared/rivetos/users.json"* ]]
  mkdir -p "${RIVETHUB_ROOT}/shared/rivetos"
  printf '{ "ok": true }\n' >"${RIVETHUB_ROOT}/shared/rivetos/users.json"
  run hub status
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"users.json:    present  valid"* ]]
}

@test "status mesh.json path matches enroll" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >/dev/null 2>"${TEST_TMP}/e.err"
  [ -f "${RIVETHUB_ROOT}/shared/mesh.json" ]
  run hub status
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"mesh.json:     present"* ]]
  [[ "${output}" == *"${RIVETHUB_ROOT}/shared/mesh.json"* ]]
}

@test "snippet names the node and distro shared-dir placeholder" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >"${TEST_TMP}/out" 2>"${TEST_TMP}/err"
  base64 -d <"${TEST_TMP}/out" | tar -xzf - -C "${TEST_TMP}"
  grep -q 'node_name: "node-a"' "${TEST_TMP}/node-config-snippet.yaml"
  grep -q 'storage_dir: "/var/lib/rivethub/shared"' "${TEST_TMP}/node-config-snippet.yaml"
  grep -q 'seed_host: "192.0.2.1"' "${TEST_TMP}/node-config-snippet.yaml"
}

# ---------------------------------------------------------------------------
# stdout contract, SANs, key modes, validation (fix round 1)
# ---------------------------------------------------------------------------

@test "enroll/renew failure leaves stdout empty" {
  hub enroll Bad 192.0.2.1 >"${TEST_TMP}/bad.out" 2>"${TEST_TMP}/bad.err" || true
  [ ! -s "${TEST_TMP}/bad.out" ]
  hub enroll node-a 192.0.2.1 >"${TEST_TMP}/noca.out" 2>"${TEST_TMP}/noca.err" || true
  [ ! -s "${TEST_TMP}/noca.out" ]
  hub ca-init
  hub renew node-z >"${TEST_TMP}/unknown.out" 2>"${TEST_TMP}/unknown.err" || true
  [ ! -s "${TEST_TMP}/unknown.out" ]
}

@test "enroll refuses an invalid dotted-quad advertise-host" {
  hub ca-init
  hub enroll node-a 999.999.999.999 >"${TEST_TMP}/out" 2>"${TEST_TMP}/err" || true
  [ ! -s "${TEST_TMP}/out" ]
  grep -q "valid IPv4" "${TEST_TMP}/err"
}

@test "issue-node is called with the exact SAN list" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >"${TEST_TMP}/out" 2>"${TEST_TMP}/err"
  [ -f "${TEST_TMP}/ca-last-sans" ]
  expected="$(printf '%s\n' 'DNS:node-a.mesh' 'IP:192.0.2.10' 'IP:127.0.0.1')"
  [ "$(cat "${TEST_TMP}/ca-last-sans")" = "${expected}" ]
  grep -q '^cmd=issue-node$' "${TEST_TMP}/ca-last-invoke"
  grep -q "^RIVET_CA_ROOT_DIR=${RIVETHUB_ROOT}/ca-root$" "${TEST_TMP}/ca-last-invoke"
  grep -q "^RIVET_CA_SHARED_DIR=${RIVETHUB_ROOT}/shared/rivet-ca$" "${TEST_TMP}/ca-last-invoke"
}

@test "hostname advertise-host is passed as a DNS SAN" {
  hub ca-init
  hub enroll node-b node-b.example >"${TEST_TMP}/out" 2>"${TEST_TMP}/err"
  expected="$(printf '%s\n' 'DNS:node-b.mesh' 'DNS:node-b.example' 'IP:127.0.0.1')"
  [ "$(cat "${TEST_TMP}/ca-last-sans")" = "${expected}" ]
}

@test "issued private keys are mode 0600 and issued dir is 0700" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >"${TEST_TMP}/out" 2>"${TEST_TMP}/err"
  key="${RIVETHUB_ROOT}/shared/rivet-ca/issued/node-a.key"
  dir="${RIVETHUB_ROOT}/shared/rivet-ca/issued"
  [ "$(stat -c %a "${key}")" = "600" ]
  [ "$(stat -c %a "${dir}")" = "700" ]
}

@test "concurrent enrolls keep mesh.json valid with both nodes" {
  hub ca-init
  hub enroll node-a 192.0.2.10 >"${TEST_TMP}/a.b64" 2>"${TEST_TMP}/a.err" &
  hub enroll node-b 192.0.2.11 >"${TEST_TMP}/b.b64" 2>"${TEST_TMP}/b.err" &
  wait
  python3 - "${RIVETHUB_ROOT}/shared/mesh.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert isinstance(data, dict)
assert isinstance(data["nodes"], dict)
assert "node-a" in data["nodes"], data["nodes"].keys()
assert "node-b" in data["nodes"], data["nodes"].keys()
assert data["nodes"]["node-a"]["host"] == "192.0.2.10"
assert data["nodes"]["node-b"]["host"] == "192.0.2.11"
PY
}

@test "mesh-export refuses extra args" {
  run hub mesh-export extra
  [ "${status}" -ne 0 ]
}

@test "status refuses extra args" {
  run hub status extra
  [ "${status}" -ne 0 ]
}

@test "mesh.json that is not an object is refused without a traceback on stdout" {
  hub ca-init
  printf '[]\n' >"${RIVETHUB_ROOT}/shared/mesh.json"
  hub enroll node-a 192.0.2.10 >"${TEST_TMP}/out" 2>"${TEST_TMP}/err" || true
  [ ! -s "${TEST_TMP}/out" ]
  ! grep -q "Traceback" "${TEST_TMP}/out"
  ! grep -q "Traceback" "${TEST_TMP}/err"
  grep -q "not an object" "${TEST_TMP}/err"
}
