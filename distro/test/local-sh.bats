#!/usr/bin/env bats
# Pure-logic tests for install/local.sh. git/npm/fnm/launch are skipped under
# RIVETHUB_TEST=1. Fakes in PATH. Requires bats; tests avoid
# `run --separate-stderr`. Reviewer: chmod +x is not required (invoked via bash).
# Examples use RFC 5737 addresses only.

LOCAL_SH="${BATS_TEST_DIRNAME}/../install/local.sh"
REPO="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

# Zip $2's contents into $1. python3/python first (this CI image has no zip(1)).
make_zip() {
  local dest="$1"
  local src="$2"
  local py=""
  if command -v python3 >/dev/null 2>&1; then
    py=python3
  elif command -v python >/dev/null 2>&1; then
    py=python
  fi
  if [[ -n "${py}" ]]; then
    "${py}" - "$src" "$dest" <<'PY'
import os, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dest, "w") as zf:
    for root, _dirs, files in os.walk(src):
        for name in files:
            path = os.path.join(root, name)
            zf.write(path, os.path.relpath(path, src))
PY
    return 0
  fi
  if command -v zip >/dev/null 2>&1; then
    ( cd "${src}" && zip -qr "${dest}" . )
    return 0
  fi
  echo "make_zip: need python3, python, or zip to build ${dest}" >&2
  return 1
}

setup() {
  TEST_TMP="$(mktemp -d)"
  export TEST_TMP
  export HOME="${TEST_TMP}/home"
  export RIVETHUB_TEST=1
  export RIVETHUB_DISTRO_DIR="${REPO}"
  export RIVETOS_INSTALL_ROOT="${TEST_TMP}/src"
  export RIVETHUB_LOCAL_BIN="${TEST_TMP}/bin-local"
  export RIVETHUB_DESKTOP_DIR="${TEST_TMP}/applications"
  export RIVETHUB_FNM_DIR="${TEST_TMP}/fnm"
  export RIVETHUB_APPIMAGE_PATH="${TEST_TMP}/bin-local/RivetHub"
  export RIVETHUB_APPLICATIONS_DIR="${TEST_TMP}/Applications"
  export RIVETHUB_OS_RELEASE="${BATS_TEST_DIRNAME}/fixtures/os-release-debian"
  unset RIVETHUB_PROMPT_IN RIVETHUB_PROVIDER RIVETHUB_API_KEY
  unset RIVETHUB_PORT RIVETHUB_PG_PORT RIVETHUB_NO_LAN RIVETHUB_NO_SERVICE
  unset RIVETHUB_NO_APP RIVETHUB_REF RIVETHUB_DEVICE RIVETHUB_YES
  unset RIVETHUB_PINS_FILE RIVETHUB_PINS_URL RIVETHUB_INSTALL_ROOT
  unset RIVETHUB_UNAME_S RIVETHUB_UNAME_M RIVETHUB_RELEASES_JSON
  unset RIVETHUB_RELEASES_BASE

  mkdir -p "${HOME}" "${TEST_TMP}/bin" "${RIVETHUB_LOCAL_BIN}" \
    "${RIVETHUB_DESKTOP_DIR}" "${RIVETOS_INSTALL_ROOT}" \
    "${TEST_TMP}/releases" "${RIVETHUB_APPLICATIONS_DIR}"

  # Fake node ≥ 22 so ensure_node22 detection/validation runs without fnm.
  cat >"${TEST_TMP}/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-e" ]]; then
  printf '22'
  exit 0
fi
if [[ "${1:-}" == "--version" ]]; then
  printf 'v22.11.0\n'
  exit 0
fi
exit 0
EOF
  chmod +x "${TEST_TMP}/bin/node"

  cat >"${TEST_TMP}/bin/rivetos" <<EOF
#!/usr/bin/env bash
set -euo pipefail
echo "rivetos \$*" >>"${TEST_TMP}/rivetos.log"
if [[ "\${1:-}" == "local" && "\${2:-}" == "status" ]]; then
  printf 'harnesses: grok (fake)\\n'
  exit 0
fi
if [[ "\${1:-}" == "local" ]]; then
  printf 'local up (fake)\\n'
  exit 0
fi
exit 0
EOF
  chmod +x "${TEST_TMP}/bin/rivetos"

  # Fake AppImage + matching latest.json so Linux install parses, hashes, and
  # replaces instead of skipping that logic under RIVETHUB_TEST=1.
  cat >"${TEST_TMP}/releases/RivetHub-0.5.21.AppImage" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >>"${TEST_TMP}/desktop-launch.argv"
exit 0
EOF
  chmod +x "${TEST_TMP}/releases/RivetHub-0.5.21.AppImage"
  FAKE_APP_SHA="$(file_sha256 "${TEST_TMP}/releases/RivetHub-0.5.21.AppImage")"
  cat >"${TEST_TMP}/releases/latest.json" <<EOF
{
  "apps": {
    "linux": {
      "version": "0.5.21",
      "file": "RivetHub-0.5.21.AppImage",
      "sha256": "${FAKE_APP_SHA}"
    }
  }
}
EOF
  export RIVETHUB_RELEASES_JSON="${TEST_TMP}/releases/latest.json"
  export RIVETHUB_RELEASES_BASE="${TEST_TMP}/releases"
  export PATH="${TEST_TMP}/bin:${PATH}"
}

teardown() {
  rm -rf "${TEST_TMP}"
}

src() {
  bash -c '
    source "$1"
    shift
    "$@"
  ' bash "${LOCAL_SH}" "$@"
}

parse_print() {
  bash -c '
    source "$1"
    shift
    parse_args "$@"
    printf "yes=%s provider=%s port=%s pgport=%s nolan=%s nosvc=%s noapp=%s root=%s ref=%s help=%s device=%s keyset=%s\n" \
      "${FLAG_YES}" "${PROVIDER}" "${DEN_PORT}" "${PG_PORT}" \
      "${FLAG_NO_LAN}" "${FLAG_NO_SERVICE}" "${FLAG_NO_APP}" \
      "${INSTALL_ROOT}" "${REF}" "${FLAG_HELP}" "${DEVICE}" "${API_KEY_SET}"
  ' bash "${LOCAL_SH}" "$@"
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------

@test "-h prints usage mentioning --yes, curl-pipe, and /dev/tty" {
  run bash "${LOCAL_SH}" -h
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"Usage: local.sh"* ]]
  [[ "${output}" == *"--yes"* ]]
  [[ "${output}" == *"--provider"* ]]
  [[ "${output}" == *"--api-key"* ]]
  [[ "${output}" == *"--port"* ]]
  [[ "${output}" == *"--no-lan"* ]]
  [[ "${output}" == *"--no-service"* ]]
  [[ "${output}" == *"--no-app"* ]]
  [[ "${output}" == *"--install-root"* ]]
  [[ "${output}" == *"--ref"* ]]
  [[ "${output}" == *"/dev/tty"* ]]
  [[ "${output}" == *"get.rivethub.io/local.sh"* ]]
  [[ "${output}" == *"non-TTY"* ]]
}

@test "unknown option is refused" {
  run bash "${LOCAL_SH}" --not-a-flag
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"unknown option"* ]]
}

@test "unexpected positional is refused" {
  run bash "${LOCAL_SH}" leftover
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"unexpected argument"* ]]
}

@test "parse_args records --yes --provider --port --pg-port --no-lan --no-app" {
  out="$(parse_print --yes --provider anthropic --port 5175 --pg-port 5434 --no-lan --no-app --ref v0.5.0 --device phone-a)"
  [[ "${out}" == *"yes=1"* ]]
  [[ "${out}" == *"provider=anthropic"* ]]
  [[ "${out}" == *"port=5175"* ]]
  [[ "${out}" == *"pgport=5434"* ]]
  [[ "${out}" == *"nolan=1"* ]]
  [[ "${out}" == *"noapp=1"* ]]
  [[ "${out}" == *"ref=v0.5.0"* ]]
  [[ "${out}" == *"device=phone-a"* ]]
  [[ "${out}" == *"keyset=0"* ]]
}

@test "parse_args defaults are 5174/5433 with flags off" {
  out="$(parse_print)"
  [[ "${out}" == *"yes=0"* ]]
  [[ "${out}" == *"port=5174"* ]]
  [[ "${out}" == *"pgport=5433"* ]]
  [[ "${out}" == *"nolan=0"* ]]
  [[ "${out}" == *"nosvc=0"* ]]
  [[ "${out}" == *"noapp=0"* ]]
  [[ "${out}" == *"help=0"* ]]
}

@test "-y is an alias of --yes" {
  out="$(parse_print -y)"
  [[ "${out}" == *"yes=1"* ]]
}

@test "--provider=anthropic equals --provider anthropic" {
  out="$(parse_print --provider=anthropic)"
  [[ "${out}" == *"provider=anthropic"* ]]
}

@test "--port without a value is refused" {
  run parse_print --port
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"--port requires"* ]]
}

@test "invalid --port is refused" {
  run parse_print --port 0
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"invalid --port"* ]]
  run parse_print --port 65536
  [ "${status}" -ne 0 ]
  run parse_print --port abc
  [ "${status}" -ne 0 ]
}

@test "invalid --pg-port is refused" {
  run parse_print --pg-port 0
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"invalid --pg-port"* ]]
}

@test "invalid --ref with shell metacharacters is refused" {
  run parse_print --ref 'main;id'
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"invalid --ref"* ]]
}

@test "--ref accepts a namespaced branch with a slash" {
  out="$(parse_print --ref feat/local-mode-cli-local)"
  [[ "${out}" == *"ref=feat/local-mode-cli-local"* ]]
}

@test "invalid --ref with .. or a leading dash is refused" {
  run parse_print --ref 'foo..bar'
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"invalid --ref"* ]]
  run parse_print --ref '-foo'
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"invalid --ref"* ]]
}

@test "invalid --device is refused" {
  run parse_print --device 'PhoneA'
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"invalid --device"* ]]
}

@test "--api-key is recorded as set and not printed by parse_print" {
  out="$(parse_print --api-key 'sk-test-not-a-real-key')"
  [[ "${out}" == *"keyset=1"* ]]
  [[ "${out}" != *"sk-test-not-a-real-key"* ]]
}

@test "RIVETHUB_PROVIDER and RIVETHUB_PORT apply when flags are omitted" {
  out="$(RIVETHUB_PROVIDER=grok RIVETHUB_PORT=6174 parse_print)"
  [[ "${out}" == *"provider=grok"* ]]
  [[ "${out}" == *"port=6174"* ]]
}

@test "--provider flag wins over RIVETHUB_PROVIDER" {
  out="$(RIVETHUB_PROVIDER=grok parse_print --provider anthropic)"
  [[ "${out}" == *"provider=anthropic"* ]]
}

@test "RIVETHUB_NO_LAN=1 sets --no-lan" {
  out="$(RIVETHUB_NO_LAN=1 parse_print)"
  [[ "${out}" == *"nolan=1"* ]]
}

@test "expand_path strips a literal ~/ prefix" {
  out="$(bash -c '
    source "$1"
    HOME_DIR=/home/example
    expand_path "~/foo"
  ' bash "${LOCAL_SH}")"
  [[ "${out}" == "/home/example/foo" ]]
}

@test "--install-root ~/foo expands under HOME, not a literal tilde directory" {
  out="$(bash -c '
    source "$1"
    parse_args --install-root "~/foo"
    init_paths
    printf "%s\n" "${INSTALL_ROOT}"
  ' bash "${LOCAL_SH}")"
  [[ "${out}" == "${HOME}/foo" ]]
}

@test "RIVETHUB_INSTALL_ROOT ~/foo expands under HOME, not a literal tilde directory" {
  out="$(
    RIVETHUB_INSTALL_ROOT='~/env-root' bash -c '
      source "$1"
      parse_args
      init_paths
      printf "%s\n" "${INSTALL_ROOT}"
    ' bash "${LOCAL_SH}"
  )"
  [[ "${out}" == "${HOME}/env-root" ]]
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

@test "preflight_tools refuses when curl is missing" {
  run bash -c '
    export PATH="$1"
    export RIVETHUB_TEST=1
    source "$2"
    init_paths
    preflight_tools
  ' bash "${TEST_TMP}/empty-path" "${LOCAL_SH}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"missing required tools"* ]]
  [[ "${output}" == *"curl"* ]]
  [[ "${output}" == *"apt install"* ]]
  [[ "${output}" == *"dnf install"* ]]
  [[ "${output}" == *"pacman -S"* ]]
  [[ "${output}" == *"brew install"* ]]
}

@test "preflight_os accepts Linux" {
  run bash -c '
    source "$1"
    export RIVETHUB_UNAME_S=Linux
    export RIVETHUB_OS_RELEASE="$2"
    init_paths
    preflight_os
  ' bash "${LOCAL_SH}" "${BATS_TEST_DIRNAME}/fixtures/os-release-debian"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"Debian GNU/Linux 12"* ]]
}

@test "preflight_os accepts macOS" {
  run bash -c '
    source "$1"
    export RIVETHUB_UNAME_S=Darwin
    init_paths
    preflight_os
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"macOS"* ]]
}

@test "preflight_os refuses Windows" {
  run bash -c '
    source "$1"
    export RIVETHUB_UNAME_S=MINGW64_NT
    init_paths
    preflight_os
  ' bash "${LOCAL_SH}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"unsupported OS"* ]]
  [[ "${output}" == *"Linux or macOS"* ]]
}

@test "preflight_tmux warns and does not block" {
  run bash -c '
    export PATH="$1"
    source "$2"
    init_paths
    preflight_tmux
  ' bash "${TEST_TMP}/empty-path" "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"tmux not found"* ]]
  [[ "${output}" == *"brew install tmux"* ]]
}

# ---------------------------------------------------------------------------
# pins
# ---------------------------------------------------------------------------

sibling_pin() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' \
    "${BATS_TEST_DIRNAME}/../pins/stable.json" "$1"
}

@test "sibling pins/stable.json supplies local_ref, rivetos_tag, and local_sh_sha256" {
  out="$(bash -c '
    source "$1"
    init_paths
    pin_get local_ref UNPINNED
    pin_get rivetos_tag UNPINNED
    pin_get local_sh_sha256 UNPINNED
  ' bash "${LOCAL_SH}")"
  [[ "${out}" == *"$(sibling_pin local_ref)"* ]]
  [[ "${out}" == *"$(sibling_pin rivetos_tag)"* ]]
  [[ "${out}" == *"$(sibling_pin local_sh_sha256)"* ]]
}

@test "curl-pipe without DISTRO_DIR uses embedded pins including local_ref" {
  cp "${LOCAL_SH}" "${TEST_TMP}/local.sh"
  run bash -c '
    unset RIVETHUB_DISTRO_DIR
    unset RIVETHUB_PINS_FILE
    unset RIVETHUB_PINS_URL
    source "$1"
    init_paths
    pin_get local_ref UNPINNED
    pin_get rivetos_tag UNPINNED
    pin_get local_sh_sha256 UNPINNED
  ' bash "${TEST_TMP}/local.sh"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"v0.6.0-rc.1"* ]]
  [[ "${output}" == *"v0.5.0"* ]]
  [[ "${output}" == *"UNPINNED"* ]]
}

@test "resolve_ref uses pins local_ref not rivetos_tag" {
  out="$(bash -c '
    source "$1"
    parse_args
    init_paths
    resolve_ref
    printf "ref=%s source=%s\n" "${REF}" "${REF_SOURCE}"
  ' bash "${LOCAL_SH}")"
  [[ "${out}" == *"ref=$(sibling_pin local_ref) "* ]]
  [[ "${out}" == *"local_ref"* ]]
  [[ "${out}" != *"ref=$(sibling_pin rivetos_tag) "* ]]
}

@test "resolve_ref UNPINNED falls back to main with a warning" {
  run bash -c '
    export RIVETHUB_PINS_FILE="$2"
    unset RIVETHUB_DISTRO_DIR
    source "$1"
    parse_args
    init_paths
    resolve_ref
    printf "ref=%s\n" "${REF}"
  ' bash "${LOCAL_SH}" "${BATS_TEST_DIRNAME}/fixtures/pins-unpinned.json"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"UNPINNED"* ]]
  [[ "${output}" == *"main"* ]]
  [[ "${output}" == *"warning"* ]]
  [[ "${output}" == *"local_ref"* ]]
}

@test "--ref wins over pins local_ref" {
  out="$(bash -c '
    source "$1"
    parse_args --ref v9.9.9
    init_paths
    resolve_ref
    printf "ref=%s source=%s\n" "${REF}" "${REF_SOURCE}"
  ' bash "${LOCAL_SH}")"
  [[ "${out}" == *"ref=v9.9.9"* ]]
  [[ "${out}" == *"--ref"* ]]
}

@test "json_app_field reads apps.linux.file and sha256" {
  out="$(bash -c '
    source "$1"
    json_app_field "$2" linux file
    json_app_field "$2" linux sha256
    json_app_field "$2" darwin file missing
  ' bash "${LOCAL_SH}" "${BATS_TEST_DIRNAME}/fixtures/latest-linux.json")"
  [[ "${out}" == *"RivetHub-0.5.21.AppImage"* ]]
  [[ "${out}" == *"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"* ]]
  [[ "${out}" == *"missing"* ]]
}

# ---------------------------------------------------------------------------
# non-TTY shopping list / --yes
# ---------------------------------------------------------------------------

@test "non-TTY without --yes lists every unset wizard question in one error" {
  unset RIVETHUB_PROMPT_IN
  run bash "${LOCAL_SH}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"Unanswered questions"* ]]
  [[ "${output}" == *"--provider"* ]]
  [[ "${output}" == *"--port"* ]]
  [[ "${output}" == *"--pg-port"* ]]
  [[ "${output}" == *"--no-lan"* ]]
  [[ "${output}" == *"--no-service"* ]]
  [[ "${output}" == *"--no-app"* ]]
  [[ "${output}" == *"--yes accepts documented defaults"* ]]
  [ ! -f "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop" ]
}

@test "non-TTY without --yes proceeds when every wizard flag is set" {
  unset RIVETHUB_PROMPT_IN
  run bash "${LOCAL_SH}" --provider anthropic --port 5174 --pg-port 5433 --no-lan --no-service --no-app
  [ "${status}" -eq 0 ]
  [[ "${output}" != *"Unanswered questions"* ]]
  [[ "${output}" == *"is installed"* ]]
  [ ! -f "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop" ]
}

@test "--yes on non-TTY accepts documented defaults" {
  bash "${LOCAL_SH}" --yes \
    >"${TEST_TMP}/yes.out" 2>"${TEST_TMP}/yes.err"
  grep -q "proceeding (--yes)" "${TEST_TMP}/yes.err"
  grep -q "non-TTY --yes: accepting documented defaults" "${TEST_TMP}/yes.err"
  grep -q "https://localhost:5174" "${TEST_TMP}/yes.out"
  grep -q "rivetos local status" "${TEST_TMP}/yes.out"
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
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"no-prompt"* ]]
}

@test "wizard reads scripted answers from RIVETHUB_PROMPT_IN" {
  printf '%s\n' 'anthropic' '5175' '5434' 'no' 'no' 'no' 'yes' >"${TEST_TMP}/answers"
  out="$(
    RIVETHUB_PROMPT_IN="${TEST_TMP}/answers" bash -c '
      source "$1"
      parse_args
      init_paths
      run_wizard_flow
      confirm_or_die
      printf "provider=%s port=%s pg=%s nolan=%s nosvc=%s noapp=%s action=%s\n" \
        "${PROVIDER}" "${DEN_PORT}" "${PG_PORT}" \
        "${FLAG_NO_LAN}" "${FLAG_NO_SERVICE}" "${FLAG_NO_APP}" "${WIZARD_ACTION}"
    ' bash "${LOCAL_SH}"
  )"
  [[ "${out}" == *"provider=anthropic"* ]]
  [[ "${out}" == *"port=5175"* ]]
  [[ "${out}" == *"pg=5434"* ]]
  [[ "${out}" == *"nolan=1"* ]]
  [[ "${out}" == *"nosvc=1"* ]]
  [[ "${out}" == *"noapp=1"* ]]
}

@test "confirm_or_die without --yes refuses no" {
  printf 'no\n' >"${TEST_TMP}/answers"
  run env RIVETHUB_PROMPT_IN="${TEST_TMP}/answers" bash -c '
    source "$1"
    FLAG_YES=0
    confirm_or_die
  ' bash "${LOCAL_SH}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"aborted"* ]]
}

@test "confirm_or_die --yes does not read a prompt" {
  run bash -c '
    source "$1"
    FLAG_YES=1
    confirm_or_die
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"proceeding (--yes)"* ]]
}

# ---------------------------------------------------------------------------
# desktop-entry rendering / main / idempotent re-run
# ---------------------------------------------------------------------------

@test "local_main --yes writes a Linux desktop entry with ozone-platform-hint" {
  export RIVETHUB_HAS_LIBFUSE2=1
  bash "${LOCAL_SH}" --yes \
    >"${TEST_TMP}/main.out" 2>"${TEST_TMP}/main.err"
  [ -f "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop" ]
  grep -q "ozone-platform-hint=auto" "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
  grep -q "^Name=RivetHub$" "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
  grep -q "Exec=${RIVETHUB_APPIMAGE_PATH} --ozone-platform-hint=auto" "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
  grep -q "https://localhost:5174" "${TEST_TMP}/main.out"
  grep -q "local mode 0.1.0 is installed" "${TEST_TMP}/main.out"
  grep -q "Settings → Devices → QR" "${TEST_TMP}/main.out"
  grep -q "rivetos local backup" "${TEST_TMP}/main.out"
  grep -q "rivethub.io/install-local.html" "${TEST_TMP}/main.out"
  grep -q "harnesses: grok (fake)" "${TEST_TMP}/main.out"
  grep -q "export PATH=" "${TEST_TMP}/main.out"
  grep -q ".bashrc" "${TEST_TMP}/main.out"
  ! grep -qi "BEGIN PRIVATE KEY" "${TEST_TMP}/main.out"
  ! grep -qi "BEGIN PRIVATE KEY" "${TEST_TMP}/main.err"
  ! grep -q "12 (bookworm)" "${TEST_TMP}/main.out"
}

@test "--no-app skips the desktop entry" {
  bash "${LOCAL_SH}" --yes --no-app \
    >"${TEST_TMP}/noapp.out" 2>"${TEST_TMP}/noapp.err"
  [ ! -f "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop" ]
  grep -q "skipping desktop app" "${TEST_TMP}/noapp.err"
}

@test "macOS without apps.darwin prints the coming message" {
  run env RIVETHUB_UNAME_S=Darwin bash "${LOCAL_SH}" --yes
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"macOS desktop app is coming"* ]]
  [[ "${output}" == *"https://localhost:5174"* ]]
  [ ! -f "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop" ]
}

@test "idempotent re-run resumes without error" {
  run bash "${LOCAL_SH}" --yes
  [ "${status}" -eq 0 ]
  [ -f "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop" ]
  [[ "${output}" == *"https://localhost:5174"* ]]
  run bash "${LOCAL_SH}" --yes
  [ "${status}" -eq 0 ]
  [ -f "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop" ]
  [[ "${output}" == *"https://localhost:5174"* ]]
  [[ "${output}" == *"skipping git clone"* ]]
  [[ "${output}" == *"skipping npm ci"* ]]
}

# Real git against a local origin (RIVETHUB_TEST unset so clone_or_refresh
# is not stubbed). No network.
@test "clone_or_refresh advances a branch that moved on origin" {
  origin="${TEST_TMP}/origin"
  dest="${TEST_TMP}/checkout"
  mkdir -p "${origin}"
  git -C "${origin}" init >/dev/null
  git -C "${origin}" config user.email "test@example.com"
  git -C "${origin}" config user.name "Test"
  git -C "${origin}" config commit.gpgsign false
  printf 'c1\n' >"${origin}/file"
  git -C "${origin}" add file
  git -C "${origin}" commit -m c1 >/dev/null
  git -C "${origin}" branch -M feat/x

  unset RIVETHUB_TEST
  run bash -c '
    unset RIVETHUB_TEST
    source "$1"
    INSTALL_ROOT="$2"
    REF="feat/x"
    REF_SET=1
    RIVETOS_GIT_REPO="$3"
    clone_or_refresh
  ' bash "${LOCAL_SH}" "${dest}" "${origin}"
  [ "${status}" -eq 0 ]

  hash1="$(git -C "${dest}" rev-parse HEAD)"
  printf 'c2\n' >"${origin}/file"
  git -C "${origin}" add file
  git -C "${origin}" commit -m c2 >/dev/null
  hash_origin="$(git -C "${origin}" rev-parse HEAD)"
  [ "${hash1}" != "${hash_origin}" ]

  run bash -c '
    unset RIVETHUB_TEST
    source "$1"
    INSTALL_ROOT="$2"
    REF="feat/x"
    REF_SET=1
    RIVETOS_GIT_REPO="$3"
    clone_or_refresh
  ' bash "${LOCAL_SH}" "${dest}" "${origin}"
  [ "${status}" -eq 0 ]
  hash2="$(git -C "${dest}" rev-parse HEAD)"
  [ "${hash2}" = "${hash_origin}" ]
}

# Same upgrade path as feat/x: --ref main and the UNPINNED→main fallback.
@test "clone_or_refresh advances main when origin moved" {
  origin="${TEST_TMP}/origin-main"
  dest="${TEST_TMP}/checkout-main"
  mkdir -p "${origin}"
  git -C "${origin}" init >/dev/null
  git -C "${origin}" config user.email "test@example.com"
  git -C "${origin}" config user.name "Test"
  git -C "${origin}" config commit.gpgsign false
  printf 'c1\n' >"${origin}/file"
  git -C "${origin}" add file
  git -C "${origin}" commit -m c1 >/dev/null
  git -C "${origin}" branch -M main

  unset RIVETHUB_TEST
  run bash -c '
    unset RIVETHUB_TEST
    source "$1"
    INSTALL_ROOT="$2"
    REF="main"
    REF_SET=1
    RIVETOS_GIT_REPO="$3"
    clone_or_refresh
  ' bash "${LOCAL_SH}" "${dest}" "${origin}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"checkout ok"* ]]

  hash1="$(git -C "${dest}" rev-parse HEAD)"
  printf 'c2\n' >"${origin}/file"
  git -C "${origin}" add file
  git -C "${origin}" commit -m c2 >/dev/null
  hash_origin="$(git -C "${origin}" rev-parse HEAD)"
  [ "${hash1}" != "${hash_origin}" ]

  run bash -c '
    unset RIVETHUB_TEST
    source "$1"
    INSTALL_ROOT="$2"
    REF="main"
    REF_SET=1
    RIVETOS_GIT_REPO="$3"
    clone_or_refresh
  ' bash "${LOCAL_SH}" "${dest}" "${origin}"
  [ "${status}" -eq 0 ]
  hash2="$(git -C "${dest}" rev-parse HEAD)"
  [ "${hash2}" = "${hash_origin}" ]
}

@test "clone_or_refresh errors on a missing ref instead of cloning main" {
  origin="${TEST_TMP}/origin"
  dest="${TEST_TMP}/checkout-missing"
  mkdir -p "${origin}"
  git -C "${origin}" init >/dev/null
  git -C "${origin}" config user.email "test@example.com"
  git -C "${origin}" config user.name "Test"
  git -C "${origin}" config commit.gpgsign false
  printf 'c1\n' >"${origin}/file"
  git -C "${origin}" add file
  git -C "${origin}" commit -m c1 >/dev/null
  git -C "${origin}" branch -M feat/x

  unset RIVETHUB_TEST
  run bash -c '
    unset RIVETHUB_TEST
    source "$1"
    INSTALL_ROOT="$2"
    REF="does-not-exist-ref"
    REF_SET=1
    RIVETOS_GIT_REPO="$3"
    clone_or_refresh
  ' bash "${LOCAL_SH}" "${dest}" "${origin}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"does-not-exist-ref"* ]]
  [ ! -d "${dest}/.git" ]
}

# R-a: --depth 1 clone --branch is single-branch; switching --ref must
# fetch into origin/$REF (or FETCH_HEAD) before checkout -B.
@test "clone_or_refresh switches from main to a different branch" {
  origin="${TEST_TMP}/origin-switch"
  dest="${TEST_TMP}/checkout-switch"
  mkdir -p "${origin}"
  git -C "${origin}" init >/dev/null
  git -C "${origin}" config user.email "test@example.com"
  git -C "${origin}" config user.name "Test"
  git -C "${origin}" config commit.gpgsign false
  printf 'c1\n' >"${origin}/file"
  git -C "${origin}" add file
  git -C "${origin}" commit -m c1 >/dev/null
  git -C "${origin}" branch -M main
  git -C "${origin}" checkout -b feat/x >/dev/null
  printf 'c2\n' >"${origin}/file"
  git -C "${origin}" add file
  git -C "${origin}" commit -m c2 >/dev/null
  git -C "${origin}" checkout main >/dev/null
  hash_main="$(git -C "${origin}" rev-parse HEAD)"
  hash_feat="$(git -C "${origin}" rev-parse feat/x)"
  [ "${hash_main}" != "${hash_feat}" ]

  unset RIVETHUB_TEST
  run bash -c '
    unset RIVETHUB_TEST
    source "$1"
    INSTALL_ROOT="$2"
    REF="main"
    REF_SET=1
    RIVETOS_GIT_REPO="$3"
    clone_or_refresh
  ' bash "${LOCAL_SH}" "${dest}" "${origin}"
  [ "${status}" -eq 0 ]
  [ "$(git -C "${dest}" rev-parse HEAD)" = "${hash_main}" ]
  run git -C "${dest}" show-ref --verify --quiet refs/remotes/origin/feat/x
  [ "${status}" -ne 0 ]

  run bash -c '
    unset RIVETHUB_TEST
    source "$1"
    INSTALL_ROOT="$2"
    REF="feat/x"
    REF_SET=1
    RIVETOS_GIT_REPO="$3"
    clone_or_refresh
  ' bash "${LOCAL_SH}" "${dest}" "${origin}"
  [ "${status}" -eq 0 ]
  [ "$(git -C "${dest}" rev-parse HEAD)" = "${hash_feat}" ]
}

@test "banner names status/backup/reset and does not print an api key" {
  run bash -c '
    source "$1"
    init_paths
    DEN_PORT=5174
    FLAG_NO_LAN=0
    REF=v0.5.0
    print_banner
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"https://localhost:5174"* ]]
  [[ "${output}" == *"local mode 0.1.0 is installed"* ]]
  [[ "${output}" == *"rivetos local status"* ]]
  [[ "${output}" == *"rivetos local backup"* ]]
  [[ "${output}" == *"rivetos local reset"* ]]
  [[ "${output}" == *"Settings → Devices → QR"* ]]
  [[ "${output}" == *"rivethub.io/install-local.html"* ]]
  [[ "${output}" == *"export PATH="* ]]
  [[ "${output}" != *"sk-"* ]]
}

@test "banner version is not clobbered by os-release VERSION" {
  run bash -c '
    source "$1"
    export RIVETHUB_UNAME_S=Linux
    export RIVETHUB_OS_RELEASE="$2"
    init_paths
    preflight_os
    DEN_PORT=5174
    FLAG_NO_LAN=0
    REF=v0.5.0
    print_banner
  ' bash "${LOCAL_SH}" "${BATS_TEST_DIRNAME}/fixtures/os-release-debian"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"Debian GNU/Linux 12"* ]]
  [[ "${output}" == *"local mode 0.1.0 is installed"* ]]
  [[ "${output}" != *"local mode 12 (bookworm)"* ]]
}

@test "banner includes fnm env when fnm was installed this run" {
  run bash -c '
    source "$1"
    init_paths
    DEN_PORT=5174
    FLAG_NO_LAN=0
    REF=v0.5.0
    FNM_INSTALLED=1
    print_banner
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"eval "* ]]
  [[ "${output}" == *"/fnm"* ]]
  [[ "${output}" == *"export PATH="* ]]
}

@test "banner fnm line uses FNM_BIN when set" {
  run bash -c '
    source "$1"
    init_paths
    DEN_PORT=5174
    FLAG_NO_LAN=0
    REF=v0.5.0
    FNM_INSTALLED=1
    FNM_BIN=/opt/homebrew/bin/fnm
    print_banner
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"/opt/homebrew/bin/fnm"* ]]
  [[ "${output}" != *"${RIVETHUB_FNM_DIR}/fnm"* ]]
}

@test "test seam forwards rivetos local flags and does not print the api key" {
  run bash "${LOCAL_SH}" --yes --port 6001 --pg-port 5435 --provider grok \
    --no-lan --no-service --device phone-a --api-key sk-test-NOT-REAL --no-app
  [ "${status}" -eq 0 ]
  [[ "${output}" != *"sk-test-NOT-REAL"* ]]
  grep -q -- "--port 6001" "${TEST_TMP}/rivetos.log"
  grep -q -- "--pg-port 5435" "${TEST_TMP}/rivetos.log"
  grep -q -- "--provider grok" "${TEST_TMP}/rivetos.log"
  grep -q -- "--no-lan" "${TEST_TMP}/rivetos.log"
  grep -q -- "--no-service" "${TEST_TMP}/rivetos.log"
  grep -q -- "--device phone-a" "${TEST_TMP}/rivetos.log"
  grep -q -- "--api-key sk-test-NOT-REAL" "${TEST_TMP}/rivetos.log"
  [[ "${output}" == *"local up (fake)"* ]]
}

# ---------------------------------------------------------------------------
# sourcing / curl-pipe guard
# ---------------------------------------------------------------------------

@test "sourcing local.sh does not invoke local_main" {
  run bash -c '
    source "$1"
    echo SOURCED_OK
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"SOURCED_OK"* ]]
  [[ "${output}" != *"is installed"* ]]
}

@test "piped bash -s -- -h invokes usage (curl-pipe guard)" {
  run bash -c 'cat "$1" | bash -s -- -h' _ "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"Usage: local.sh"* ]]
  [[ "${output}" == *"--yes"* ]]
}

@test "piped bash -s stubbed install is not a silent no-op" {
  cat "${LOCAL_SH}" | env \
    RIVETHUB_TEST=1 \
    HOME="${HOME}" \
    RIVETHUB_DISTRO_DIR="${REPO}" \
    RIVETOS_INSTALL_ROOT="${RIVETOS_INSTALL_ROOT}" \
    RIVETHUB_LOCAL_BIN="${RIVETHUB_LOCAL_BIN}" \
    RIVETHUB_DESKTOP_DIR="${RIVETHUB_DESKTOP_DIR}" \
    RIVETHUB_FNM_DIR="${RIVETHUB_FNM_DIR}" \
    RIVETHUB_APPIMAGE_PATH="${RIVETHUB_APPIMAGE_PATH}" \
    RIVETHUB_OS_RELEASE="${RIVETHUB_OS_RELEASE}" \
    PATH="${PATH}" \
    bash -s -- --yes \
    >"${TEST_TMP}/pipe.out" 2>"${TEST_TMP}/pipe.err"
  grep -q "is installed" "${TEST_TMP}/pipe.out"
  grep -q "https://localhost:5174" "${TEST_TMP}/pipe.out"
  [ -f "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop" ]
}

@test "write_desktop_entry is idempotent (re-run overwrites, does not duplicate)" {
  bash -c '
    source "$1"
    init_paths
    write_desktop_entry "$2"
    write_desktop_entry "$2"
  ' bash "${LOCAL_SH}" "${RIVETHUB_APPIMAGE_PATH}"
  [ -f "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop" ]
  count="$(grep -c '^\[Desktop Entry\]' "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop")"
  [ "${count}" -eq 1 ]
  grep -q "ozone-platform-hint=auto" "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
}

# ---------------------------------------------------------------------------
# fix round 2: ports, fnm, desktop, darwin, launch, exec escaping
# ---------------------------------------------------------------------------

@test "holder_is_ours rejects generic node pid" {
  run bash -c '
    source "$1"
    init_paths
    if holder_is_ours "node pid 1697573"; then
      echo ours
      exit 0
    fi
    echo not-ours
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"not-ours"* ]]
}

@test "holder_is_ours accepts rivetos and RivetHub command names" {
  run bash -c '
    source "$1"
    init_paths
    holder_is_ours "rivetos pid 11" && echo rivetos-ok
    holder_is_ours "RivetHub pid 12" && echo rivethub-ok
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"rivetos-ok"* ]]
  [[ "${output}" == *"rivethub-ok"* ]]
}

@test "holder_is_ours accepts a matching rivetos-owner.lock pid" {
  mkdir -p "${HOME}/.rivetos"
  printf '{"pid":4242,"port":5433}\n' >"${HOME}/.rivetos/rivetos-owner.lock"
  run bash -c '
    source "$1"
    init_paths
    if holder_is_ours "node pid 4242"; then
      echo lock-ours
    else
      echo lock-not
    fi
    if holder_is_ours "postgres pid 99"; then
      echo pg-ours
    else
      echo pg-not
    fi
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"lock-ours"* ]]
  [[ "${output}" == *"pg-not"* ]]
}

@test "preflight_port_one errors on an unrelated holder even with an existing install" {
  mkdir -p "${RIVETOS_INSTALL_ROOT}/.git"
  run bash -c '
    source "$1"
    init_paths
    port_is_open() { return 0; }
    port_holder() { printf "postgres pid 123\n"; }
    existing_local_install() { return 0; }
    preflight_port_one 5433 pglite
  ' bash "${LOCAL_SH}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"in use by postgres pid 123"* ]]
}

@test "preflight_port_one continues when the holder is ours" {
  run bash -c '
    source "$1"
    init_paths
    port_is_open() { return 0; }
    port_holder() { printf "rivetos pid 7\n"; }
    preflight_port_one 5174 den
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"already our local node"* ]]
}

@test "ensure_node22 accepts fake node 22 without installing fnm" {
  run bash -c '
    source "$1"
    init_paths
    ensure_node22
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"(>= 22)"* ]]
  [[ "${output}" != *"installing Node 22 via fnm"* ]]
}

@test "ensure_node22 with node 18 activates fnm and validates the new major" {
  mkdir -p "${TEST_TMP}/old-node" "${TEST_TMP}/fnm-node" "${TEST_TMP}/fnm-bin"
  cat >"${TEST_TMP}/old-node/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-e" ]]; then printf '18'; exit 0; fi
if [[ "${1:-}" == "--version" ]]; then printf 'v18.20.0\n'; exit 0; fi
exit 0
EOF
  chmod +x "${TEST_TMP}/old-node/node"
  cat >"${TEST_TMP}/fnm-node/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-e" ]]; then printf '22'; exit 0; fi
if [[ "${1:-}" == "--version" ]]; then printf 'v22.11.0\n'; exit 0; fi
exit 0
EOF
  chmod +x "${TEST_TMP}/fnm-node/node"
  cat >"${TEST_TMP}/fnm-bin/fnm" <<EOF
#!/usr/bin/env bash
echo "fnm \$*" >>"${TEST_TMP}/fnm.log"
if [[ "\${1:-}" == "env" ]]; then
  printf 'export PATH="%s:%s"\\n' "${TEST_TMP}/fnm-node" "\${PATH}"
  exit 0
fi
exit 0
EOF
  chmod +x "${TEST_TMP}/fnm-bin/fnm"
  run bash -c '
    export PATH="$2:$3:$PATH"
    source "$1"
    init_paths
    ensure_node22
  ' bash "${LOCAL_SH}" "${TEST_TMP}/old-node" "${TEST_TMP}/fnm-bin"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"older than 22"* ]]
  [[ "${output}" == *"(fnm)"* ]]
  grep -q "install 22" "${TEST_TMP}/fnm.log"
  grep -q "use 22" "${TEST_TMP}/fnm.log"
}

@test "ensure_node22 accepts node 22 from install_fnm without fnm" {
  mkdir -p "${TEST_TMP}/old-node" "${TEST_TMP}/brew-node"
  cat >"${TEST_TMP}/old-node/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-e" ]]; then printf '18'; exit 0; fi
if [[ "${1:-}" == "--version" ]]; then printf 'v18.20.0\n'; exit 0; fi
exit 0
EOF
  chmod +x "${TEST_TMP}/old-node/node"
  cat >"${TEST_TMP}/brew-node/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-e" ]]; then printf '22'; exit 0; fi
if [[ "${1:-}" == "--version" ]]; then printf 'v22.11.0\n'; exit 0; fi
exit 0
EOF
  chmod +x "${TEST_TMP}/brew-node/node"
  run bash -c '
    export PATH="$2:$PATH"
    source "$1"
    init_paths
    _brew_node="$3"
    install_fnm() {
      PATH="${_brew_node}:$PATH"
      export PATH
      return 0
    }
    ensure_node22
  ' bash "${LOCAL_SH}" "${TEST_TMP}/old-node" "${TEST_TMP}/brew-node"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"older than 22"* ]]
  [[ "${output}" == *"(>= 22)"* ]]
  [[ "${output}" != *"(fnm)"* ]]
  [[ "${output}" != *"could not activate fnm"* ]]
}

@test "install_fnm on Darwin logs --force-no-brew" {
  run bash -c '
    export RIVETHUB_UNAME_S=Darwin
    unzip_dir="$(dirname "$(command -v unzip)")"
    export PATH="${unzip_dir}:/usr/bin:/bin"
    source "$1"
    init_paths
    FNM_DIR="$2"
    mkdir -p "$2"
    install_fnm
  ' bash "${LOCAL_SH}" "${TEST_TMP}/fnm-empty"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"fnm installer argv:"* ]]
  [[ "${output}" == *"--force-no-brew"* ]]
  [[ "${output}" == *"--skip-shell"* ]]
}

@test "install_fnm on Linux does not pass --force-no-brew" {
  run bash -c '
    export RIVETHUB_UNAME_S=Linux
    unzip_dir="$(dirname "$(command -v unzip)")"
    export PATH="${unzip_dir}:/usr/bin:/bin"
    source "$1"
    init_paths
    FNM_DIR="$2"
    mkdir -p "$2"
    install_fnm
  ' bash "${LOCAL_SH}" "${TEST_TMP}/fnm-linux"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"fnm installer argv:"* ]]
  [[ "${output}" != *"--force-no-brew"* ]]
}

@test "activate_fnm fails when fnm env fails" {
  mkdir -p "${TEST_TMP}/bad-fnm"
  cat >"${TEST_TMP}/bad-fnm/fnm" <<'EOF'
#!/usr/bin/env bash
exit 42
EOF
  chmod +x "${TEST_TMP}/bad-fnm/fnm"
  run bash -c '
    export PATH="$2:$PATH"
    source "$1"
    init_paths
    activate_fnm
  ' bash "${LOCAL_SH}" "${TEST_TMP}/bad-fnm"
  [ "${status}" -ne 0 ]
}

@test "persist_fnm_init appends to bashrc when missing and is idempotent" {
  run bash -c '
    source "$1"
    init_paths
    FNM_INSTALLED=1
    persist_fnm_init
    persist_fnm_init
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"added RivetHub local.sh: fnm to"* ]]
  [ -f "${HOME}/.bashrc" ]
  [ -f "${HOME}/.bash_profile" ]
  [ -f "${HOME}/.zshrc" ]
  [ -f "${HOME}/.zprofile" ]
  count="$(grep -c 'RivetHub local.sh: fnm' "${HOME}/.bashrc")"
  [ "${count}" -eq 1 ]
  count_bash_profile="$(grep -c 'RivetHub local.sh: fnm' "${HOME}/.bash_profile")"
  [ "${count_bash_profile}" -eq 1 ]
  count_zsh="$(grep -c 'RivetHub local.sh: fnm' "${HOME}/.zshrc")"
  [ "${count_zsh}" -eq 1 ]
  count_zprofile="$(grep -c 'RivetHub local.sh: fnm' "${HOME}/.zprofile")"
  [ "${count_zprofile}" -eq 1 ]
  grep -q "fnm\" env)" "${HOME}/.bashrc"
  grep -q "fnm\" env)" "${HOME}/.bash_profile"
  grep -q "fnm\" env)" "${HOME}/.zshrc"
  grep -q "fnm\" env)" "${HOME}/.zprofile"
}

@test "persist_fnm_init writes the activated fnm path not FNM_DIR" {
  mkdir -p "${TEST_TMP}/elsewhere"
  cat >"${TEST_TMP}/elsewhere/fnm" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "env" ]]; then
  printf 'export FNM_FAKE=1\n'
  exit 0
fi
exit 0
EOF
  chmod +x "${TEST_TMP}/elsewhere/fnm"
  run bash -c '
    export PATH="$2:$PATH"
    source "$1"
    init_paths
    activate_fnm
    FNM_INSTALLED=1
    persist_fnm_init
  ' bash "${LOCAL_SH}" "${TEST_TMP}/elsewhere"
  [ "${status}" -eq 0 ]
  grep -q "${TEST_TMP}/elsewhere/fnm" "${HOME}/.bashrc"
  grep -q "${TEST_TMP}/elsewhere/fnm" "${HOME}/.bash_profile"
  grep -q "${TEST_TMP}/elsewhere/fnm" "${HOME}/.zshrc"
  grep -q "${TEST_TMP}/elsewhere/fnm" "${HOME}/.zprofile"
  ! grep -q "${RIVETHUB_FNM_DIR}/fnm" "${HOME}/.bashrc"
  ! grep -q "${RIVETHUB_FNM_DIR}/fnm" "${HOME}/.zshrc"
}

@test "persist_local_bin_path keeps Homebrew node fallback on next shells" {
  run bash -c '
    source "$1"
    init_paths
    NODE_FALLBACK_BIN="$2"
    persist_local_bin_path
  ' bash "${LOCAL_SH}" "${TEST_TMP}/brew-node"
  [ "${status}" -eq 0 ]
  grep -q "${TEST_TMP}/bin-local:${TEST_TMP}/brew-node" "${HOME}/.bashrc"
  grep -q "${TEST_TMP}/bin-local:${TEST_TMP}/brew-node" "${HOME}/.bash_profile"
  grep -q "${TEST_TMP}/bin-local:${TEST_TMP}/brew-node" "${HOME}/.zshrc"
  grep -q "${TEST_TMP}/bin-local:${TEST_TMP}/brew-node" "${HOME}/.zprofile"
}

@test "install_desktop_linux hashes before replace and installs the AppImage" {
  run bash -c '
    source "$1"
    init_paths
    FLAG_NO_APP=0
    install_desktop_linux
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [ -x "${RIVETHUB_APPIMAGE_PATH}" ]
  [ -f "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop" ]
  grep -q "ozone-platform-hint=auto" "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
  [[ "${output}" == *"installed ${RIVETHUB_APPIMAGE_PATH}"* ]]
  [[ "${output}" == *"launching desktop app"* ]]
  [[ "${output}" == *"--ozone-platform-hint=auto"* ]]
}

@test "install_desktop_linux refuses a sha256 mismatch and leaves dest untouched" {
  printf 'OLD\n' >"${RIVETHUB_APPIMAGE_PATH}"
  cat >"${TEST_TMP}/releases/latest.json" <<'EOF'
{
  "apps": {
    "linux": {
      "file": "RivetHub-0.5.21.AppImage",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  }
}
EOF
  run bash -c '
    source "$1"
    init_paths
    install_desktop_linux
  ' bash "${LOCAL_SH}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"sha256 mismatch"* ]]
  [[ "$(cat "${RIVETHUB_APPIMAGE_PATH}")" == "OLD" ]]
}

@test "launch_desktop_linux passes ozone-platform-hint=auto and reports /bin/false" {
  run bash -c '
    source "$1"
    init_paths
    launch_desktop_linux /bin/false
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"--ozone-platform-hint=auto"* ]]
  [[ "${output}" == *"exited immediately"* ]]
  [[ "${output}" == *"desktop-launch.log"* ]]
}

@test "launch_desktop_linux uses APPIMAGE_EXTRACT_AND_RUN when fuse2 is missing" {
  run bash -c '
    source "$1"
    init_paths
    RIVETHUB_HAS_LIBFUSE2=0 launch_desktop_linux /bin/false
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"APPIMAGE_EXTRACT_AND_RUN=1"* ]]
  [[ "${output}" == *"libfuse.so.2 not found"* ]]
}

@test "launch_desktop_linux warns when DISPLAY and WAYLAND_DISPLAY are empty" {
  run bash -c '
    source "$1"
    init_paths
    DISPLAY= WAYLAND_DISPLAY= launch_desktop_linux /bin/false
  ' bash "${LOCAL_SH}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"no DISPLAY or WAYLAND_DISPLAY"* ]]
}

@test "write_desktop_entry quotes spaces and escapes percent in Exec" {
  spaced="${TEST_TMP}/My Apps/RivetHub%2"
  mkdir -p "$(dirname "${spaced}")"
  run bash -c '
    source "$1"
    init_paths
    RIVETHUB_HAS_LIBFUSE2=1 write_desktop_entry "$2"
    cat "$3/rivethub.desktop"
  ' bash "${LOCAL_SH}" "${spaced}" "${RIVETHUB_DESKTOP_DIR}"
  [ "${status}" -eq 0 ]
  grep -q 'Exec="/' "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
  grep -q 'My Apps' "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
  grep -q 'RivetHub%%2' "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
  grep -q ' --ozone-platform-hint=auto' "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
  ! grep -q 'APPIMAGE_EXTRACT_AND_RUN' "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
}

@test "write_desktop_entry prefixes APPIMAGE_EXTRACT_AND_RUN when fuse2 is missing" {
  bin="${TEST_TMP}/RivetHub.AppImage"
  : >"${bin}"
  chmod +x "${bin}"
  run bash -c '
    source "$1"
    init_paths
    RIVETHUB_HAS_LIBFUSE2=0 write_desktop_entry "$2"
    cat "$3/rivethub.desktop"
  ' bash "${LOCAL_SH}" "${bin}" "${RIVETHUB_DESKTOP_DIR}"
  [ "${status}" -eq 0 ]
  grep -q 'Exec=env APPIMAGE_EXTRACT_AND_RUN=1 ' "${RIVETHUB_DESKTOP_DIR}/rivethub.desktop"
}

@test "macOS with apps.darwin.file installs RivetHub.app into Applications" {
  mkdir -p "${TEST_TMP}/darwin-src/RivetHub.app/Contents/MacOS"
  printf '#!/bin/sh\nexit 0\n' >"${TEST_TMP}/darwin-src/RivetHub.app/Contents/MacOS/RivetHub"
  chmod +x "${TEST_TMP}/darwin-src/RivetHub.app/Contents/MacOS/RivetHub"
  make_zip "${TEST_TMP}/releases/RivetHub-0.5.21-mac.zip" "${TEST_TMP}/darwin-src"
  dar_sha="$(file_sha256 "${TEST_TMP}/releases/RivetHub-0.5.21-mac.zip")"
  cat >"${TEST_TMP}/releases/latest.json" <<EOF
{
  "apps": {
    "darwin": {
      "file": "RivetHub-0.5.21-mac.zip",
      "sha256": "${dar_sha}"
    }
  }
}
EOF
  run env RIVETHUB_UNAME_S=Darwin bash "${LOCAL_SH}" --yes
  [ "${status}" -eq 0 ]
  [ -d "${RIVETHUB_APPLICATIONS_DIR}/RivetHub.app" ]
  [ -f "${RIVETHUB_APPLICATIONS_DIR}/RivetHub.app/Contents/MacOS/RivetHub" ]
  [[ "${output}" == *"installed ${RIVETHUB_APPLICATIONS_DIR}/RivetHub.app"* ]]
  [[ "${output}" != *"macOS desktop app is coming"* ]]
}
