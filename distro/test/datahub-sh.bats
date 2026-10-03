#!/usr/bin/env bats
# Pure-logic tests for install/datahub.sh. Apt/psql/systemctl are fakes in
# PATH. No real postgres, docker, or CA. Requires bats; tests avoid
# `run --separate-stderr`. Reviewer: chmod +x is not required (invoked via bash).

DATAHUB="${BATS_TEST_DIRNAME}/../install/datahub.sh"
REPO="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
STUB_CA="${BATS_TEST_DIRNAME}/fixtures/rivet-ca.sh"
MIG_FIXTURE="${BATS_TEST_DIRNAME}/fixtures/migrations"

setup() {
  TEST_TMP="$(mktemp -d)"
  export TEST_TMP
  export RIVETHUB_TEST=1
  export RIVETHUB_ROOT="${TEST_TMP}/hub"
  export RIVETHUB_DISTRO_DIR="${REPO}"
  export RIVETHUB_MIGRATIONS_DIR="${MIG_FIXTURE}"
  export RIVETHUB_BIN_DIR="${TEST_TMP}/usr/bin"
  export RIVETHUB_LIB_DIR="${TEST_TMP}/usr/lib/rivethub"
  export RIVETHUB_SYSTEMD_DIR="${TEST_TMP}/systemd"
  export RIVETHUB_CA_SCRIPT="${STUB_CA}"
  export RIVETHUB_OS_RELEASE="${BATS_TEST_DIRNAME}/fixtures/os-release-debian"
  export RIVETHUB_ADVERTISE_HOST="192.0.2.10"
  # Fleet / operator env must not skip wizard URL prompts or fill defaults.
  unset RIVETHUB_OWNER RIVETHUB_MEMORY RIVETHUB_INSTALL_MODE RIVETHUB_PG_PORT
  unset RIVETHUB_PROMPT_IN
  unset RIVETOS_EMBED_URL RIVETOS_EMBED_MODEL RIVETOS_COMPACTOR_URL RIVETOS_COMPACTOR_MODEL

  mkdir -p "${TEST_TMP}/bin" "${RIVETHUB_BIN_DIR}" "${RIVETHUB_LIB_DIR}" "${RIVETHUB_SYSTEMD_DIR}"
  cat >"${TEST_TMP}/bin/psql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${TEST_TMP}/applied"
echo "psql $*" >>"${TEST_TMP}/psql.log"
sql=""
has_file=0
has_c=0
args=("$@")
i=0
while [[ ${i} -lt ${#args[@]} ]]; do
  a="${args[$i]}"
  if [[ "${a}" == "-f" ]]; then
    i=$((i + 1))
    has_file=1
    sql+="$(cat "${args[$i]}")"$'\n'
  elif [[ "${a}" == "-c" || "${a}" == "-tAc" || "${a}" == "-cSELECT"* ]]; then
    i=$((i + 1))
    has_c=1
    sql+="${args[$i]}"$'\n'
  fi
  i=$((i + 1))
done
if [[ "${has_file}" -eq 0 && "${has_c}" -eq 0 ]]; then
  sql+="$(cat || true)"
fi
echo "${sql}" >>"${TEST_TMP}/psql.sql"
# Keep EREs in variables. An inline [[ =~ ]] pattern that contains ) is a
# bash syntax error (unexpected token `)`), which fired on every psql call
# once INSERT listed (name, checksum).
sel_re=$'SELECT[[:space:]]+1[[:space:]]+FROM[[:space:]]+_rivetos_migrations[[:space:]]+WHERE[[:space:]]+name[[:space:]]*=[[:space:]]*\'([^\']+)\''
ins_re=$'INSERT[[:space:]]+INTO[[:space:]]+_rivetos_migrations[[:space:]]*\\([^)]*\\)[[:space:]]*VALUES[[:space:]]*\\([[:space:]]*\'([^\']+)\''
if [[ "${sql}" =~ ${sel_re} ]]; then
  name="${BASH_REMATCH[1]}"
  if [[ -f "${TEST_TMP}/applied/${name}" ]]; then
    printf '1\n'
  fi
  exit 0
fi
while [[ "${sql}" =~ ${ins_re} ]]; do
  name="${BASH_REMATCH[1]}"
  touch "${TEST_TMP}/applied/${name}"
  sql="${sql#*"${BASH_REMATCH[0]}"}"
done
exit 0
EOF
  chmod +x "${TEST_TMP}/bin/psql"
  export PATH="${TEST_TMP}/bin:${PATH}"
}

teardown() {
  rm -rf "${TEST_TMP}"
}

# Source datahub.sh in a subshell and run a function (does not invoke main).
src() {
  bash -c '
    source "$1"
    shift
    "$@"
  ' bash "${DATAHUB}" "$@"
}

parse_print() {
  bash -c '
    source "$1"
    shift
    parse_args "$@"
    printf "docker=%s memory=%s owner=%s host=%s help=%s yes=%s force=%s pgport=%s rootset=%s memset=%s modeset=%s\n" \
      "${FLAG_DOCKER}" "${MEMORY_MODE}" "${OWNER_ID}" "${ADVERTISE_HOST}" "${FLAG_HELP}" \
      "${FLAG_YES}" "${FLAG_FORCE}" "${PG_PORT}" "${ROOT_SET}" "${MEMORY_SET}" "${INSTALL_MODE_SET}"
  ' bash "${DATAHUB}" "$@"
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------

@test "-h prints usage mentioning docker, memory, and node.sh enrollment" {
  run bash "${DATAHUB}" -h
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"--docker"* ]]
  [[ "${output}" == *"--memory"* ]]
  [[ "${output}" == *"datahub"* ]]
}

@test "unknown option is refused" {
  run bash "${DATAHUB}" --not-a-flag
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"unknown option"* ]]
}

@test "unexpected positional is refused" {
  run bash "${DATAHUB}" leftover
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"unexpected argument"* ]]
}

@test "parse_args records --docker --memory full --owner --advertise-host" {
  out="$(parse_print --docker --memory full --owner alice --advertise-host 192.0.2.10)"
  [[ "${out}" == *"docker=1"* ]]
  [[ "${out}" == *"memory=full"* ]]
  [[ "${out}" == *"owner=alice"* ]]
  [[ "${out}" == *"host=192.0.2.10"* ]]
}

@test "parse_args defaults are bare-metal memory-lite owner" {
  out="$(parse_print)"
  [[ "${out}" == *"docker=0"* ]]
  [[ "${out}" == *"memory=lite"* ]]
  [[ "${out}" == *"owner=owner"* ]]
}

@test "--memory=full equals --memory full" {
  out="$(parse_print --memory=full)"
  [[ "${out}" == *"memory=full"* ]]
}

@test "--memory without a value is refused" {
  run parse_print --memory
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"--memory requires"* ]]
}

@test "--memory bogus is refused" {
  run parse_print --memory bogus
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"lite' or 'full"* ]]
}

@test "invalid --owner is refused" {
  run parse_print --owner 'bad id'
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"invalid --owner"* ]]
}

# ---------------------------------------------------------------------------
# preflight refusals
# ---------------------------------------------------------------------------

@test "preflight_tools refuses when curl is missing" {
  run bash -c '
    export PATH="$1"
    source "$2"
    init_paths
    preflight_tools
  ' bash "${TEST_TMP}/empty-path" "${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"missing required tools"* ]]
}

@test "preflight_os warns (does not block) on a non-Debian ID" {
  run bash -c '
    source "$1"
    export RIVETHUB_OS_RELEASE="$2"
    init_paths
    preflight_os
  ' bash "${DATAHUB}" "${BATS_TEST_DIRNAME}/fixtures/os-release-other"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"warning"* ]]
  [[ "${output}" == *"Debian 12 / Ubuntu LTS"* ]]
}

@test "preflight_os accepts Debian 12" {
  run src preflight_os
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"Debian GNU/Linux 12"* ]]
  [[ "${output}" != *"warning"* ]]
}

# ---------------------------------------------------------------------------
# banner
# ---------------------------------------------------------------------------

@test "banner names node.sh, user@this-host, password file path, and rivethub-hub status" {
  run bash -c '
    source "$1"
    init_paths
    FLAG_DOCKER=0
    MEMORY_MODE=lite
    ADVERTISE_HOST=192.0.2.10
    OWNER_ID=owner
    print_banner
  ' bash "${DATAHUB}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"get.rivethub.io/node.sh | sudo bash"* ]]
  [[ "${output}" != *"not published"* ]]
  [[ "${output}" == *"user@this-host"* ]]
  [[ "${output}" == *"password file:"* ]]
  [[ "${output}" == *"${RIVETHUB_ROOT}/datahub.env"* ]]
  [[ "${output}" == *"rivethub-hub status"* ]]
  [[ "${output}" == *"bare-metal"* ]]
  [[ "${output}" == *"owner=owner"* ]]
}

@test "banner does not print the postgres password" {
  bash -c '
    source "$1"
    init_paths
    ensure_layout
    write_datahub_env "cafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeef"
    FLAG_DOCKER=0
    MEMORY_MODE=lite
    ADVERTISE_HOST=192.0.2.10
    print_banner
  ' bash "${DATAHUB}" >"${TEST_TMP}/banner.out" 2>"${TEST_TMP}/banner.err"
  ! grep -q "cafebabedeadbeef" "${TEST_TMP}/banner.out"
  ! grep -q "cafebabedeadbeef" "${TEST_TMP}/banner.err"
  grep -q "datahub.env" "${TEST_TMP}/banner.out"
}

@test "banner for --memory full includes the runtime TODO" {
  run bash -c '
    source "$1"
    init_paths
    FLAG_DOCKER=1
    MEMORY_MODE=full
    ADVERTISE_HOST=192.0.2.10
    print_banner
  ' bash "${DATAHUB}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"docker"* ]]
  [[ "${output}" == *"TODO"* ]]
  [[ "${output}" == *"rivet-embedder"* ]]
}

# ---------------------------------------------------------------------------
# migration ordering
# ---------------------------------------------------------------------------

@test "list_migration_names is lexical *.sql only" {
  out="$(src list_migration_names "${MIG_FIXTURE}")"
  expected="$(printf '%s\n' 0001_first.sql 0002_later.sql)"
  [ "${out}" = "${expected}" ]
}

@test "list_migration_names ignores non-sql files" {
  mkdir -p "${TEST_TMP}/migs"
  printf -- '-- a\n' >"${TEST_TMP}/migs/0002_zzz.sql"
  printf -- '-- b\n' >"${TEST_TMP}/migs/0001_aaa.sql"
  printf 'nope\n' >"${TEST_TMP}/migs/README.md"
  printf -- '-- c\n' >"${TEST_TMP}/migs/notes.txt"
  out="$(src list_migration_names "${TEST_TMP}/migs")"
  expected="$(printf '%s\n' 0001_aaa.sql 0002_zzz.sql)"
  [ "${out}" = "${expected}" ]
}

@test "apply_migrations records names in _rivetos_migrations and is idempotent" {
  bash -c '
    source "$1"
    init_paths
    ensure_layout
    write_datahub_env aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
    apply_migrations
    apply_migrations
  ' bash "${DATAHUB}"
  [ -f "${TEST_TMP}/applied/0001_first.sql" ]
  [ -f "${TEST_TMP}/applied/0002_later.sql" ]
  # second apply should still only have those two markers (INSERT once)
  count="$(find "${TEST_TMP}/applied" -type f | wc -l)"
  [ "${count}" -eq 2 ]
}

# ---------------------------------------------------------------------------
# users.json shape (packages/types/src/users-registry.ts)
# ---------------------------------------------------------------------------

@test "write_users_json matches UsersRegistry with default owner" {
  bash -c '
    source "$1"
    init_paths
    ensure_layout
    write_users_json owner
  ' bash "${DATAHUB}"
  [ "$(stat -c %a "${RIVETHUB_ROOT}/shared/rivetos/users.json")" = "600" ]
  python3 - "${RIVETHUB_ROOT}/shared/rivetos/users.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["ownerUserId"] == "owner"
assert data["unmappedIsOwner"] is False
assert set(data["users"]) == {"owner"}
rec = data["users"]["owner"]
assert rec["id"] == "owner"
assert rec["devices"] == []
assert "db" not in rec
assert "pgUrl" not in rec
print("ok")
PY
}

@test "write_users_json --owner alice seeds that id" {
  bash -c '
    source "$1"
    init_paths
    ensure_layout
    write_users_json alice
  ' bash "${DATAHUB}"
  python3 - "${RIVETHUB_ROOT}/shared/rivetos/users.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["ownerUserId"] == "alice"
assert data["users"]["alice"]["id"] == "alice"
assert data["unmappedIsOwner"] is False
PY
}

@test "write_users_json is idempotent and will not clobber" {
  bash -c '
    source "$1"
    init_paths
    ensure_layout
    write_users_json owner
  ' bash "${DATAHUB}"
  python3 - "${RIVETHUB_ROOT}/shared/rivetos/users.json" <<'PY'
import json, sys
p = sys.argv[1]
data = json.load(open(p, encoding="utf-8"))
data["users"]["owner"]["devices"] = ["keep-me"]
open(p, "w", encoding="utf-8").write(json.dumps(data))
PY
  bash -c '
    source "$1"
    init_paths
    write_users_json other
  ' bash "${DATAHUB}"
  python3 - "${RIVETHUB_ROOT}/shared/rivetos/users.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["ownerUserId"] == "owner"
assert data["users"]["owner"]["devices"] == ["keep-me"]
PY
}

# ---------------------------------------------------------------------------
# env / password idempotence
# ---------------------------------------------------------------------------

@test "reuse_or_create_password keeps the first password across writes" {
  bash -c '
    source "$1"
    init_paths
    ensure_layout
    p=$(reuse_or_create_password)
    write_datahub_env "$p"
    printf "%s\n" "$p" >"$TEST_TMP/p1"
    p2=$(reuse_or_create_password)
    printf "%s\n" "$p2" >"$TEST_TMP/p2"
  ' bash "${DATAHUB}"
  [ -s "${TEST_TMP}/p1" ]
  [ "$(cat "${TEST_TMP}/p1")" = "$(cat "${TEST_TMP}/p2")" ]
  [ "$(stat -c %a "${RIVETHUB_ROOT}/datahub.env")" = "600" ]
  grep -q "^PGPASSWORD=$(cat "${TEST_TMP}/p1")$" "${RIVETHUB_ROOT}/datahub.env"
}

# ---------------------------------------------------------------------------
# stubbed installer (fakes in PATH) + rerun
# ---------------------------------------------------------------------------

@test "datahub_main stubbed install creates layout, env, users, hub, CA, banner" {
  bash "${DATAHUB}" --advertise-host 192.0.2.10 \
    >"${TEST_TMP}/main.out" 2>"${TEST_TMP}/main.err"
  [ -d "${RIVETHUB_ROOT}/shared" ]
  [ -d "${RIVETHUB_ROOT}/ca-root" ]
  [ "$(stat -c %a "${RIVETHUB_ROOT}/ca-root")" = "700" ]
  [ -f "${RIVETHUB_ROOT}/datahub.env" ]
  [ "$(stat -c %a "${RIVETHUB_ROOT}/datahub.env")" = "600" ]
  [ -f "${RIVETHUB_ROOT}/shared/rivetos/users.json" ]
  [ -f "${RIVETHUB_BIN_DIR}/rivethub-hub" ]
  [ -f "${RIVETHUB_LIB_DIR}/rivet-ca.sh" ]
  [ -f "${RIVETHUB_ROOT}/ca-root/ca.key" ]
  grep -q "user@this-host" "${TEST_TMP}/main.out"
  grep -q "rivethub-hub status" "${TEST_TMP}/main.out"
  grep -q "node.sh" "${TEST_TMP}/main.out"
  # password value must not appear on stdout or stderr
  pass="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  [ -n "${pass}" ]
  ! grep -F "${pass}" "${TEST_TMP}/main.out"
  ! grep -F "${pass}" "${TEST_TMP}/main.err"
  python3 - "${RIVETHUB_ROOT}/shared/rivetos/users.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["ownerUserId"] == "owner"
assert data["unmappedIsOwner"] is False
PY
}

@test "datahub_main rerun keeps the same password and users.json devices" {
  bash "${DATAHUB}" --advertise-host 192.0.2.10 >/dev/null 2>"${TEST_TMP}/e1.err"
  pass1="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  python3 - "${RIVETHUB_ROOT}/shared/rivetos/users.json" <<'PY'
import json, sys
p = sys.argv[1]
data = json.load(open(p, encoding="utf-8"))
data["users"]["owner"]["devices"] = ["device-a"]
open(p, "w", encoding="utf-8").write(json.dumps(data) + "\n")
PY
  bash "${DATAHUB}" --advertise-host 192.0.2.10 >/dev/null 2>"${TEST_TMP}/e2.err"
  pass2="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  [ "${pass1}" = "${pass2}" ]
  python3 - "${RIVETHUB_ROOT}/shared/rivetos/users.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["users"]["owner"]["devices"] == ["device-a"]
PY
}

@test "--docker writes rivethub-postgres.service and does not print the password" {
  bash "${DATAHUB}" --docker --advertise-host 192.0.2.10 \
    >"${TEST_TMP}/d.out" 2>"${TEST_TMP}/d.err"
  [ -f "${RIVETHUB_SYSTEMD_DIR}/rivethub-postgres.service" ]
  grep -q "pgvector/pgvector:pg16" "${RIVETHUB_SYSTEMD_DIR}/rivethub-postgres.service"
  grep -q "EnvironmentFile=" "${RIVETHUB_SYSTEMD_DIR}/rivethub-postgres.service"
  grep -q "docker" "${TEST_TMP}/d.out"
  grep -q "postgresql-client-16" "${TEST_TMP}/d.err"
  pass="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  ! grep -F "${pass}" "${TEST_TMP}/d.out"
  ! grep -F "${pass}" "${TEST_TMP}/d.err"
}

@test "--memory full without URLs on a non-TTY is refused" {
  unset RIVETOS_EMBED_URL RIVETOS_EMBED_MODEL RIVETOS_COMPACTOR_URL RIVETOS_COMPACTOR_MODEL
  run bash "${DATAHUB}" --memory full --advertise-host 192.0.2.10
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"RIVETOS_EMBED_URL"* ]]
  [[ "${output}" == *"RIVETOS_COMPACTOR_URL"* ]]
  [[ "${output}" == *"Unanswered questions"* ]]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "--memory full with env URLs installs worker units and writes env keys" {
  export RIVETOS_EMBED_URL="https://embed.example/v1"
  export RIVETOS_EMBED_MODEL="text-embedding-3-small"
  export RIVETOS_COMPACTOR_URL="https://llm.example/v1"
  export RIVETOS_COMPACTOR_MODEL="gpt-4o-mini-compaction-example"
  bash "${DATAHUB}" --memory full --advertise-host 192.0.2.10 \
    >"${TEST_TMP}/m.out" 2>"${TEST_TMP}/m.err"
  [ -f "${RIVETHUB_SYSTEMD_DIR}/rivet-embedder.service" ]
  [ -f "${RIVETHUB_SYSTEMD_DIR}/rivet-compactor.service" ]
  grep -q "^User=rivet$" "${RIVETHUB_SYSTEMD_DIR}/rivet-embedder.service"
  grep -q "EnvironmentFile=" "${RIVETHUB_SYSTEMD_DIR}/rivet-embedder.service"
  grep -q "^RIVETOS_EMBED_URL=https://embed.example/v1$" "${RIVETHUB_ROOT}/datahub.env"
  grep -q "^RIVETOS_COMPACTOR_URL=https://llm.example/v1$" "${RIVETHUB_ROOT}/datahub.env"
  grep -q "TODO" "${TEST_TMP}/m.out"
  [ "$(stat -c %a "${RIVETHUB_ROOT}/datahub.env")" = "600" ]
}

@test "UNPINNED pin without RIVETHUB_MIGRATIONS_DIR is a clear error" {
  unset RIVETHUB_MIGRATIONS_DIR
  run bash -c '
    source "$1"
    init_paths
    PINS_FILE="$2"
    migrations_source_dir
  ' bash "${DATAHUB}" "${BATS_TEST_DIRNAME}/fixtures/pins-unpinned.json"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"UNPINNED"* ]]
  [[ "${output}" == *"RIVETHUB_MIGRATIONS_DIR"* ]]
}

# ---------------------------------------------------------------------------
# B1 — bare-metal role SQL on stdin (not psql -f)
# ---------------------------------------------------------------------------

@test "ensure_postgres_role_db feeds role SQL on stdin so postgres can read a root 0600 file" {
  cat >"${TEST_TMP}/bin/runuser" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "runuser $*" >>"${TEST_TMP}/runuser.log"
while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done
shift || true
echo "psql-args: $*" >>"${TEST_TMP}/runuser.log"
if [[ " $* " == *" -f "* ]]; then
  echo "datahub.sh must not pass -f to runuser psql (postgres cannot read root 0600)" >&2
  exit 1
fi
{
  echo "=== stdin ==="
  cat
} >>"${TEST_TMP}/runuser.stdin"
exit 0
EOF
  chmod +x "${TEST_TMP}/bin/runuser"
  cat >"${TEST_TMP}/bin/pg_isready" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "${TEST_TMP}/bin/pg_isready"
  bash -c '
    unset RIVETHUB_TEST
    source "$1"
    init_paths
    FLAG_DOCKER=0
    ensure_layout
    write_datahub_env aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
    ensure_postgres_role_db
  ' bash "${DATAHUB}"
  [ -s "${TEST_TMP}/runuser.stdin" ]
  grep -q "CREATE ROLE rivetos LOGIN" "${TEST_TMP}/runuser.stdin"
  ! grep -q "SUPERUSER" "${TEST_TMP}/runuser.stdin"
  grep -q "psql-args:" "${TEST_TMP}/runuser.log"
  ! grep -q " -f " "${TEST_TMP}/runuser.log"
}

@test "bare-metal role SQL is LOGIN not SUPERUSER and creates extensions as postgres" {
  bash -c '
    source "$1"
    init_paths
    FLAG_DOCKER=0
    ensure_layout
    write_datahub_env aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
    ensure_postgres_role_db
  ' bash "${DATAHUB}"
  grep -q "CREATE ROLE rivetos LOGIN" "${TEST_TMP}/psql.sql"
  ! grep -q "SUPERUSER" "${TEST_TMP}/psql.sql"
  grep -q "CREATE EXTENSION IF NOT EXISTS vector" "${TEST_TMP}/psql.sql"
  grep -q "CREATE EXTENSION IF NOT EXISTS pg_trgm" "${TEST_TMP}/psql.sql"
}

# ---------------------------------------------------------------------------
# B2 — docker client + preflight without pg_isready
# ---------------------------------------------------------------------------

@test "install_postgres_docker installs postgresql-client-16 when psql is missing" {
  rm -f "${TEST_TMP}/bin/psql" "${TEST_TMP}/bin/pg_isready"
  cat >"${TEST_TMP}/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
echo "apt-get $*" >>"${TEST_TMP}/apt.log"
if [[ "$*" == *postgresql-client* ]]; then
  cat >"${TEST_TMP}/bin/psql" <<'PSQL'
#!/usr/bin/env bash
exit 0
PSQL
  chmod +x "${TEST_TMP}/bin/psql"
  cat >"${TEST_TMP}/bin/pg_isready" <<'PG'
#!/usr/bin/env bash
exit 0
PG
  chmod +x "${TEST_TMP}/bin/pg_isready"
fi
exit 0
EOF
  chmod +x "${TEST_TMP}/bin/apt-get"
  cat >"${TEST_TMP}/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >>"${TEST_TMP}/systemctl.log"
exit 0
EOF
  chmod +x "${TEST_TMP}/bin/systemctl"
  bash -c '
    unset RIVETHUB_TEST
    source "$1"
    init_paths
    FLAG_DOCKER=1
    # Hide a host psql/pg_isready so the client-install path is the one under test.
    have_cmd() {
      case "$1" in
        psql)
          [[ -x "${TEST_TMP}/bin/psql" ]]
          ;;
        pg_isready)
          [[ -x "${TEST_TMP}/bin/pg_isready" ]]
          ;;
        *)
          command -v "$1" >/dev/null 2>&1
          ;;
      esac
    }
    ensure_layout
    write_datahub_env aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
    install_postgres_docker
  ' bash "${DATAHUB}"
  grep -q "postgresql-client-16" "${TEST_TMP}/apt.log"
  [ -f "${RIVETHUB_SYSTEMD_DIR}/rivethub-postgres.service" ]
  grep -q "pgvector/pgvector:pg16" "${RIVETHUB_SYSTEMD_DIR}/rivethub-postgres.service"
  grep -q "daemon-reload" "${TEST_TMP}/systemctl.log"
}

@test "preflight_port accepts a docker-owned listener without pg_isready" {
  cat >"${TEST_TMP}/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "is-active" ]]; then
  exit 0
fi
exit 0
EOF
  chmod +x "${TEST_TMP}/bin/systemctl"
  rm -f "${TEST_TMP}/bin/pg_isready"
  run bash -c '
    unset RIVETHUB_TEST
    source "$1"
    init_paths
    FLAG_DOCKER=1
    port_5432_state() { printf "open\n"; }
    preflight_port
  ' bash "${DATAHUB}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"docker postgres"* ]]
}

@test "preflight_port refuses bare-metal when docker owns 5432" {
  cat >"${TEST_TMP}/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "is-active" ]]; then
  exit 0
fi
exit 0
EOF
  chmod +x "${TEST_TMP}/bin/systemctl"
  rm -f "${TEST_TMP}/bin/pg_isready"
  run bash -c '
    unset RIVETHUB_TEST
    source "$1"
    init_paths
    FLAG_DOCKER=0
    port_5432_state() { printf "open\n"; }
    preflight_port
  ' bash "${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"docker"* ]]
}

# ---------------------------------------------------------------------------
# B3 — curl-pipe / missing checkout before any write
# ---------------------------------------------------------------------------

@test "preflight_sources refuses empty DISTRO_ROOT before layout exists" {
  run bash -c '
    source "$1"
    init_paths
    DISTRO_ROOT=""
    preflight_sources
    ensure_layout
  ' bash "${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"cannot find bin/rivethub-hub"* ]]
  [[ "${output}" == *"refusing before any hub write"* ]]
  [ ! -d "${RIVETHUB_ROOT}/shared" ]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "preflight_sources refuses UNPINNED migrations before any write" {
  unset RIVETHUB_MIGRATIONS_DIR
  run bash -c '
    source "$1"
    unset RIVETHUB_MIGRATIONS_DIR
    init_paths
    PINS_FILE="$2"
    preflight_sources
    ensure_layout
  ' bash "${DATAHUB}" "${BATS_TEST_DIRNAME}/fixtures/pins-unpinned.json"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"UNPINNED"* ]]
  [ ! -d "${RIVETHUB_ROOT}/shared" ]
}

# Lay out a get.rivethub.io-shaped tree under TEST_TMP/pub (file:// base).
publish_bundle() {
  local pub="${TEST_TMP}/pub"
  mkdir -p "${pub}/bin" "${pub}/lib" "${pub}/systemd" "${pub}/pins"
  cp "${REPO}/bin/rivethub-hub" "${pub}/bin/"
  cp "${REPO}/lib/rivet-ca.sh" "${pub}/lib/"
  cp "${REPO}/systemd/rivet-embedder.service" "${REPO}/systemd/rivet-compactor.service" "${pub}/systemd/"
  cp "${REPO}/pins/stable.json" "${pub}/pins/"
  export RIVETHUB_BASE_URL="file://${pub}"
}

@test "pins/stable.json helper sha256 pins match the checked-in helpers" {
  run python3 -c '
import hashlib, json, sys
repo = sys.argv[1]
pins = json.load(open(repo + "/pins/stable.json", encoding="utf-8"))
for rel, key in (
    ("install/datahub.sh", "datahub_sh_sha256"),
    ("install/local.sh", "local_sh_sha256"),
    ("bin/rivethub-hub", "hub_helper_sha256"),
    ("lib/rivet-ca.sh", "rivet_ca_sha256"),
    ("systemd/rivet-embedder.service", "rivet_embedder_unit_sha256"),
    ("systemd/rivet-compactor.service", "rivet_compactor_unit_sha256"),
):
    got = hashlib.sha256(open(repo + "/" + rel, "rb").read()).hexdigest()
    assert pins.get(key) == got, "%s: pin %s != %s %s" % (key, pins.get(key), rel, got)
' "${REPO}"
  [ "${status}" -eq 0 ]
}

@test "curl-pipe (bash -s, no checkout) fetches verified helpers and installs" {
  publish_bundle
  unset RIVETHUB_DISTRO_DIR
  bash -s -- --yes --advertise-host 192.0.2.10 <"${DATAHUB}" \
    >"${TEST_TMP}/cp.out" 2>"${TEST_TMP}/cp.err"
  grep -q "sha256 verified" "${TEST_TMP}/cp.err"
  cmp "${REPO}/bin/rivethub-hub" "${RIVETHUB_BIN_DIR}/rivethub-hub"
  cmp "${REPO}/lib/rivet-ca.sh" "${RIVETHUB_LIB_DIR}/rivet-ca.sh"
  [ -f "${RIVETHUB_ROOT}/datahub.env" ]
  [ -f "${RIVETHUB_ROOT}/shared/rivetos/users.json" ]
}

@test "curl-pipe refuses a helper that does not match its pin, before any write" {
  publish_bundle
  unset RIVETHUB_DISTRO_DIR
  printf '\n# tampered\n' >>"${TEST_TMP}/pub/bin/rivethub-hub"
  run bash -s -- --yes --advertise-host 192.0.2.10 <"${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"checksum mismatch for bin/rivethub-hub"* ]]
  [ ! -d "${RIVETHUB_ROOT}/shared" ]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
  [ ! -f "${RIVETHUB_BIN_DIR}/rivethub-hub" ]
}

@test "curl-pipe refuses a helper with no sha256 pin" {
  publish_bundle
  unset RIVETHUB_DISTRO_DIR
  cp "${BATS_TEST_DIRNAME}/fixtures/pins-unpinned.json" "${TEST_TMP}/pub/pins/stable.json"
  run bash -s -- --yes --advertise-host 192.0.2.10 <"${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"is not a sha256"* ]]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "curl-pipe refuses when the pins file cannot be fetched" {
  unset RIVETHUB_DISTRO_DIR
  export RIVETHUB_BASE_URL="file://${TEST_TMP}/nope"
  run bash -s -- --yes --advertise-host 192.0.2.10 <"${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"could not fetch"* ]]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "--yes --memory full without a compaction model names RIVETOS_COMPACTOR_MODEL" {
  unset RIVETHUB_PROMPT_IN RIVETOS_COMPACTOR_MODEL
  export RIVETOS_EMBED_URL="https://embed.example/v1"
  export RIVETOS_COMPACTOR_URL="https://llm.example/v1"
  run bash "${DATAHUB}" --yes --memory full --advertise-host 192.0.2.10
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"Unanswered questions"* ]]
  [[ "${output}" == *"RIVETOS_COMPACTOR_MODEL"* ]]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "curl-pipe refuses a tampered worker unit too" {
  publish_bundle
  unset RIVETHUB_DISTRO_DIR
  printf '\n# tampered\n' >>"${TEST_TMP}/pub/systemd/rivet-compactor.service"
  run bash -s -- --yes --advertise-host 192.0.2.10 <"${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"checksum mismatch for systemd/rivet-compactor.service"* ]]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "a lone datahub.sh does not adopt ../bin planted beside its directory" {
  publish_bundle
  unset RIVETHUB_DISTRO_DIR
  mkdir -p "${TEST_TMP}/dl/x" "${TEST_TMP}/dl/bin" "${TEST_TMP}/dl/lib"
  cp "${DATAHUB}" "${TEST_TMP}/dl/x/datahub.sh"
  printf '#!/bin/sh\necho PLANTED\n' >"${TEST_TMP}/dl/bin/rivethub-hub"
  printf '#!/bin/sh\necho PLANTED\n' >"${TEST_TMP}/dl/lib/rivet-ca.sh"
  bash "${TEST_TMP}/dl/x/datahub.sh" --yes --advertise-host 192.0.2.10 \
    >"${TEST_TMP}/lone.out" 2>"${TEST_TMP}/lone.err"
  grep -q "sha256 verified" "${TEST_TMP}/lone.err"
  cmp "${REPO}/bin/rivethub-hub" "${RIVETHUB_BIN_DIR}/rivethub-hub"
  ! grep -q PLANTED "${TEST_TMP}/lone.out" "${TEST_TMP}/lone.err"
}

# A checkout-shaped tree under TEST_TMP/co with planted helpers.
planted_checkout() {
  mkdir -p "${TEST_TMP}/co/install" "${TEST_TMP}/co/bin" "${TEST_TMP}/co/lib"
  cp "${DATAHUB}" "${TEST_TMP}/co/install/datahub.sh"
  printf '#!/bin/sh\necho PLANTED\n' >"${TEST_TMP}/co/bin/rivethub-hub"
  printf '#!/bin/sh\necho PLANTED\n' >"${TEST_TMP}/co/lib/rivet-ca.sh"
}

@test "install/datahub.sh under a world-writable parent fetches instead of trusting siblings" {
  publish_bundle
  unset RIVETHUB_DISTRO_DIR
  planted_checkout
  chmod 1777 "${TEST_TMP}/co"
  bash "${TEST_TMP}/co/install/datahub.sh" --yes --advertise-host 192.0.2.10 \
    >"${TEST_TMP}/ww.out" 2>"${TEST_TMP}/ww.err"
  grep -q "not using the helpers in ${TEST_TMP}/co" "${TEST_TMP}/ww.err"
  grep -q "sha256 verified" "${TEST_TMP}/ww.err"
  cmp "${REPO}/bin/rivethub-hub" "${RIVETHUB_BIN_DIR}/rivethub-hub"
}

@test "a world-writable helper inside an otherwise private checkout is not trusted" {
  publish_bundle
  unset RIVETHUB_DISTRO_DIR
  planted_checkout
  chmod 0666 "${TEST_TMP}/co/bin/rivethub-hub"
  bash "${TEST_TMP}/co/install/datahub.sh" --yes --advertise-host 192.0.2.10 \
    >"${TEST_TMP}/wf.out" 2>"${TEST_TMP}/wf.err"
  grep -q "sha256 verified" "${TEST_TMP}/wf.err"
  cmp "${REPO}/bin/rivethub-hub" "${RIVETHUB_BIN_DIR}/rivethub-hub"
}

@test "trusted_path refuses a foreign owner and accepts root, us, and SUDO_UID" {
  mkdir -p "${TEST_TMP}/fake"
  cat >"${TEST_TMP}/fake/stat" <<'EOF'
#!/bin/sh
# stat -c %u|%a PATH — owner from FAKE_OWNER, mode fixed private.
case "$2" in
  %u) echo "${FAKE_OWNER}" ;;
  %a) echo 755 ;;
esac
EOF
  chmod +x "${TEST_TMP}/fake/stat"
  run env PATH="${TEST_TMP}/fake:${PATH}" FAKE_OWNER=4242 bash -c 'source "$1"; unset SUDO_UID; trusted_path /x' bash "${DATAHUB}"
  [ "${status}" -ne 0 ]
  run env PATH="${TEST_TMP}/fake:${PATH}" FAKE_OWNER=4242 SUDO_UID=4242 bash -c 'source "$1"; trusted_path /x' bash "${DATAHUB}"
  [ "${status}" -eq 0 ]
  run env PATH="${TEST_TMP}/fake:${PATH}" FAKE_OWNER=0 bash -c 'source "$1"; unset SUDO_UID; trusted_path /x' bash "${DATAHUB}"
  [ "${status}" -eq 0 ]
  run env PATH="${TEST_TMP}/fake:${PATH}" FAKE_OWNER="$(id -u)" bash -c 'source "$1"; unset SUDO_UID; trusted_path /x' bash "${DATAHUB}"
  [ "${status}" -eq 0 ]
}

# getent stand-in. By default every group is the caller's own per-user group
# (named after the caller, no members).
fake_getent() {
  mkdir -p "${TEST_TMP}/fake"
  cat >"${TEST_TMP}/fake/getent" <<'EOF'
#!/bin/sh
[ -z "${FAKE_GETENT_FAIL:-}" ] || exit 2
[ "$1" = group ] && echo "${FAKE_GROUP_NAME:-$(id -un)}:x:$2:${FAKE_MEMBERS:-}"
EOF
  chmod +x "${TEST_TMP}/fake/getent"
}

trusted_path_with() {
  run env PATH="${TEST_TMP}/fake:${PATH}" "$@" bash -c 'source "$1"; unset SUDO_UID; trusted_path "$2"' bash "${DATAHUB}" "${GW}"
}

@test "trusted_path accepts group-writable only for the owner's own per-user group" {
  fake_getent
  mkdir -p "${TEST_TMP}/gwd"
  : >"${TEST_TMP}/gwf"
  chmod 0775 "${TEST_TMP}/gwd"
  chmod 0664 "${TEST_TMP}/gwf"
  for GW in "${TEST_TMP}/gwd" "${TEST_TMP}/gwf"; do
    trusted_path_with A=1
    [ "${status}" -eq 0 ]
    trusted_path_with FAKE_GROUP_NAME=staff
    [ "${status}" -ne 0 ]
    trusted_path_with FAKE_MEMBERS=someoneelse
    [ "${status}" -ne 0 ]
    trusted_path_with FAKE_GETENT_FAIL=1
    [ "${status}" -ne 0 ]
  done
  chmod 0644 "${TEST_TMP}/gwf"
  GW="${TEST_TMP}/gwf"
  trusted_path_with FAKE_GROUP_NAME=staff
  [ "${status}" -eq 0 ]
}

@test "curl-pipe fetches are https-only outside test mode" {
  mkdir -p "${TEST_TMP}/fake"
  cat >"${TEST_TMP}/fake/curl" <<EOF
#!/bin/sh
echo "\$*" >>"${TEST_TMP}/curl.args"
exit 22
EOF
  chmod +x "${TEST_TMP}/fake/curl"
  run env -u RIVETHUB_TEST PATH="${TEST_TMP}/fake:${PATH}" TMPDIR="${TEST_TMP}" RIVETHUB_BASE_URL="https://get.example" \
    bash -c 'source "$1"; fetch_distro_bundle' bash "${DATAHUB}"
  [ "${status}" -ne 0 ]
  grep -q -- "--proto =https --proto-redir =https" "${TEST_TMP}/curl.args"
  rm -f "${TEST_TMP}/curl.args"
  run env -u RIVETHUB_TEST PATH="${TEST_TMP}/fake:${PATH}" TMPDIR="${TEST_TMP}" RIVETHUB_BASE_URL="http://get.example" \
    bash -c 'source "$1"; fetch_distro_bundle' bash "${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"must be an https:// URL"* ]]
  [ ! -f "${TEST_TMP}/curl.args" ]
}

@test "trusted_checkout covers systemd/ and pins/, files and directories" {
  mkdir -p "${TEST_TMP}/tc"
  cp -r "${REPO}/install" "${REPO}/bin" "${REPO}/lib" "${REPO}/pins" "${REPO}/systemd" "${TEST_TMP}/tc/"
  chmod -R go-w "${TEST_TMP}/tc"
  run bash -c 'source "$1"; unset SUDO_UID; trusted_checkout "$2"' bash "${DATAHUB}" "${TEST_TMP}/tc"
  [ "${status}" -eq 0 ]
  for p in systemd systemd/rivet-compactor.service pins/stable.json; do
    chmod o+w "${TEST_TMP}/tc/${p}"
    run bash -c 'source "$1"; unset SUDO_UID; trusted_checkout "$2"' bash "${DATAHUB}" "${TEST_TMP}/tc"
    [ "${status}" -ne 0 ]
    chmod o-w "${TEST_TMP}/tc/${p}"
  done
}

@test "resume with --memory full asks for the endpoints before the install, not after" {
  bash "${DATAHUB}" --advertise-host 192.0.2.10 >/dev/null 2>"${TEST_TMP}/r1.err"
  printf '%s\n' 'resume' >"${TEST_TMP}/answers"
  run env -u RIVETOS_EMBED_URL -u RIVETOS_EMBED_MODEL -u RIVETOS_COMPACTOR_URL -u RIVETOS_COMPACTOR_MODEL \
    RIVETHUB_PROMPT_IN="${TEST_TMP}/answers" bash -c '
      source "$1"
      parse_args --memory full --advertise-host 192.0.2.10
      init_paths
      run_wizard_flow
      echo REACHED-INSTALL
    ' bash "${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" != *"REACHED-INSTALL"* ]]
}

@test "a private checkout is used as is, without fetching" {
  unset RIVETHUB_DISTRO_DIR RIVETHUB_BASE_URL
  mkdir -p "${TEST_TMP}/priv"
  cp -r "${REPO}/install" "${REPO}/bin" "${REPO}/lib" "${REPO}/pins" "${REPO}/systemd" "${TEST_TMP}/priv/"
  chmod -R go-w "${TEST_TMP}/priv"
  bash "${TEST_TMP}/priv/install/datahub.sh" --yes --advertise-host 192.0.2.10 \
    >"${TEST_TMP}/pv.out" 2>"${TEST_TMP}/pv.err"
  ! grep -q "fetched helpers" "${TEST_TMP}/pv.err"
  cmp "${REPO}/bin/rivethub-hub" "${RIVETHUB_BIN_DIR}/rivethub-hub"
}

@test "--memory full with a RIVETHUB_DISTRO_DIR lacking systemd/ is refused before any write" {
  mkdir -p "${TEST_TMP}/nounits/bin" "${TEST_TMP}/nounits/lib"
  cp "${REPO}/bin/rivethub-hub" "${TEST_TMP}/nounits/bin/"
  cp "${REPO}/lib/rivet-ca.sh" "${TEST_TMP}/nounits/lib/"
  export RIVETHUB_DISTRO_DIR="${TEST_TMP}/nounits"
  export RIVETOS_EMBED_URL="https://embed.example/v1"
  export RIVETOS_COMPACTOR_URL="https://llm.example/v1"
  export RIVETOS_COMPACTOR_MODEL="gpt-4o-mini-compaction-example"
  run bash "${DATAHUB}" --yes --memory full --advertise-host 192.0.2.10
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"no systemd/rivet-embedder.service"* ]]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "a RIVETHUB_DISTRO_DIR without the helpers is refused before any write" {
  export RIVETHUB_DISTRO_DIR="${TEST_TMP}/typo"
  run bash "${DATAHUB}" --yes --advertise-host 192.0.2.10
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"check RIVETHUB_DISTRO_DIR"* ]]
  [ ! -d "${RIVETHUB_ROOT}/shared" ]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "re-run replaces a helper that differs and keeps the previous copy" {
  bash "${DATAHUB}" --yes --advertise-host 192.0.2.10 >/dev/null 2>&1
  printf '\n# old release\n' >>"${RIVETHUB_BIN_DIR}/rivethub-hub"
  run bash "${DATAHUB}" --yes --advertise-host 192.0.2.10
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"previous copy kept at"* ]]
  cmp "${REPO}/bin/rivethub-hub" "${RIVETHUB_BIN_DIR}/rivethub-hub"
  grep -q "old release" "${RIVETHUB_BIN_DIR}/rivethub-hub.prev"
  [ ! -x "${RIVETHUB_BIN_DIR}/rivethub-hub.prev" ]
  [ -x "${RIVETHUB_BIN_DIR}/rivethub-hub" ]
}

# ---------------------------------------------------------------------------
# B4 — checksum + pin tag
# ---------------------------------------------------------------------------

@test "apply_migrations INSERT includes sha256 checksum" {
  bash -c '
    source "$1"
    init_paths
    ensure_layout
    write_datahub_env aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
    apply_migrations
  ' bash "${DATAHUB}"
  grep -q "INSERT INTO _rivetos_migrations (name, checksum)" "${TEST_TMP}/psql.sql"
}

@test "apply_one_migration refuses a sidecar checksum mismatch" {
  mkdir -p "${TEST_TMP}/migs"
  printf -- '-- a\n' >"${TEST_TMP}/migs/0001_aaa.sql"
  printf 'deadbeef\n' >"${TEST_TMP}/migs/0001_aaa.sql.sha256"
  run bash -c '
    source "$1"
    init_paths
    ensure_layout
    write_datahub_env aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
    export RIVETHUB_MIGRATIONS_DIR="$2"
    apply_migrations
  ' bash "${DATAHUB}" "${TEST_TMP}/migs"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"checksum mismatch"* ]]
}

@test "valid_pin_tag accepts v1.2.3 and refuses traversal / query injection" {
  bash -c '
    source "$1"
    valid_pin_tag "v1.2.3" || exit 1
    valid_pin_tag "abc_def-0.1" || exit 1
    valid_pin_tag "../etc" && exit 1
    valid_pin_tag ".hidden" && exit 1
    valid_pin_tag ".." && exit 1
    valid_pin_tag "foo?ref=x" && exit 1
    valid_pin_tag "foo/bar" && exit 1
    exit 0
  ' bash "${DATAHUB}"
}

# ---------------------------------------------------------------------------
# CA root placement (hub + stub, not banner-only)
# ---------------------------------------------------------------------------

@test "datahub_main ca-init places root key under HUB_CA_ROOT" {
  bash "${DATAHUB}" --advertise-host 192.0.2.10 >/dev/null 2>&1
  [ -f "${RIVETHUB_ROOT}/ca-root/ca.key" ]
  [ "$(stat -c %a "${RIVETHUB_ROOT}/ca-root")" = "700" ]
  [ ! -f "${RIVETHUB_ROOT}/shared/ca.key" ]
  [ -f "${TEST_TMP}/ca-last-invoke" ]
  grep -q "^RIVET_CA_ROOT_DIR=${RIVETHUB_ROOT}/ca-root$" "${TEST_TMP}/ca-last-invoke"
}

# ---------------------------------------------------------------------------
# RIVETHUB_ADVERTISE_HOST + node ExecStart + ReadWritePaths
# ---------------------------------------------------------------------------

@test "parse_args reads RIVETHUB_ADVERTISE_HOST when flag is omitted" {
  out="$(RIVETHUB_ADVERTISE_HOST=192.0.2.99 parse_print)"
  [[ "${out}" == *"host=192.0.2.99"* ]]
}

@test "--memory full units use node from PATH and do not grant write on /opt/rivetos" {
  export RIVETOS_EMBED_URL="https://embed.example/v1"
  export RIVETOS_COMPACTOR_URL="https://llm.example/v1"
  export RIVETOS_COMPACTOR_MODEL="gpt-4o-mini-compaction-example"
  bash "${DATAHUB}" --memory full --advertise-host 192.0.2.10 \
    >/dev/null 2>"${TEST_TMP}/m2.err"
  grep -F "ReadWritePaths=/home/rivet ${RIVETHUB_ROOT}" "${RIVETHUB_SYSTEMD_DIR}/rivet-embedder.service"
  ! grep -E '^ReadWritePaths=.* /opt/rivetos' "${RIVETHUB_SYSTEMD_DIR}/rivet-embedder.service"
  grep -q "^ExecStart=" "${RIVETHUB_SYSTEMD_DIR}/rivet-embedder.service"
  grep -q "node" "${RIVETHUB_SYSTEMD_DIR}/rivet-embedder.service"
}

# ---------------------------------------------------------------------------
# C2b — wizard (RIVETHUB_PROMPT_IN is the injectable read seam)
# ---------------------------------------------------------------------------

@test "help mentions --yes, --force, --pg-port, and /dev/tty" {
  run bash "${DATAHUB}" -h
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"--yes"* ]]
  [[ "${output}" == *"--force"* ]]
  [[ "${output}" == *"--pg-port"* ]]
  [[ "${output}" == *"--data-root"* ]]
  [[ "${output}" == *"/dev/tty"* ]]
  [[ "${output}" == *"RIVETHUB_PROMPT_IN"* ]]
}

@test "parse_args records --yes --force --pg-port --data-root --bare-metal" {
  out="$(parse_print --yes --force --pg-port 5433 --data-root /var/lib/rivethub --bare-metal --owner bob)"
  [[ "${out}" == *"yes=1"* ]]
  [[ "${out}" == *"force=1"* ]]
  [[ "${out}" == *"pgport=5433"* ]]
  [[ "${out}" == *"docker=0"* ]]
  [[ "${out}" == *"modeset=1"* ]]
  [[ "${out}" == *"owner=bob"* ]]
  [[ "${out}" == *"rootset=1"* ]]
}

@test "-y is an alias of --yes" {
  out="$(parse_print -y)"
  [[ "${out}" == *"yes=1"* ]]
}

@test "--docker conflicts with --bare-metal" {
  run parse_print --docker --bare-metal
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"conflicts"* ]]
}

@test "invalid --pg-port is refused" {
  run parse_print --pg-port 0
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"invalid postgres port"* ]]
  run parse_print --pg-port 65536
  [ "${status}" -ne 0 ]
  run parse_print --pg-port abc
  [ "${status}" -ne 0 ]
}

@test "relative --data-root is refused" {
  run parse_print --data-root relative/path
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"invalid --data-root"* ]]
}

@test "RIVETHUB_MEMORY and RIVETHUB_INSTALL_MODE skip their prompts (env)" {
  out="$(RIVETHUB_MEMORY=full RIVETHUB_INSTALL_MODE=docker parse_print)"
  [[ "${out}" == *"memory=full"* ]]
  [[ "${out}" == *"memset=1"* ]]
  [[ "${out}" == *"docker=1"* ]]
  [[ "${out}" == *"modeset=1"* ]]
}

@test "RIVETHUB_OWNER and RIVETHUB_PG_PORT apply when flags are omitted" {
  out="$(RIVETHUB_OWNER=carol RIVETHUB_PG_PORT=15432 parse_print)"
  [[ "${out}" == *"owner=carol"* ]]
  [[ "${out}" == *"pgport=15432"* ]]
}

@test "--memory flag wins over RIVETHUB_MEMORY" {
  out="$(RIVETHUB_MEMORY=full parse_print --memory lite)"
  [[ "${out}" == *"memory=lite"* ]]
  [[ "${out}" == *"memset=1"* ]]
}

@test "prompt_line without a prompt source requires flags" {
  unset RIVETHUB_PROMPT_IN
  run bash -c '
    source "$1"
    prompt_line "Owner user id" "owner"
  ' bash "${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"cannot prompt"* ]]
  [[ "${output}" == *"flags"* ]]
}

@test "can_prompt is false in RIVETHUB_TEST without RIVETHUB_PROMPT_IN" {
  unset RIVETHUB_PROMPT_IN
  run bash -c '
    source "$1"
    if can_prompt; then
      echo can-prompt
      exit 0
    fi
    echo no-prompt
  ' bash "${DATAHUB}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"no-prompt"* ]]
}

@test "wizard reads scripted answers from RIVETHUB_PROMPT_IN" {
  # Fresh-flow order: owner, memory, base URL, embed model, compact model,
  # install mode, pg port, data root, then SUMMARY confirm. Bats setup
  # exports RIVETHUB_ROOT which parse_args would treat as ROOT_SET; clear
  # that flag so data-root is actually asked, while init_paths still uses
  # TEST_TMP/hub (so existing_datahub does not inspect /var/lib/rivethub).
  printf '%s\n' \
    'alice' \
    'full' \
    'https://embed.example/v1' \
    'text-embedding-3-small' \
    'gpt-4o-mini-compaction-example' \
    'docker' \
    '5433' \
    "${TEST_TMP}/hub" \
    'yes' \
    >"${TEST_TMP}/answers"
  out="$(
    unset RIVETHUB_OWNER RIVETHUB_MEMORY RIVETHUB_INSTALL_MODE RIVETHUB_PG_PORT
    unset RIVETOS_EMBED_URL RIVETOS_EMBED_MODEL RIVETOS_COMPACTOR_URL RIVETOS_COMPACTOR_MODEL
    RIVETHUB_PROMPT_IN="${TEST_TMP}/answers" bash -c '
      source "$1"
      parse_args
      ROOT_SET=0
      init_paths
      run_wizard_flow
      confirm_or_die
      printf "action=%s owner=%s memory=%s docker=%s pgport=%s embed=%s compact=%s root=%s\n" \
        "${WIZARD_ACTION}" "${OWNER_ID}" "${MEMORY_MODE}" "${FLAG_DOCKER}" "${PG_PORT}" \
        "${RIVETOS_EMBED_URL}" "${RIVETOS_COMPACTOR_URL}" "${RIVETHUB_ROOT}"
    ' bash "${DATAHUB}"
  )"
  [[ "${out}" == *"action=fresh"* ]]
  [[ "${out}" == *"owner=alice"* ]]
  [[ "${out}" == *"memory=full"* ]]
  [[ "${out}" == *"docker=1"* ]]
  [[ "${out}" == *"pgport=5433"* ]]
  [[ "${out}" == *"embed=https://embed.example/v1"* ]]
  [[ "${out}" == *"compact=https://embed.example/v1"* ]]
  [[ "${out}" == *"root=${TEST_TMP}/hub"* ]]
}

@test "wizard EOF on too-few answers names the unanswered question" {
  printf '%s\n' 'alice' >"${TEST_TMP}/answers"
  run env RIVETHUB_PROMPT_IN="${TEST_TMP}/answers" bash -c '
    unset RIVETHUB_OWNER RIVETHUB_MEMORY RIVETHUB_INSTALL_MODE RIVETHUB_PG_PORT
    source "$1"
    parse_args
    init_paths
    run_wizard_flow
  ' bash "${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"unanswered question"* ]]
  [[ "${output}" == *"Memory mode"* ]]
}

@test "flags skip their wizard prompts (remaining answers fill gaps)" {
  # --owner alice must not consume the first answer; first line is memory.
  printf '%s\n' \
    'full' \
    'https://embed.example/v1' \
    'text-embedding-3-small' \
    'gpt-4o-mini-compaction-example' \
    'docker' \
    '5433' \
    >"${TEST_TMP}/answers"
  out="$(
    RIVETHUB_PROMPT_IN="${TEST_TMP}/answers" bash -c '
      source "$1"
      parse_args --owner alice --pg-port 5432
      init_paths
      run_wizard_flow
      printf "owner=%s memory=%s docker=%s pgport=%s\n" \
        "${OWNER_ID}" "${MEMORY_MODE}" "${FLAG_DOCKER}" "${PG_PORT}"
    ' bash "${DATAHUB}"
  )"
  [[ "${out}" == *"owner=alice"* ]]
  [[ "${out}" == *"memory=full"* ]]
  [[ "${out}" == *"docker=1"* ]]
  # --pg-port 5432 skipped the port prompt, so 5433 in the file was NOT consumed
  [[ "${out}" == *"pgport=5432"* ]]
}

@test "print_summary names packages, services, paths, and secret locations" {
  run bash -c '
    source "$1"
    parse_args --docker --memory full --owner alice --pg-port 5433
    init_paths
    WIZARD_ACTION=fresh
    export RIVETOS_EMBED_URL="https://embed.example/v1"
    export RIVETOS_COMPACTOR_URL="https://llm.example/v1"
    export RIVETOS_EMBED_MODEL="text-embedding-3-small"
    export RIVETOS_COMPACTOR_MODEL="gpt-4o-mini-compaction-example"
    print_summary
  ' bash "${DATAHUB}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"SUMMARY"* ]]
  [[ "${output}" == *"owner:"*"alice"* ]]
  [[ "${output}" == *"memory:"*"full"* ]]
  [[ "${output}" == *"docker"* ]]
  [[ "${output}" == *"5433"* ]]
  [[ "${output}" == *"postgresql-client-16"* ]]
  [[ "${output}" == *"rivethub-postgres.service"* ]]
  [[ "${output}" == *"rivet-embedder.service"* ]]
  [[ "${output}" == *"datahub.env"* ]]
  [[ "${output}" == *"mode 0600"* ]]
  [[ "${output}" == *"never exported"* ]]
  [[ "${output}" == *"ca-root"* ]]
  [[ "${output}" == *"https://embed.example/v1"* ]]
}

@test "print_summary does not print a postgres password" {
  bash -c '
    source "$1"
    init_paths
    ensure_layout
    write_datahub_env "cafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeef"
    parse_args --memory lite
    print_summary
  ' bash "${DATAHUB}" >"${TEST_TMP}/sum.out" 2>"${TEST_TMP}/sum.err"
  ! grep -q "cafebabedeadbeef" "${TEST_TMP}/sum.out"
  ! grep -q "cafebabedeadbeef" "${TEST_TMP}/sum.err"
  grep -q "datahub.env" "${TEST_TMP}/sum.out"
}

@test "confirm_or_die --yes does not read a prompt" {
  : >"${TEST_TMP}/answers"
  RIVETHUB_PROMPT_IN="${TEST_TMP}/answers" bash -c '
    source "$1"
    FLAG_YES=1
    confirm_or_die
  ' bash "${DATAHUB}"
}

@test "confirm_or_die without --yes accepts yes and refuses no" {
  printf 'no\n' >"${TEST_TMP}/answers-no"
  run env RIVETHUB_PROMPT_IN="${TEST_TMP}/answers-no" bash -c '
    source "$1"
    FLAG_YES=0
    confirm_or_die
  ' bash "${DATAHUB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"aborted"* ]]

  printf 'yes\n' >"${TEST_TMP}/answers-yes"
  RIVETHUB_PROMPT_IN="${TEST_TMP}/answers-yes" bash -c '
    source "$1"
    FLAG_YES=0
    confirm_or_die
  ' bash "${DATAHUB}"
}

@test "wizard confirm no aborts before layout" {
  printf 'no\n' >"${TEST_TMP}/answers"
  export RIVETHUB_PROMPT_IN="${TEST_TMP}/answers"
  run bash "${DATAHUB}" --owner owner --memory lite --bare-metal --pg-port 5432 \
    --advertise-host 192.0.2.10
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"aborted"* ]]
  [ ! -d "${RIVETHUB_ROOT}/shared" ]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "--yes with a prompt source skips confirm and installs" {
  : >"${TEST_TMP}/answers"
  export RIVETHUB_PROMPT_IN="${TEST_TMP}/answers"
  bash "${DATAHUB}" --yes --owner owner --memory lite --bare-metal --pg-port 5432 \
    --advertise-host 192.0.2.10 \
    >"${TEST_TMP}/yes.out" 2>"${TEST_TMP}/yes.err"
  [ -d "${RIVETHUB_ROOT}/shared" ]
  [ -f "${RIVETHUB_ROOT}/datahub.env" ]
  [ "$(stat -c %a "${RIVETHUB_ROOT}/datahub.env")" = "600" ]
  grep -q "user@this-host" "${TEST_TMP}/yes.out"
  pass="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  [ -n "${pass}" ]
  ! grep -F "${pass}" "${TEST_TMP}/yes.out"
  ! grep -F "${pass}" "${TEST_TMP}/yes.err"
}

@test "datahub_main --yes without a prompt source matches the non-interactive contract" {
  unset RIVETHUB_PROMPT_IN
  bash "${DATAHUB}" --yes --advertise-host 192.0.2.10 \
    >"${TEST_TMP}/ny.out" 2>"${TEST_TMP}/ny.err"
  [ -d "${RIVETHUB_ROOT}/shared" ]
  [ -f "${RIVETHUB_ROOT}/datahub.env" ]
  [ -f "${RIVETHUB_ROOT}/shared/rivetos/users.json" ]
  grep -q "user@this-host" "${TEST_TMP}/ny.out"
  pass="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  ! grep -F "${pass}" "${TEST_TMP}/ny.out"
  ! grep -F "${pass}" "${TEST_TMP}/ny.err"
}

@test "existing install wizard abort leaves CA and password untouched" {
  bash "${DATAHUB}" --advertise-host 192.0.2.10 >/dev/null 2>"${TEST_TMP}/e0.err"
  pass1="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  [ -f "${RIVETHUB_ROOT}/ca-root/ca.key" ]
  printf 'abort\n' >"${TEST_TMP}/answers"
  export RIVETHUB_PROMPT_IN="${TEST_TMP}/answers"
  run bash "${DATAHUB}" --advertise-host 192.0.2.10
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"aborted"* ]]
  pass2="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  [ "${pass1}" = "${pass2}" ]
  [ -f "${RIVETHUB_ROOT}/ca-root/ca.key" ]
}

@test "existing install resume + --yes does not rotate the password" {
  bash "${DATAHUB}" --advertise-host 192.0.2.10 >/dev/null 2>"${TEST_TMP}/e1.err"
  pass1="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  : >"${TEST_TMP}/answers"
  export RIVETHUB_PROMPT_IN="${TEST_TMP}/answers"
  bash "${DATAHUB}" --yes --advertise-host 192.0.2.10 >/dev/null 2>"${TEST_TMP}/e2.err"
  pass2="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  [ "${pass1}" = "${pass2}" ]
}

@test "reuse_or_create_password rotates only with --force" {
  bash -c '
    source "$1"
    init_paths
    ensure_layout
    FLAG_FORCE=0
    p=$(reuse_or_create_password)
    write_datahub_env "$p"
    printf "%s\n" "$p" >"$TEST_TMP/p1"
    p2=$(reuse_or_create_password)
    printf "%s\n" "$p2" >"$TEST_TMP/p2"
    FLAG_FORCE=1
    p3=$(reuse_or_create_password)
    printf "%s\n" "$p3" >"$TEST_TMP/p3"
  ' bash "${DATAHUB}"
  [ "$(cat "${TEST_TMP}/p1")" = "$(cat "${TEST_TMP}/p2")" ]
  [ "$(cat "${TEST_TMP}/p1")" != "$(cat "${TEST_TMP}/p3")" ]
}

@test "--force on an existing docker install rotates the password in the database first" {
  bash "${DATAHUB}" --docker --yes --advertise-host 192.0.2.10 >/dev/null 2>"${TEST_TMP}/f1.err"
  pass1="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  : >"${TEST_TMP}/psql.sql"
  bash "${DATAHUB}" --docker --force --yes --advertise-host 192.0.2.10 >/dev/null 2>"${TEST_TMP}/f2.err"
  pass2="$(awk -F= '/^PGPASSWORD=/{print $2}' "${RIVETHUB_ROOT}/datahub.env")"
  [ "${pass1}" != "${pass2}" ]
  grep -q "ALTER ROLE rivetos WITH PASSWORD '${pass2//\'/}'" "${TEST_TMP}/psql.sql"
}

@test "--force on docker leaves datahub.env untouched when the rotation fails" {
  bash "${DATAHUB}" --docker --yes --advertise-host 192.0.2.10 >/dev/null 2>"${TEST_TMP}/f3.err"
  cp "${RIVETHUB_ROOT}/datahub.env" "${TEST_TMP}/env.before"
  printf '#!/bin/sh\nexit 1\n' >"${TEST_TMP}/bin/psql"
  run bash "${DATAHUB}" --docker --force --yes --advertise-host 192.0.2.10
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"could not rotate"* ]]
  cmp "${TEST_TMP}/env.before" "${RIVETHUB_ROOT}/datahub.env"
}

@test "--docker --pg-port 5433 writes that host port into the unit" {
  bash "${DATAHUB}" --docker --pg-port 5433 --yes --advertise-host 192.0.2.10 \
    >/dev/null 2>"${TEST_TMP}/p.err"
  grep -q "127.0.0.1:5433:5432" "${RIVETHUB_SYSTEMD_DIR}/rivethub-postgres.service"
}

@test "wizard reconfigure asks memory and not owner" {
  bash "${DATAHUB}" --advertise-host 192.0.2.10 >/dev/null 2>"${TEST_TMP}/e3.err"
  printf '%s\n' 'reconfigure' 'full' 'https://embed.example/v1' \
    'text-embedding-3-small' 'gpt-4o-mini-compaction-example' \
    >"${TEST_TMP}/answers"
  out="$(
    unset RIVETOS_EMBED_URL RIVETOS_EMBED_MODEL RIVETOS_COMPACTOR_URL RIVETOS_COMPACTOR_MODEL
    RIVETHUB_PROMPT_IN="${TEST_TMP}/answers" bash -c '
      source "$1"
      parse_args --advertise-host 192.0.2.10
      init_paths
      run_wizard_flow
      printf "action=%s owner=%s memory=%s embed=%s\n" \
        "${WIZARD_ACTION}" "${OWNER_ID}" "${MEMORY_MODE}" "${RIVETOS_EMBED_URL}"
    ' bash "${DATAHUB}"
  )"
  [[ "${out}" == *"action=reconfigure"* ]]
  [[ "${out}" == *"owner=owner"* ]]
  [[ "${out}" == *"memory=full"* ]]
  [[ "${out}" == *"embed=https://embed.example/v1"* ]]
}

# ---------------------------------------------------------------------------
# e2e F1/F2 — --yes defaults on non-TTY; batched unanswered questions
# ---------------------------------------------------------------------------

@test "--yes on non-TTY accepts documented defaults (no prompt source)" {
  unset RIVETHUB_PROMPT_IN RIVETHUB_OWNER RIVETHUB_MEMORY RIVETHUB_INSTALL_MODE RIVETHUB_PG_PORT
  out="$(
    bash -c '
      source "$1"
      parse_args --yes --advertise-host 192.0.2.10
      init_paths
      run_wizard_flow
      printf "action=%s owner=%s memory=%s docker=%s pgport=%s yes=%s\n" \
        "${WIZARD_ACTION}" "${OWNER_ID}" "${MEMORY_MODE}" "${FLAG_DOCKER}" "${PG_PORT}" "${FLAG_YES}"
    ' bash "${DATAHUB}"
  )"
  [[ "${out}" == *"owner=owner"* ]]
  [[ "${out}" == *"memory=lite"* ]]
  [[ "${out}" == *"docker=0"* ]]
  [[ "${out}" == *"pgport=5432"* ]]
  [[ "${out}" == *"yes=1"* ]]
}

@test "--yes --memory full without either URL lists both env names in one error" {
  unset RIVETHUB_PROMPT_IN RIVETOS_EMBED_URL RIVETOS_COMPACTOR_URL
  run bash "${DATAHUB}" --yes --memory full --advertise-host 192.0.2.10
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"Unanswered questions"* ]]
  [[ "${output}" == *"RIVETOS_EMBED_URL"* ]]
  [[ "${output}" == *"RIVETOS_COMPACTOR_URL"* ]]
  [ ! -d "${RIVETHUB_ROOT}/shared" ]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "--yes --memory full with only embed URL still names the missing compact URL" {
  unset RIVETHUB_PROMPT_IN RIVETOS_COMPACTOR_URL
  export RIVETOS_EMBED_URL="https://embed.example/v1"
  run bash "${DATAHUB}" --yes --memory full --advertise-host 192.0.2.10
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"Unanswered questions"* ]]
  [[ "${output}" == *"RIVETOS_COMPACTOR_URL"* ]]
  [[ "${output}" != *"RIVETOS_EMBED_URL"* ]]
  [ ! -f "${RIVETHUB_ROOT}/datahub.env" ]
}

@test "help says defaults apply without a terminal, with or without --yes" {
  run bash "${DATAHUB}" -h
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"with or without --yes"* ]]
  [[ "${output}" == *"RIVETOS_EMBED_URL"* ]]
}
