#!/usr/bin/env bash
# RivetHub local-mode installer (one laptop, no root)
#
#   bash install/local.sh [--yes] [--provider KEY] [--api-key K] [--port 5174] \
#        [--pg-port 5433] [--no-lan] [--no-service] [--no-app] \
#        [--install-root DIR] [--ref REF] [--device NAME]
#
# Curl-pipe is supported (the advertised one-liner):
#   curl -fsSL https://get.rivethub.io/local.sh | bash
#
# Installs RivetOS as a single-node mesh on the login user: clone at the
# pins/stable.json local_ref into ~/.rivetos/src, npm ci/build, symlink
# ~/.local/bin/rivetos, `rivetos local --yes`, optional Linux AppImage /
# macOS .app. No sudo, no useradd, no system Node rewrite (fnm into
# ~/.local/share/fnm when node is missing or < 22).
#
# Wizard / TTY (parity with datahub.sh / node.sh):
#   Prompts are NOT read from the script pipe. When /dev/tty can actually
#   be opened (or stdin is a TTY), unset fields are asked, then preflight,
#   then a SUMMARY, then an explicit yes before mutation unless --yes.
#   --yes skips confirm and on non-TTY accepts documented defaults.
#   Non-TTY without --yes lists EVERY unset wizard question in ONE error
#   (shopping list) — we do not silently take defaults without --yes.
#   RIVETHUB_PROMPT_IN is the test seam (one line per prompt).
#   RIVETHUB_TEST=1 never opens /dev/tty.
#
# Test-only: RIVETHUB_TEST=1 skips clone/npm/fnm-download/network so the
# bats suite can exercise parse/preflight/pins/wizard/desktop-entry with
# fakes in PATH. Detection/validation still runs (ensure_node22, AppImage
# manifest parse + sha256 + replace, Darwin unzip). The rivetos local argv
# (including pass-through flags) is still invoked so flag-forwarding tests
# can fail. Do not set this on a real host.
#
# Read this file. Curl-pipe installers should be boring.
#
# Layout (login user, no root):
#   ~/.rivetos/src            rivetOS checkout (override --install-root)
#   ~/.rivetos                config.yaml, .env, pglite, CA (owned by CLI)
#   ~/.local/bin/rivetos      symlink to the checkout CLI
#   ~/.local/bin/RivetHub     Linux AppImage (unless --no-app)
#   ~/.local/share/applications/rivethub.desktop
#   ~/Applications/RivetHub.app  macOS .app when apps.darwin.file is present
#
# Pins: sibling pins/stable.json from a checkout; curl-pipe fetches
# https://get.rivethub.io/pins/stable.json, else the embedded copy.
# Ref = --ref > RIVETHUB_REF > pins local_ref > main if UNPINNED
# (loud warning). rivetos_tag is the datahub/node pin, not this default.
#
# Bash 3.2 (macOS /bin/bash): no ${var,,}, no {fd} redirection, no
# associative arrays. Secrets never go through log().

set -euo pipefail

LOCAL_SH_VERSION="0.1.0"

# Defaults (overridden by parse_args / env). *_SET=1 means a flag or env
# supplied the value so the wizard must not ask that question.
FLAG_HELP=0
FLAG_YES=0
FLAG_NO_LAN=0
FLAG_NO_SERVICE=0
FLAG_NO_APP=0
PROVIDER=""
PROVIDER_SET=0
API_KEY=""
API_KEY_SET=0
DEN_PORT="5174"
PORT_SET=0
PG_PORT="5433"
PG_PORT_SET=0
LAN_SET=0
SERVICE_SET=0
APP_SET=0
INSTALL_ROOT=""
ROOT_SET=0
REF=""
REF_SET=0
REF_SOURCE=""
DEVICE=""
DEVICE_SET=0
FNM_INSTALLED=0
NODE_FALLBACK_BIN=""
FNM_BIN=""
_WIZARD_PROMPT_FD=""
WIZARD_REPLY=""
UNANSWERED_QUESTIONS=()
WIZARD_ACTION=""
PINS_SOURCE=""

DISTRO_ROOT=""
PINS_FILE=""
LOCAL_BIN=""
DESKTOP_DIR=""
FNM_DIR=""
APPIMAGE_PATH=""
APPLICATIONS_DIR=""
HOME_DIR=""

# rivetOS GitHub. Not a pin field.
RIVETOS_GITHUB_REPO="philbert440/rivetOS"

# ---------------------------------------------------------------------------
# logging — secrets (API keys) never go through log()
# ---------------------------------------------------------------------------

log() { printf 'local.sh: %s\n' "$*" >&2; }
err() { printf 'local.sh: %s\n' "$*" >&2; exit 1; }
warn() { printf 'local.sh: warning: %s\n' "$*" >&2; }

in_test() { [[ "${RIVETHUB_TEST:-}" == "1" ]]; }

_RIVETHUB_TMP_FILES=()
_RIVETHUB_TMP_DIRS=()
register_tmp() { _RIVETHUB_TMP_FILES[${#_RIVETHUB_TMP_FILES[@]}]="$1"; }
register_tmp_dir() { _RIVETHUB_TMP_DIRS[${#_RIVETHUB_TMP_DIRS[@]}]="$1"; }
cleanup_tmp() {
  local f d
  if [[ ${#_RIVETHUB_TMP_FILES[@]} -gt 0 ]]; then
    for f in "${_RIVETHUB_TMP_FILES[@]}"; do
      rm -f "${f}"
    done
  fi
  if [[ ${#_RIVETHUB_TMP_DIRS[@]} -gt 0 ]]; then
    for d in "${_RIVETHUB_TMP_DIRS[@]}"; do
      rm -rf "${d}"
    done
  fi
  _RIVETHUB_TMP_FILES=()
  _RIVETHUB_TMP_DIRS=()
  wizard_close_prompt_fd
}
trap cleanup_tmp EXIT

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# AppImage runtime needs libfuse.so.2 (fuse2). fuse3-only hosts (Omarchy)
# fail with dlopen(): error loading libfuse.so.2. RIVETHUB_HAS_LIBFUSE2=0|1
# is the test seam.
has_libfuse2() {
  local p out
  case "${RIVETHUB_HAS_LIBFUSE2:-}" in
    0) return 1 ;;
    1) return 0 ;;
  esac
  if have_cmd ldconfig; then
    out="$(ldconfig -p 2>/dev/null || true)"
    case "${out}" in
      *libfuse.so.2*) return 0 ;;
    esac
  fi
  for p in \
    /lib/libfuse.so.2 \
    /lib64/libfuse.so.2 \
    /usr/lib/libfuse.so.2 \
    /usr/lib64/libfuse.so.2 \
    /usr/lib/x86_64-linux-gnu/libfuse.so.2 \
    /usr/lib/aarch64-linux-gnu/libfuse.so.2 \
    /lib/x86_64-linux-gnu/libfuse.so.2 \
    /lib/aarch64-linux-gnu/libfuse.so.2
  do
    [[ -e "${p}" ]] && return 0
  done
  return 1
}

kernel_name() { printf '%s\n' "${RIVETHUB_UNAME_S:-$(uname -s 2>/dev/null || true)}"; }
kernel_arch() { printf '%s\n' "${RIVETHUB_UNAME_M:-$(uname -m 2>/dev/null || true)}"; }

# ---------------------------------------------------------------------------
# wizard I/O — /dev/tty for curl-pipe; RIVETHUB_PROMPT_IN is the test seam
# Fixed FD 3 (bash 3.2 has no exec {var}<file).
# ---------------------------------------------------------------------------

wizard_close_prompt_fd() {
  if [[ -z "${_WIZARD_PROMPT_FD}" || "${_WIZARD_PROMPT_FD}" == "0" ]]; then
    _WIZARD_PROMPT_FD=""
    return 0
  fi
  if [[ "${_WIZARD_PROMPT_FD}" == "3" ]]; then
    exec 3<&- || true
  fi
  _WIZARD_PROMPT_FD=""
}

can_prompt() {
  if [[ -n "${RIVETHUB_PROMPT_IN:-}" && -r "${RIVETHUB_PROMPT_IN}" ]]; then
    return 0
  fi
  if in_test; then
    return 1
  fi
  wizard_open_prompt_fd
}

wizard_open_prompt_fd() {
  if [[ -n "${_WIZARD_PROMPT_FD}" ]]; then
    return 0
  fi
  if [[ -n "${RIVETHUB_PROMPT_IN:-}" ]]; then
    if [[ ! -r "${RIVETHUB_PROMPT_IN}" ]]; then
      return 1
    fi
    if exec 3<"${RIVETHUB_PROMPT_IN}"; then
      _WIZARD_PROMPT_FD=3
      return 0
    fi
    return 1
  fi
  if in_test; then
    return 1
  fi
  # Probe first: a bare exec 3<>/dev/tty prints "No such device or address"
  # on ssh-without-tty / CI even when the open fails. Character device + a
  # subshell open must both succeed before we touch FD 3.
  if [ -c /dev/tty ] && ( : < /dev/tty ) 2>/dev/null; then
    if { exec 3<>/dev/tty; } 2>/dev/null; then
      _WIZARD_PROMPT_FD=3
      return 0
    fi
  fi
  if [[ -t 0 ]]; then
    _WIZARD_PROMPT_FD=0
    return 0
  fi
  return 1
}

prompt_line() {
  local prompt="$1"
  local default="${2:-}"
  local reply=""
  WIZARD_REPLY=""
  if ! wizard_open_prompt_fd; then
    err "cannot prompt (${prompt}): stdin is not a TTY and /dev/tty is unavailable. Pass flags or RIVETHUB_* environment variables (see --help)."
  fi
  if [[ -n "${default}" ]]; then
    printf '%s [%s]: ' "${prompt}" "${default}" >&2
  else
    printf '%s: ' "${prompt}" >&2
  fi
  if ! IFS= read -r reply <&"${_WIZARD_PROMPT_FD}"; then
    if [[ -z "${reply}" ]]; then
      err "unanswered question (${prompt}): prompt input ended (EOF). Pass flags or RIVETHUB_* environment variables, or add a line to RIVETHUB_PROMPT_IN."
    fi
  fi
  if [[ -z "${reply}" ]]; then
    reply="${default}"
  fi
  WIZARD_REPLY="${reply}"
}

is_yes() {
  local s
  s="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "${s}" in
    y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

is_no() {
  local s
  s="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "${s}" in
    n|no) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# usage
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: local.sh [options]

Install RivetOS as a local mesh of one on this laptop (Linux or macOS).
No root. Re-running is a resume/upgrade (fetch + checkout + rebuild +
rivetos local --yes). Version ${LOCAL_SH_VERSION}.

On a terminal (or curl-pipe with a controlling /dev/tty that can actually
be opened), unset fields are prompted with defaults shown, then preflight,
then a SUMMARY, then an explicit yes is required before any write. Flags
and RIVETHUB_* env vars skip their prompt. --yes skips the confirm. On
non-TTY (plain ssh, no controlling terminal), --yes accepts documented
defaults. Without --yes, every unset wizard question is listed in ONE error.

Options:
  -y, --yes                Skip the pre-mutation confirm. On non-TTY, also
                           accept documented defaults for unset fields.
  --provider KEY           Passed through to \`rivetos local --provider\`
                           (example: anthropic, grok). Default: auto-detect.
  --api-key K              Passed through to \`rivetos local --api-key\`.
                           Never printed.
  --port PORT              Den / gateway port (default 5174).
  --pg-port PORT           Embedded Postgres wire port (default 5433).
  --no-lan                 Do not advertise on the LAN (loopback only).
  --no-service             Do not install a login service; print rivetos start.
  --no-app                 Skip the desktop app (AppImage / macOS .app).
  --install-root DIR       rivetOS checkout (default ~/.rivetos/src).
  --ref REF                Git ref to check out (overrides pins/stable.json
                           local_ref). Tags and namespaced branches
                           (feat/foo) are accepted. No '..', leading '-',
                           or spaces.
  --device NAME            Passed through to \`rivetos local --device\`.
  -h, --help               Show this help.

Environment (flags win):
  RIVETHUB_PROVIDER        Default for --provider
  RIVETHUB_API_KEY         Default for --api-key (never printed)
  RIVETHUB_PORT            Default for --port
  RIVETHUB_PG_PORT         Default for --pg-port
  RIVETHUB_NO_LAN          1 to set --no-lan
  RIVETHUB_NO_SERVICE      1 to set --no-service
  RIVETHUB_NO_APP          1 to set --no-app
  RIVETHUB_INSTALL_ROOT    Default for --install-root (also RIVETOS_INSTALL_ROOT)
  RIVETHUB_REF             Default for --ref
  RIVETHUB_DEVICE          Default for --device
  RIVETHUB_DISTRO_DIR      Checkout containing pins/stable.json
  RIVETHUB_PINS_FILE       Override path to pins/stable.json
  RIVETHUB_PINS_URL        Override pins fetch URL (default
                           https://get.rivethub.io/pins/stable.json)
  RIVETOS_GIT_REPO         Override clone URL
  RIVETHUB_PROMPT_IN       Test seam: file of wizard answers, one per prompt.

Examples:
  curl -fsSL https://get.rivethub.io/local.sh | bash
  curl -fsSL https://get.rivethub.io/local.sh | bash -s -- --yes
  bash install/local.sh --yes --provider anthropic --no-app
  bash install/local.sh --yes --ref feat/local-mode-cli-local --no-app
EOF
}

# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------

discover_distro_root() {
  local src here parent
  if [[ -n "${RIVETHUB_DISTRO_DIR:-}" ]]; then
    printf '%s\n' "${RIVETHUB_DISTRO_DIR}"
    return 0
  fi
  src=""
  if [[ ${#BASH_SOURCE[@]} -gt 0 ]]; then
    src="${BASH_SOURCE[0]}"
  fi
  if [[ -n "${src}" && -f "${src}" ]]; then
    here="$(cd "$(dirname "${src}")" && pwd)" || return 1
    parent="$(cd "${here}/.." && pwd)" || return 1
    if [[ -f "${parent}/pins/stable.json" ]]; then
      printf '%s\n' "${parent}"
      return 0
    fi
  fi
  return 1
}

expand_path() {
  local p="${1:-}"
  local tilde prefix rest
  # $'\x7e' is ASCII tilde without a quoted-~ token (SC2088).
  tilde=$'\x7e'
  prefix="${tilde}/"
  if [[ "${p}" == "${tilde}" ]]; then
    printf '%s\n' "${HOME_DIR}"
    return 0
  fi
  if [[ "${p}" == "${prefix}"* ]]; then
    rest="${p#"${prefix}"}"
    printf '%s\n' "${HOME_DIR}/${rest}"
    return 0
  fi
  printf '%s\n' "${p}"
}

init_paths() {
  HOME_DIR="${HOME:-}"
  if [[ -z "${HOME_DIR}" ]]; then
    HOME_DIR="$(printf '%s\n' ~)"
  fi
  [[ -n "${HOME_DIR}" ]] || err "HOME is empty; set HOME or pass --install-root"

  if [[ -z "${INSTALL_ROOT}" ]]; then
    INSTALL_ROOT="${RIVETHUB_INSTALL_ROOT:-${RIVETOS_INSTALL_ROOT:-${HOME_DIR}/.rivetos/src}}"
  fi
  INSTALL_ROOT="$(expand_path "${INSTALL_ROOT}")"
  case "${INSTALL_ROOT}" in
    /*) ;;
    *) err "install root '${INSTALL_ROOT}' is not an absolute path (pass --install-root /path or ~/path)" ;;
  esac

  LOCAL_BIN="${RIVETHUB_LOCAL_BIN:-${HOME_DIR}/.local/bin}"
  DESKTOP_DIR="${RIVETHUB_DESKTOP_DIR:-${HOME_DIR}/.local/share/applications}"
  FNM_DIR="${RIVETHUB_FNM_DIR:-${HOME_DIR}/.local/share/fnm}"
  APPIMAGE_PATH="${RIVETHUB_APPIMAGE_PATH:-${LOCAL_BIN}/RivetHub}"
  APPLICATIONS_DIR="${RIVETHUB_APPLICATIONS_DIR:-${HOME_DIR}/Applications}"

  DISTRO_ROOT=""
  if DISTRO_ROOT="$(discover_distro_root)"; then
    :
  else
    DISTRO_ROOT=""
  fi
  if [[ -n "${RIVETHUB_PINS_FILE:-}" && -f "${RIVETHUB_PINS_FILE}" ]]; then
    PINS_FILE="${RIVETHUB_PINS_FILE}"
    PINS_SOURCE="RIVETHUB_PINS_FILE"
  elif [[ -n "${DISTRO_ROOT}" && -f "${DISTRO_ROOT}/pins/stable.json" ]]; then
    PINS_FILE="${DISTRO_ROOT}/pins/stable.json"
    PINS_SOURCE="sibling"
  else
    PINS_FILE=""
    PINS_SOURCE=""
    ensure_pins_file
  fi
}

# ---------------------------------------------------------------------------
# pins/stable.json
#
# Curl-pipe has no sibling pins/. Fetch get.rivethub.io/pins/stable.json;
# if that fails, write the embedded copy (must match pins/stable.json).
# ---------------------------------------------------------------------------

# Keep in sync with pins/stable.json.
write_embedded_pins() {
  cat >"$1" <<'EOF'
{
  "rivetos_tag": "v0.5.0",
  "local_ref": "v0.6.0-rc.1",
  "image": "ghcr.io/philbert440/rivetos:0.5.0",
  "rivet_ca_sha256": "1fc35cc30d5279018433ea13a0edd27ec7a1f851fdfdbb0147749228ef0aa5e0",
  "hub_helper_version": "0.1.0",
  "pgvector_image": "pgvector/pgvector:pg16",
  "local_sh_sha256": "UNPINNED"
}
EOF
}

# Top-level JSON string field. No python3 (macOS / bash 3.2 laptop).
json_top_string() {
  local file="$1"
  local key="$2"
  local fallback="${3:-}"
  local val=""
  if [[ -z "${file}" || ! -f "${file}" ]]; then
    printf '%s\n' "${fallback}"
    return 0
  fi
  val="$(sed -n "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "${file}" | sed -n '1p')"
  if [[ -z "${val}" ]]; then
    printf '%s\n' "${fallback}"
  else
    printf '%s\n' "${val}"
  fi
}

# Nested apps.<platform>.<field> from latest.json (object-per-platform).
json_app_field() {
  local file="$1"
  local platform="$2"
  local field="$3"
  local fallback="${4:-}"
  local val=""
  if [[ -z "${file}" || ! -f "${file}" ]]; then
    printf '%s\n' "${fallback}"
    return 0
  fi
  val="$(awk -v plat="${platform}" -v field="${field}" '
    $0 ~ "\"" plat "\"" { inplat = 1; next }
    inplat && /}/ { inplat = 0 }
    inplat && $0 ~ "\"" field "\"" {
      if (match($0, /:[[:space:]]*"[^"]+"/)) {
        val = substr($0, RSTART, RLENGTH)
        sub(/^:[[:space:]]*"/, "", val)
        sub(/"$/, "", val)
        print val
        exit
      }
    }
  ' "${file}")"
  if [[ -z "${val}" ]]; then
    printf '%s\n' "${fallback}"
  else
    printf '%s\n' "${val}"
  fi
}

fetch_remote_pins() {
  local dest="$1"
  local url="${RIVETHUB_PINS_URL:-https://get.rivethub.io/pins/stable.json}"
  have_cmd curl || return 1
  curl -fsSL --max-time 15 -o "${dest}" -- "${url}" 2>/dev/null || return 1
  [[ -s "${dest}" ]] || return 1
  # Must look like JSON with a rivetos_tag (or we fall back to embedded).
  if [[ -z "$(json_top_string "${dest}" rivetos_tag "")" ]]; then
    return 1
  fi
  return 0
}

ensure_pins_file() {
  local fetched=""
  if [[ -n "${PINS_FILE}" && -f "${PINS_FILE}" ]]; then
    return 0
  fi
  if ! in_test || [[ -n "${RIVETHUB_PINS_URL:-}" ]]; then
    fetched="$(mktemp "${TMPDIR:-/tmp}/rivethub-pins.XXXXXX")"
    register_tmp "${fetched}"
    if fetch_remote_pins "${fetched}"; then
      PINS_FILE="${fetched}"
      PINS_SOURCE="remote"
      log "loaded pins from ${RIVETHUB_PINS_URL:-https://get.rivethub.io/pins/stable.json}"
      return 0
    fi
    rm -f "${fetched}"
    warn "could not fetch pins/stable.json from ${RIVETHUB_PINS_URL:-https://get.rivethub.io}; using embedded pin values"
  fi
  fetched="$(mktemp "${TMPDIR:-/tmp}/rivethub-pins.XXXXXX")"
  register_tmp "${fetched}"
  write_embedded_pins "${fetched}"
  PINS_FILE="${fetched}"
  PINS_SOURCE="embedded"
}

pin_get() {
  local key="$1"
  local fallback="${2:-UNPINNED}"
  json_top_string "${PINS_FILE}" "${key}" "${fallback}"
}

# Git ref name (check-ref-format --allow-onelevel subset): tags like v0.5.0
# and namespaced branches like feat/foo. No '..', leading dash/slash, spaces
# or control chars, trailing '.' / '/', consecutive slashes, or '.lock'
# components. Used for --ref, RIVETHUB_REF, and pins local_ref.
valid_pin_tag() {
  local r="${1:-}"
  local comp rest
  [[ -n "${r}" ]] || return 1
  [[ "${r}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || return 1
  [[ "${r}" != *..* ]] || return 1
  [[ "${r}" != *//* ]] || return 1
  [[ "${r}" != *. ]] || return 1
  [[ "${r}" != */ ]] || return 1
  # Component-wise: case `*` matches `/`, so `*.lock/*` would also reject
  # `foo.lockbar/baz`. Git forbids a component that *ends* in `.lock`.
  rest="${r}"
  while :; do
    comp="${rest%%/*}"
    case "${comp}" in
      *.lock) return 1 ;;
    esac
    [[ "${rest}" == */* ]] || break
    rest="${rest#*/}"
  done
  return 0
}

valid_port() {
  local p="${1:-}" n
  [[ "${p}" =~ ^[0-9]+$ ]] || return 1
  n=$((10#${p}))
  [[ "${n}" -ge 1 && "${n}" -le 65535 ]]
}

valid_provider() {
  local p="${1:-}"
  [[ -n "${p}" ]] || return 1
  [[ "${#p}" -le 64 ]] || return 1
  [[ "${p}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

valid_device_name() {
  local name="${1:-}"
  if [[ -z "${name}" ]]; then
    return 1
  fi
  if [[ "${#name}" -gt 63 ]]; then
    return 1
  fi
  [[ "${name}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------

parse_args() {
  FLAG_HELP=0
  FLAG_YES=0
  FLAG_NO_LAN=0
  FLAG_NO_SERVICE=0
  FLAG_NO_APP=0
  PROVIDER=""
  PROVIDER_SET=0
  API_KEY=""
  API_KEY_SET=0
  DEN_PORT="5174"
  PORT_SET=0
  PG_PORT="5433"
  PG_PORT_SET=0
  LAN_SET=0
  SERVICE_SET=0
  APP_SET=0
  INSTALL_ROOT=""
  ROOT_SET=0
  REF=""
  REF_SET=0
  DEVICE=""
  DEVICE_SET=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        FLAG_HELP=1
        return 0
        ;;
      -y|--yes)
        FLAG_YES=1
        shift
        ;;
      --provider)
        if [[ $# -lt 2 ]]; then
          err "--provider requires a provider key"
        fi
        PROVIDER="$2"
        PROVIDER_SET=1
        shift 2
        ;;
      --provider=*)
        PROVIDER="${1#--provider=}"
        PROVIDER_SET=1
        shift
        ;;
      --api-key)
        if [[ $# -lt 2 ]]; then
          err "--api-key requires a value"
        fi
        API_KEY="$2"
        API_KEY_SET=1
        shift 2
        ;;
      --api-key=*)
        API_KEY="${1#--api-key=}"
        API_KEY_SET=1
        shift
        ;;
      --port)
        if [[ $# -lt 2 ]]; then
          err "--port requires a port"
        fi
        DEN_PORT="$2"
        PORT_SET=1
        shift 2
        ;;
      --port=*)
        DEN_PORT="${1#--port=}"
        PORT_SET=1
        shift
        ;;
      --pg-port)
        if [[ $# -lt 2 ]]; then
          err "--pg-port requires a port"
        fi
        PG_PORT="$2"
        PG_PORT_SET=1
        shift 2
        ;;
      --pg-port=*)
        PG_PORT="${1#--pg-port=}"
        PG_PORT_SET=1
        shift
        ;;
      --no-lan)
        FLAG_NO_LAN=1
        LAN_SET=1
        shift
        ;;
      --no-service)
        FLAG_NO_SERVICE=1
        SERVICE_SET=1
        shift
        ;;
      --no-app)
        FLAG_NO_APP=1
        APP_SET=1
        shift
        ;;
      --install-root)
        if [[ $# -lt 2 ]]; then
          err "--install-root requires a directory"
        fi
        INSTALL_ROOT="$2"
        ROOT_SET=1
        shift 2
        ;;
      --install-root=*)
        INSTALL_ROOT="${1#--install-root=}"
        ROOT_SET=1
        shift
        ;;
      --ref)
        if [[ $# -lt 2 ]]; then
          err "--ref requires a git ref"
        fi
        REF="$2"
        REF_SET=1
        shift 2
        ;;
      --ref=*)
        REF="${1#--ref=}"
        REF_SET=1
        shift
        ;;
      --device)
        if [[ $# -lt 2 ]]; then
          err "--device requires a name"
        fi
        DEVICE="$2"
        DEVICE_SET=1
        shift 2
        ;;
      --device=*)
        DEVICE="${1#--device=}"
        DEVICE_SET=1
        shift
        ;;
      --)
        shift
        break
        ;;
      -*)
        err "unknown option: $1 (try --help)"
        ;;
      *)
        err "unexpected argument: $1 (try --help)"
        ;;
    esac
  done
  if [[ $# -gt 0 ]]; then
    err "unexpected argument: $1 (try --help)"
  fi
  apply_env_defaults
  if [[ "${PROVIDER_SET}" -eq 1 ]]; then
    valid_provider "${PROVIDER}" || err "invalid --provider '${PROVIDER}' (expected [A-Za-z0-9][A-Za-z0-9._-]*)"
  fi
  valid_port "${DEN_PORT}" || err "invalid --port '${DEN_PORT}' (expected 1-65535)"
  valid_port "${PG_PORT}" || err "invalid --pg-port '${PG_PORT}' (expected 1-65535)"
  if [[ "${REF_SET}" -eq 1 ]]; then
    valid_pin_tag "${REF}" || err "invalid --ref '${REF}' (expected a git ref name; no '..', leading '-', or spaces)"
  fi
  if [[ "${DEVICE_SET}" -eq 1 ]]; then
    valid_device_name "${DEVICE}" || err "invalid --device '${DEVICE}' (expected [a-z0-9]([a-z0-9-]*[a-z0-9])?, max 63)"
  fi
  if [[ "${API_KEY_SET}" -eq 1 && -z "${API_KEY}" ]]; then
    err "--api-key was set but empty"
  fi
}

# Env fills only gaps flags did not set (flags win).
apply_env_defaults() {
  if [[ "${FLAG_YES}" -eq 0 && "${RIVETHUB_YES:-}" == "1" ]]; then
    FLAG_YES=1
  fi
  if [[ "${PROVIDER_SET}" -eq 0 && -n "${RIVETHUB_PROVIDER:-}" ]]; then
    PROVIDER="${RIVETHUB_PROVIDER}"
    PROVIDER_SET=1
  fi
  if [[ "${API_KEY_SET}" -eq 0 && -n "${RIVETHUB_API_KEY:-}" ]]; then
    API_KEY="${RIVETHUB_API_KEY}"
    API_KEY_SET=1
  fi
  if [[ "${PORT_SET}" -eq 0 && -n "${RIVETHUB_PORT:-}" ]]; then
    DEN_PORT="${RIVETHUB_PORT}"
    PORT_SET=1
  fi
  if [[ "${PG_PORT_SET}" -eq 0 && -n "${RIVETHUB_PG_PORT:-}" ]]; then
    PG_PORT="${RIVETHUB_PG_PORT}"
    PG_PORT_SET=1
  fi
  if [[ "${LAN_SET}" -eq 0 && -n "${RIVETHUB_NO_LAN:-}" ]]; then
    if [[ "${RIVETHUB_NO_LAN}" == "1" ]]; then
      FLAG_NO_LAN=1
    else
      FLAG_NO_LAN=0
    fi
    LAN_SET=1
  fi
  if [[ "${SERVICE_SET}" -eq 0 && -n "${RIVETHUB_NO_SERVICE:-}" ]]; then
    if [[ "${RIVETHUB_NO_SERVICE}" == "1" ]]; then
      FLAG_NO_SERVICE=1
    else
      FLAG_NO_SERVICE=0
    fi
    SERVICE_SET=1
  fi
  if [[ "${APP_SET}" -eq 0 && -n "${RIVETHUB_NO_APP:-}" ]]; then
    if [[ "${RIVETHUB_NO_APP}" == "1" ]]; then
      FLAG_NO_APP=1
    else
      FLAG_NO_APP=0
    fi
    APP_SET=1
  fi
  if [[ "${ROOT_SET}" -eq 0 && -n "${RIVETHUB_INSTALL_ROOT:-}" ]]; then
    INSTALL_ROOT="${RIVETHUB_INSTALL_ROOT}"
    ROOT_SET=1
  elif [[ "${ROOT_SET}" -eq 0 && -n "${RIVETOS_INSTALL_ROOT:-}" ]]; then
    INSTALL_ROOT="${RIVETOS_INSTALL_ROOT}"
    ROOT_SET=1
  fi
  if [[ "${REF_SET}" -eq 0 && -n "${RIVETHUB_REF:-}" ]]; then
    REF="${RIVETHUB_REF}"
    REF_SET=1
  fi
  if [[ "${DEVICE_SET}" -eq 0 && -n "${RIVETHUB_DEVICE:-}" ]]; then
    DEVICE="${RIVETHUB_DEVICE}"
    DEVICE_SET=1
  fi
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

pkg_hint() {
  local pkgs="$*"
  printf 'apt install %s / dnf install %s / pacman -S %s / brew install %s' "${pkgs}" "${pkgs}" "${pkgs}" "${pkgs}"
}

preflight_os() {
  local k pretty
  k="$(kernel_name)"
  case "${k}" in
    Linux)
      pretty="Linux"
      if [[ -f "${RIVETHUB_OS_RELEASE:-/etc/os-release}" ]]; then
        # Source in a subshell so os-release VERSION= does not clobber
        # LOCAL_SH_VERSION (Debian/Ubuntu ship VERSION="12 (bookworm)").
        pretty="$(
          # shellcheck source=/dev/null
          . "${RIVETHUB_OS_RELEASE:-/etc/os-release}"
          printf '%s\n' "${PRETTY_NAME:-Linux}"
        )"
      fi
      log "os: ${pretty}"
      ;;
    Darwin)
      log "os: macOS"
      ;;
    *)
      err "unsupported OS '${k}' (need Linux or macOS). Windows is WSL2 later."
      ;;
  esac
}

preflight_arch() {
  local m
  m="$(kernel_arch)"
  case "${m}" in
    x86_64|amd64|aarch64|arm64)
      log "arch: ${m}"
      ;;
    *)
      warn "untested architecture '${m}' (expected x86_64 or aarch64); continuing"
      ;;
  esac
}

preflight_not_root() {
  if [[ "${EUID:-}" == "0" ]]; then
    err "refusing to run as root. Local mode installs into your home directory (~/.rivetos). Re-run as your login user (no sudo)."
  fi
}

preflight_tools() {
  local t missing="" missing_n=0
  for t in git curl openssl tar; do
    if ! have_cmd "${t}"; then
      if [[ ${missing_n} -eq 0 ]]; then
        missing="${t}"
      else
        missing="${missing} ${t}"
      fi
      missing_n=$((missing_n + 1))
    fi
  done
  if [[ ${missing_n} -eq 0 ]]; then
    return 0
  fi
  err "missing required tools: ${missing} (install with: $(pkg_hint "${missing}"))"
}

preflight_tmux() {
  if have_cmd tmux; then
    log "tmux: $(command -v tmux)"
    return 0
  fi
  warn "tmux not found; the den will run without terminal multiplexing (install with: $(pkg_hint tmux))"
}

preflight_disk() {
  local kb target
  if in_test; then
    return 0
  fi
  if ! have_cmd df; then
    warn "df not found; skipping disk check"
    return 0
  fi
  target="${INSTALL_ROOT}"
  while [[ -n "${target}" && "${target}" != "/" && ! -d "${target}" ]]; do
    target="${target%/*}"
    [[ -n "${target}" ]] || target="/"
  done
  kb="$(df -Pk "${target}" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [[ -z "${kb}" ]]; then
    warn "could not read free space on ${target}"
    return 0
  fi
  if [[ "${kb}" -lt 2097152 ]]; then
    err "not enough free disk on ${target} (need ≥ 2 GiB, have ${kb} KiB)"
  fi
  log "disk: ${kb} KiB free on ${target}"
}

port_is_open() {
  local port="$1"
  # bash /dev/tcp (Linux + macOS bash). Failure means closed / unavailable.
  if (: >/dev/tcp/127.0.0.1/"${port}") >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

port_holder() {
  local port="$1" out=""
  if have_cmd lsof; then
    out="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1 " pid " $2; exit}')"
  elif have_cmd ss; then
    # Match :PORT as a whole port (not :51740 when looking for 5174). Parse
    # users:(("name",pid=N)) into the same "name pid N" shape as lsof.
    out="$(ss -ltnp 2>/dev/null | awk -v port="${port}" '
      {
        found = 0
        for (i = 1; i <= NF; i++) {
          n = split($i, a, /:/)
          if (n >= 1 && a[n] == port) { found = 1; break }
        }
        if (!found) next
        if (match($0, /users:\(\("[^"]+",pid=[0-9]+/)) {
          s = substr($0, RSTART, RLENGTH)
          sub(/^users:\(\("/, "", s)
          sub(/",pid=/, " pid ", s)
          print s
          exit
        }
        print
        exit
      }')"
  fi
  printf '%s\n' "${out}"
}

holder_cmd_name() {
  local holder="${1:-}"
  printf '%s\n' "${holder%% *}"
}

holder_pid() {
  local holder="${1:-}"
  printf '%s' "${holder}" | awk '{for (i = 1; i < NF; i++) if ($i == "pid") { print $(i+1); exit }}'
}

owner_lock_pid() {
  local f="${HOME_DIR}/.rivetos/rivetos-owner.lock"
  [[ -f "${f}" ]] || return 1
  sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${f}" | sed -n '1p'
}

systemd_user_mainpid() {
  local pid=""
  have_cmd systemctl || return 1
  pid="$(systemctl --user show -p MainPID --value rivetos.service 2>/dev/null || true)"
  if [[ -z "${pid}" || "${pid}" == "0" ]]; then
    return 1
  fi
  printf '%s\n' "${pid}"
}

launchd_node_pid() {
  local pid=""
  have_cmd launchctl || return 1
  pid="$(launchctl list 2>/dev/null | awk '$3 == "dev.rivetos.node" { print $1; exit }')"
  if [[ -z "${pid}" || "${pid}" == "-" ]]; then
    return 1
  fi
  printf '%s\n' "${pid}"
}

# Occupied ports are ours only when the holder is this install's service
# (command rivetos/RivetHub, systemd user unit rivetos.service, LaunchAgent
# dev.rivetos.node, or rivetos-owner.lock pid). Generic "node pid …" is never
# ours — the den often shows up as node, so ownership must come from the
# unit/lock, not the interpreter name.
holder_is_ours() {
  local holder="${1:-}"
  local name pid our
  name="$(holder_cmd_name "${holder}")"
  pid="$(holder_pid "${holder}")"
  case "${name}" in
    rivetos|RivetHub|rivethub)
      return 0
      ;;
  esac
  if [[ -n "${pid}" ]]; then
    our="$(owner_lock_pid || true)"
    if [[ -n "${our}" && "${our}" == "${pid}" ]]; then
      return 0
    fi
    our="$(systemd_user_mainpid || true)"
    if [[ -n "${our}" && "${our}" == "${pid}" ]]; then
      return 0
    fi
    our="$(launchd_node_pid || true)"
    if [[ -n "${our}" && "${our}" == "${pid}" ]]; then
      return 0
    fi
  fi
  return 1
}

existing_local_install() {
  [[ -d "${INSTALL_ROOT}/.git" || -f "${HOME_DIR}/.rivetos/config.yaml" || -x "${LOCAL_BIN}/rivetos" ]]
}

preflight_port_one() {
  local port="$1" label="$2" holder=""
  if ! port_is_open "${port}"; then
    log "port ${port} (${label}) is free"
    return 0
  fi
  holder="$(port_holder "${port}")"
  if holder_is_ours "${holder}"; then
    log "port ${port} (${label}) is already our local node (${holder}); continuing"
    return 0
  fi
  if [[ -n "${holder}" ]]; then
    err "port ${port} (${label}) is in use by ${holder}. Stop that process or pass --port / --pg-port."
  fi
  err "port ${port} (${label}) is in use. Stop that process or pass --port / --pg-port."
}

preflight_ports() {
  if in_test; then
    return 0
  fi
  preflight_port_one "${DEN_PORT}" "den"
  preflight_port_one "${PG_PORT}" "pglite"
}

preflight() {
  preflight_not_root
  preflight_os
  preflight_arch
  preflight_tools
  preflight_tmux
  preflight_disk
  preflight_ports
}

# ---------------------------------------------------------------------------
# wizard
# ---------------------------------------------------------------------------

fail_unanswered_questions() {
  local line
  if [[ ${#UNANSWERED_QUESTIONS[@]} -eq 0 ]]; then
    return 0
  fi
  printf 'local.sh: cannot prompt (stdin is not a TTY and /dev/tty is unavailable). Unanswered questions:\n' >&2
  for line in "${UNANSWERED_QUESTIONS[@]}"; do
    printf '  - %s\n' "${line}" >&2
  done
  printf 'local.sh: pass the flags or environment variables above, or re-run on a TTY. --yes accepts documented defaults on non-TTY.\n' >&2
  exit 1
}

collect_unanswered_questions() {
  UNANSWERED_QUESTIONS=()
  if [[ "${PROVIDER_SET}" -eq 0 ]]; then
    UNANSWERED_QUESTIONS[${#UNANSWERED_QUESTIONS[@]}]="AI provider (--provider / RIVETHUB_PROVIDER); default: auto-detect"
  fi
  if [[ "${PORT_SET}" -eq 0 ]]; then
    UNANSWERED_QUESTIONS[${#UNANSWERED_QUESTIONS[@]}]="Den port (--port / RIVETHUB_PORT); default: 5174"
  fi
  if [[ "${PG_PORT_SET}" -eq 0 ]]; then
    UNANSWERED_QUESTIONS[${#UNANSWERED_QUESTIONS[@]}]="Postgres port (--pg-port / RIVETHUB_PG_PORT); default: 5433"
  fi
  if [[ "${LAN_SET}" -eq 0 ]]; then
    UNANSWERED_QUESTIONS[${#UNANSWERED_QUESTIONS[@]}]="Advertise on LAN (--no-lan / RIVETHUB_NO_LAN); default: on"
  fi
  if [[ "${SERVICE_SET}" -eq 0 ]]; then
    UNANSWERED_QUESTIONS[${#UNANSWERED_QUESTIONS[@]}]="Install login service (--no-service / RIVETHUB_NO_SERVICE); default: on"
  fi
  if [[ "${APP_SET}" -eq 0 ]]; then
    UNANSWERED_QUESTIONS[${#UNANSWERED_QUESTIONS[@]}]="Install desktop app (--no-app / RIVETHUB_NO_APP); default: on"
  fi
}

apply_noninteractive_defaults() {
  if existing_local_install; then
    WIZARD_ACTION="resume"
    if [[ "${FLAG_YES}" -eq 1 ]]; then
      log "existing install: resume (--yes)"
    fi
  else
    WIZARD_ACTION="fresh"
  fi
  if [[ "${FLAG_YES}" -eq 1 ]]; then
    log "non-TTY --yes: accepting documented defaults for unset fields"
    return 0
  fi
  collect_unanswered_questions
  fail_unanswered_questions
}

prompt_provider_field() {
  if [[ "${PROVIDER_SET}" -eq 1 ]]; then
    return 0
  fi
  prompt_line "AI provider (empty = auto-detect)" ""
  PROVIDER="${WIZARD_REPLY}"
  if [[ -n "${PROVIDER}" ]]; then
    valid_provider "${PROVIDER}" || err "invalid provider '${PROVIDER}' (expected [A-Za-z0-9][A-Za-z0-9._-]*)"
    PROVIDER_SET=1
  fi
}

prompt_port_field() {
  if [[ "${PORT_SET}" -eq 1 ]]; then
    return 0
  fi
  prompt_line "Den port" "${DEN_PORT}"
  DEN_PORT="${WIZARD_REPLY}"
  valid_port "${DEN_PORT}" || err "invalid den port '${DEN_PORT}' (expected 1-65535)"
  PORT_SET=1
}

prompt_pg_port_field() {
  if [[ "${PG_PORT_SET}" -eq 1 ]]; then
    return 0
  fi
  prompt_line "Postgres port" "${PG_PORT}"
  PG_PORT="${WIZARD_REPLY}"
  valid_port "${PG_PORT}" || err "invalid postgres port '${PG_PORT}' (expected 1-65535)"
  PG_PORT_SET=1
}

prompt_lan_field() {
  local reply
  if [[ "${LAN_SET}" -eq 1 ]]; then
    return 0
  fi
  prompt_line "Advertise on the LAN (phone discovery)" "yes"
  reply="${WIZARD_REPLY}"
  if is_no "${reply}"; then
    FLAG_NO_LAN=1
  else
    FLAG_NO_LAN=0
  fi
  LAN_SET=1
}

prompt_service_field() {
  local reply
  if [[ "${SERVICE_SET}" -eq 1 ]]; then
    return 0
  fi
  prompt_line "Install a login service so the node starts at login" "yes"
  reply="${WIZARD_REPLY}"
  if is_no "${reply}"; then
    FLAG_NO_SERVICE=1
  else
    FLAG_NO_SERVICE=0
  fi
  SERVICE_SET=1
}

prompt_app_field() {
  local reply
  if [[ "${APP_SET}" -eq 1 ]]; then
    return 0
  fi
  prompt_line "Install the RivetHub desktop app" "yes"
  reply="${WIZARD_REPLY}"
  if is_no "${reply}"; then
    FLAG_NO_APP=1
  else
    FLAG_NO_APP=0
  fi
  APP_SET=1
}

print_summary() {
  local lan svc app key_state
  if [[ "${FLAG_NO_LAN}" -eq 1 ]]; then
    lan="loopback only"
  else
    lan="on (0.0.0.0 + mDNS)"
  fi
  if [[ "${FLAG_NO_SERVICE}" -eq 1 ]]; then
    svc="no (print rivetos start)"
  else
    svc="yes (user service / LaunchAgent)"
  fi
  if [[ "${FLAG_NO_APP}" -eq 1 ]]; then
    app="no"
  else
    app="yes"
  fi
  if [[ "${API_KEY_SET}" -eq 1 ]]; then
    key_state="set (value never printed)"
  else
    key_state="(none)"
  fi
  cat <<EOF

SUMMARY — about to install RivetHub local mode ${LOCAL_SH_VERSION}

  action:         ${WIZARD_ACTION:-fresh}
  install root:   ${INSTALL_ROOT}
  git ref:        ${REF:-<pins local_ref>}
  den port:       ${DEN_PORT}
  postgres port:  ${PG_PORT}
  LAN:            ${lan}
  login service:  ${svc}
  desktop app:    ${app}
  provider:       ${PROVIDER:-auto-detect}
  api key:        ${key_state}

  packages:       git curl openssl tar; Node ≥ 22 (fnm into ~/.local/share/fnm if missing)
  then:           npm ci --no-audit --no-fund, npm run build, rivetos local --yes
  no sudo, no useradd, system Node is never replaced.

EOF
}

confirm_or_die() {
  local reply
  if [[ "${FLAG_YES}" -eq 1 ]]; then
    log "proceeding (--yes)"
    return 0
  fi
  if ! can_prompt; then
    return 0
  fi
  prompt_line "Proceed? Type yes to continue" "no"
  reply="${WIZARD_REPLY}"
  if is_yes "${reply}"; then
    return 0
  fi
  err "aborted (no confirm). Re-run with --yes to skip this prompt."
}

run_wizard_flow() {
  WIZARD_ACTION="noninteractive"
  if ! can_prompt; then
    apply_noninteractive_defaults
    return 0
  fi
  if ! wizard_open_prompt_fd; then
    apply_noninteractive_defaults
    return 0
  fi
  if existing_local_install; then
    WIZARD_ACTION="resume"
    if [[ "${FLAG_YES}" -eq 1 ]]; then
      log "existing install: resume (--yes)"
    fi
  else
    WIZARD_ACTION="fresh"
  fi
  if [[ "${FLAG_YES}" -eq 0 ]]; then
    prompt_provider_field
    prompt_port_field
    prompt_pg_port_field
    prompt_lan_field
    prompt_service_field
    prompt_app_field
  fi
}

# ---------------------------------------------------------------------------
# ref + clone
# ---------------------------------------------------------------------------

resolve_ref() {
  if [[ "${REF_SET}" -eq 1 && -n "${REF}" ]]; then
    valid_pin_tag "${REF}" || err "invalid ref '${REF}' (expected a git ref name; no '..', leading '-', or spaces)"
    REF_SOURCE="--ref/RIVETHUB_REF"
    log "ref: ${REF} (${REF_SOURCE})"
    return 0
  fi
  REF="$(pin_get local_ref UNPINNED)"
  REF_SOURCE="pins local_ref (${PINS_SOURCE:-unknown})"
  if [[ "${REF}" == "UNPINNED" ]]; then
    warn "pins/stable.json local_ref is UNPINNED; cloning main (not a release pin)"
    REF="main"
    REF_SOURCE="UNPINNED→main"
  fi
  valid_pin_tag "${REF}" || err "pins/stable.json local_ref '${REF}' is not a safe git ref name"
  log "ref: ${REF} (${REF_SOURCE})"
}

ensure_parent_dir() {
  local dest="$1"
  local parent
  parent="$(dirname "${dest}")"
  mkdir -p "${parent}"
}

# After fetch: a branch ref must track origin/$REF (checkout $REF would
# re-check-out the stale local branch and ignore FETCH_HEAD). Tags go
# through tags/$REF. If a single-branch clone only has FETCH_HEAD for a
# newly fetched branch, checkout -B $REF FETCH_HEAD.
checkout_fetched_ref() {
  local dest="$1"
  local ref="$2"
  if git -C "${dest}" show-ref --verify --quiet "refs/remotes/origin/${ref}"; then
    GIT_TERMINAL_PROMPT=0 git -C "${dest}" -c advice.detachedHead=false checkout --force -B "${ref}" "origin/${ref}" \
      || err "git checkout -B '${ref}' origin/${ref} failed in ${dest}"
  elif git -C "${dest}" show-ref --verify --quiet "refs/tags/${ref}"; then
    GIT_TERMINAL_PROMPT=0 git -C "${dest}" -c advice.detachedHead=false checkout --force "tags/${ref}" \
      || err "git checkout tags/${ref} failed in ${dest}"
  elif git -C "${dest}" rev-parse --verify --quiet FETCH_HEAD >/dev/null; then
    GIT_TERMINAL_PROMPT=0 git -C "${dest}" -c advice.detachedHead=false checkout --force -B "${ref}" FETCH_HEAD \
      || err "git checkout -B '${ref}' FETCH_HEAD failed in ${dest}"
  else
    GIT_TERMINAL_PROMPT=0 git -C "${dest}" -c advice.detachedHead=false checkout --force "${ref}" \
      || err "git checkout '${ref}' failed in ${dest}"
  fi
}

clone_or_refresh() {
  local repo dest nonempty=0 entry
  dest="${INSTALL_ROOT}"
  repo="${RIVETOS_GIT_REPO:-https://github.com/${RIVETOS_GITHUB_REPO}.git}"
  ensure_parent_dir "${dest}"
  if in_test; then
    log "RIVETHUB_TEST=1: skipping git clone/refresh of ${repo} @ ${REF}"
    mkdir -p "${dest}"
    return 0
  fi
  if [[ -d "${dest}/.git" ]]; then
    log "checkout ${dest} @ ${REF} (fetch + checkout)"
    # --depth 1 clone --branch is single-branch: remote.origin.fetch only
    # maps the original branch, so a bare `git fetch origin $REF` lands in
    # FETCH_HEAD and never creates origin/$REF. Fetch into that tracking
    # ref explicitly; fall back to a bare ref (tags) then a no-depth fetch.
    GIT_TERMINAL_PROMPT=0 git -C "${dest}" fetch --force --tags --depth 1 origin "${REF}:refs/remotes/origin/${REF}" \
      || GIT_TERMINAL_PROMPT=0 git -C "${dest}" fetch --force --tags --depth 1 origin "${REF}" \
      || GIT_TERMINAL_PROMPT=0 git -C "${dest}" fetch --force --tags origin "${REF}" \
      || err "git fetch of ${repo} ref '${REF}' failed"
    checkout_fetched_ref "${dest}" "${REF}"
    log "checkout ok (${dest} @ ${REF} $(git -C "${dest}" rev-parse --short HEAD 2>/dev/null || true))"
    return 0
  fi
  if [[ -e "${dest}" && ! -d "${dest}" ]]; then
    err "${dest} exists and is not a directory"
  fi
  if [[ -d "${dest}" && -f "${dest}/package.json" ]]; then
    warn "${dest} has package.json but no .git; leaving checkout in place (pass a fresh --install-root to clone)"
    log "checkout ok (existing tree at ${dest})"
    return 0
  fi
  if [[ -d "${dest}" ]]; then
    # Empty or unrelated dir: clone into it only if empty.
    nonempty=0
    for entry in "${dest}"/* "${dest}"/.[!.]* "${dest}"/..?*; do
      if [[ -e "${entry}" || -L "${entry}" ]]; then
        nonempty=1
        break
      fi
    done
    if [[ "${nonempty}" -eq 1 ]]; then
      err "${dest} exists, is not a rivetOS checkout, and is not empty. Pick --install-root or remove it."
    fi
    rmdir "${dest}" 2>/dev/null || true
  fi
  log "cloning ${repo} @ ${REF} into ${dest}"
  # No un-shallow fallback onto main: a typo'd ref must fail naming the ref,
  # not spend minutes cloning the default branch.
  GIT_TERMINAL_PROMPT=0 git -c advice.detachedHead=false clone --branch "${REF}" --depth 1 "${repo}" "${dest}" \
    || err "git clone of ${repo} at ref '${REF}' failed (is '${REF}' a real branch or tag?)"
  log "checkout ok (${dest} @ ${REF} $(git -C "${dest}" rev-parse --short HEAD 2>/dev/null || true))"
}

# ---------------------------------------------------------------------------
# Node ≥ 22 via fnm (never touch system node)
# ---------------------------------------------------------------------------

node_major() {
  node -e 'process.stdout.write(String(parseInt(process.versions.node, 10)))' 2>/dev/null || true
}

ensure_fnm_on_path() {
  if have_cmd fnm; then
    return 0
  fi
  if [[ -x "${FNM_DIR}/fnm" ]]; then
    PATH="${FNM_DIR}:${PATH}"
    export PATH
  fi
}

# Path of the fnm that was actually used (brew, ~/.fnm, FNM_DIR, ...). Empty
# until resolved. Persistence and the banner must use this, not FNM_DIR.
resolve_fnm_bin() {
  if have_cmd fnm; then
    FNM_BIN="$(command -v fnm)"
    return 0
  fi
  if [[ -n "${FNM_DIR}" && -x "${FNM_DIR}/fnm" ]]; then
    FNM_BIN="${FNM_DIR}/fnm"
    return 0
  fi
  return 1
}

activate_fnm() {
  local envout
  ensure_fnm_on_path
  if ! have_cmd fnm; then
    return 1
  fi
  resolve_fnm_bin || true
  # Check fnm env itself; `eval ""` would otherwise succeed on a failed fnm.
  envout="$(fnm env --shell bash)" || return 1
  [[ -n "${envout}" ]] || return 1
  eval "${envout}" || return 1
  return 0
}

fnm_installer_argv_msg() {
  if [[ "$(kernel_name)" == "Darwin" ]]; then
    printf '%s\n' "--install-dir ${FNM_DIR} --skip-shell --force-no-brew"
  else
    printf '%s\n' "--install-dir ${FNM_DIR} --skip-shell"
  fi
}

install_fnm() {
  local installer brew_prefix
  if have_cmd fnm || [[ -x "${FNM_DIR}/fnm" ]]; then
    resolve_fnm_bin || true
    return 0
  fi
  log "installing fnm into ${FNM_DIR} (system Node is not modified)"
  log "fnm installer argv: $(fnm_installer_argv_msg)"
  if in_test; then
    log "RIVETHUB_TEST=1: skipping fnm download"
    mkdir -p "${FNM_DIR}"
    FNM_INSTALLED=1
    FNM_BIN="${FNM_DIR}/fnm"
    return 0
  fi
  if ! have_cmd unzip; then
    err "fnm install needs unzip (install with: $(pkg_hint unzip))"
  fi
  installer="$(mktemp "${TMPDIR:-/tmp}/rivethub-fnm.XXXXXX")"
  register_tmp "${installer}"
  curl -fsSL --max-time 60 -o "${installer}" -- "https://fnm.vercel.app/install" \
    || err "failed to download the fnm installer from https://fnm.vercel.app/install"
  if [[ "$(kernel_name)" == "Darwin" ]]; then
    # Upstream picks Homebrew on Darwin unless --force-no-brew is set; that
    # lands fnm in the brew prefix instead of FNM_DIR and fails without brew.
    bash "${installer}" --install-dir "${FNM_DIR}" --skip-shell --force-no-brew \
      || err "fnm installer failed"
  else
    bash "${installer}" --install-dir "${FNM_DIR}" --skip-shell \
      || err "fnm installer failed"
  fi
  if [[ -x "${FNM_DIR}/fnm" ]] || have_cmd fnm; then
    FNM_INSTALLED=1
    resolve_fnm_bin || FNM_BIN="${FNM_DIR}/fnm"
    return 0
  fi
  if [[ "$(kernel_name)" == "Darwin" ]] && have_cmd brew; then
    warn "fnm standalone install did not produce ${FNM_DIR}/fnm; falling back to Homebrew node@22 (system node is not replaced)"
    brew install node@22 || err "Homebrew node@22 failed after fnm standalone install failed"
    brew_prefix="$(brew --prefix node@22 2>/dev/null || true)"
    if [[ -n "${brew_prefix}" && -d "${brew_prefix}/bin" ]]; then
      NODE_FALLBACK_BIN="${brew_prefix}/bin"
      PATH="${NODE_FALLBACK_BIN}:${PATH}"
      export PATH
    fi
    return 0
  fi
  err "fnm missing after install into ${FNM_DIR}"
}

# Marker comments so re-runs do not duplicate rc snippets.
RC_MARK_PATH="RivetHub local.sh: PATH"
RC_MARK_FNM="RivetHub local.sh: fnm"

rc_has_marker() {
  local rc="$1" marker="$2"
  [[ -f "${rc}" ]] || return 1
  grep -F -q "${marker}" "${rc}" 2>/dev/null
}

append_rc_block() {
  local rc="$1" marker="$2" body="$3"
  if rc_has_marker "${rc}" "${marker}"; then
    return 0
  fi
  if [[ ! -e "${rc}" ]]; then
    : >"${rc}" || err "could not create ${rc}"
  fi
  {
    printf '\n# %s\n' "${marker}"
    printf '%s\n' "${body}"
  } >>"${rc}" || err "could not append to ${rc}"
  log "added ${marker} to ${rc}"
}

# Append to ~/.bashrc (interactive bash), ~/.bash_profile (bash login),
# ~/.zshrc (interactive zsh), and ~/.zprofile (zsh login — default macOS
# Terminal). Create any that are missing so a fresh Mac zsh account or a
# Bash-login account is not left with only a .bashrc.
append_to_login_rcs() {
  local marker="$1" body="$2"
  local rc
  for rc in "${HOME_DIR}/.bashrc" "${HOME_DIR}/.bash_profile" "${HOME_DIR}/.zshrc" "${HOME_DIR}/.zprofile"; do
    append_rc_block "${rc}" "${marker}" "${body}"
  done
}

persist_path_export() {
  local path_value="${LOCAL_BIN}"
  if [[ -n "${NODE_FALLBACK_BIN}" ]]; then
    path_value="${LOCAL_BIN}:${NODE_FALLBACK_BIN}"
  fi
  append_to_login_rcs "${RC_MARK_PATH}" "export PATH=\"${path_value}:\$PATH\""
}

persist_local_bin_path() {
  persist_path_export
}

persist_fnm_init() {
  local body fnm_bin
  [[ "${FNM_INSTALLED}" -eq 1 ]] || return 0
  fnm_bin="${FNM_BIN}"
  if [[ -z "${fnm_bin}" ]]; then
    resolve_fnm_bin || true
    fnm_bin="${FNM_BIN}"
  fi
  if [[ -z "${fnm_bin}" ]]; then
    fnm_bin="${FNM_DIR}/fnm"
  fi
  body="eval \"\$(\"${fnm_bin}\" env)\""
  append_to_login_rcs "${RC_MARK_FNM}" "${body}"
}

persist_shell_init() {
  persist_local_bin_path
  persist_fnm_init
}

ensure_node22() {
  local major=""
  if have_cmd node; then
    major="$(node_major)"
    if [[ -n "${major}" && "${major}" -ge 22 ]]; then
      log "node $(node --version) (>= 22)"
      return 0
    fi
    warn "node $(node --version 2>/dev/null || echo missing) is older than 22; installing Node 22 via fnm (system node is left untouched)"
  else
    log "node not found; installing Node 22 via fnm into ${FNM_DIR}"
  fi
  install_fnm
  # Homebrew node@22 (or any node ≥22 now on PATH) is a real fallback —
  # do not demand fnm if Node 22 is already usable.
  if have_cmd node; then
    major="$(node_major)"
    if [[ -n "${major}" && "${major}" -ge 22 ]]; then
      log "node $(node --version) (>= 22)"
      return 0
    fi
  fi
  activate_fnm || err "could not activate fnm (fnm env --shell bash)"
  log "fnm install 22"
  fnm install 22 || err "fnm install 22 failed"
  fnm use 22 || err "fnm use 22 failed"
  have_cmd node || err "node not on PATH after fnm use 22"
  major="$(node_major)"
  if [[ -z "${major}" || "${major}" -lt 22 ]]; then
    err "node $(node --version) is still < 22 after fnm install"
  fi
  FNM_INSTALLED=1
  resolve_fnm_bin || true
  log "node $(node --version) (fnm)"
}

# ---------------------------------------------------------------------------
# build + link
# ---------------------------------------------------------------------------

ensure_local_bin_on_path() {
  case ":${PATH}:" in
    *":${LOCAL_BIN}:"*) ;;
    *) PATH="${LOCAL_BIN}:${PATH}"; export PATH ;;
  esac
}

build_rivetos() {
  if in_test; then
    log "RIVETHUB_TEST=1: skipping npm ci / build / link-cli"
    mkdir -p "${INSTALL_ROOT}/node_modules/.bin" "${LOCAL_BIN}"
    return 0
  fi
  [[ -f "${INSTALL_ROOT}/package.json" ]] || err "no package.json at ${INSTALL_ROOT}; clone failed"
  log "this takes a few minutes: npm ci"
  ( cd "${INSTALL_ROOT}" && npm ci --no-audit --no-fund ) || err "npm ci failed in ${INSTALL_ROOT}"
  log "npm ci ok"
  log "this takes a few minutes: npm run build"
  ( cd "${INSTALL_ROOT}" && npm run build ) || err "npm run build failed in ${INSTALL_ROOT}"
  log "build ok"
  if [[ -f "${INSTALL_ROOT}/scripts/link-cli.mjs" ]]; then
    log "link-cli"
    ( cd "${INSTALL_ROOT}" && node scripts/link-cli.mjs ) || err "node scripts/link-cli.mjs failed"
  else
    warn "scripts/link-cli.mjs not found; relying on node_modules/.bin/rivetos"
  fi
}

link_rivetos_bin() {
  local src=""
  mkdir -p "${LOCAL_BIN}"
  ensure_local_bin_on_path
  case ":${PATH}:" in
    *":${INSTALL_ROOT}/node_modules/.bin:"*) ;;
    *) PATH="${INSTALL_ROOT}/node_modules/.bin:${PATH}"; export PATH ;;
  esac
  if in_test; then
    log "RIVETHUB_TEST=1: PATH includes ${INSTALL_ROOT}/node_modules/.bin and ${LOCAL_BIN}"
    return 0
  fi
  if [[ -x "${INSTALL_ROOT}/node_modules/.bin/rivetos" ]]; then
    src="${INSTALL_ROOT}/node_modules/.bin/rivetos"
  elif have_cmd rivetos; then
    src="$(command -v rivetos)"
  fi
  if [[ -z "${src}" ]]; then
    err "rivetos CLI not found after build (expected ${INSTALL_ROOT}/node_modules/.bin/rivetos)"
  fi
  ln -sfn "${src}" "${LOCAL_BIN}/rivetos" || err "failed to symlink ${LOCAL_BIN}/rivetos"
  log "linked ${LOCAL_BIN}/rivetos -> ${src}"
}

# ---------------------------------------------------------------------------
# rivetos local --yes
# ---------------------------------------------------------------------------

run_rivetos_local() {
  local -a cmd
  cmd=(rivetos local --yes)
  cmd[${#cmd[@]}]="--port"
  cmd[${#cmd[@]}]="${DEN_PORT}"
  cmd[${#cmd[@]}]="--pg-port"
  cmd[${#cmd[@]}]="${PG_PORT}"
  if [[ -n "${PROVIDER}" ]]; then
    cmd[${#cmd[@]}]="--provider"
    cmd[${#cmd[@]}]="${PROVIDER}"
  fi
  if [[ "${API_KEY_SET}" -eq 1 ]]; then
    cmd[${#cmd[@]}]="--api-key"
    cmd[${#cmd[@]}]="${API_KEY}"
  fi
  if [[ "${FLAG_NO_LAN}" -eq 1 ]]; then
    cmd[${#cmd[@]}]="--no-lan"
  fi
  if [[ "${FLAG_NO_SERVICE}" -eq 1 ]]; then
    cmd[${#cmd[@]}]="--no-service"
  fi
  if [[ -n "${DEVICE}" ]]; then
    cmd[${#cmd[@]}]="--device"
    cmd[${#cmd[@]}]="${DEVICE}"
  fi
  have_cmd rivetos || err "rivetos not on PATH after link; add ${LOCAL_BIN} to PATH and re-run"
  if in_test; then
    log "RIVETHUB_TEST=1: invoking rivetos local --yes (fake in PATH; flags forwarded, key not logged here)"
    "${cmd[@]}" || err "rivetos local --yes failed (test fake)"
    return 0
  fi
  log "this takes a few minutes: PGlite warm-up (first run) + rivetos local"
  "${cmd[@]}" || err "rivetos local --yes failed"
  log "rivetos local ok"
}

# ---------------------------------------------------------------------------
# desktop app
# ---------------------------------------------------------------------------

sha256_file() {
  local f="$1"
  if have_cmd sha256sum; then
    sha256sum -- "${f}" | awk '{print $1}'
  elif have_cmd shasum; then
    shasum -a 256 -- "${f}" | awk '{print $1}'
  else
    openssl dgst -sha256 "${f}" | awk '{print $NF}'
  fi
}

valid_app_filename() {
  local n="${1:-}"
  [[ -n "${n}" ]] || return 1
  [[ "${n}" != *..* ]] || return 1
  [[ "${n}" =~ ^[A-Za-z0-9._+-]+$ ]]
}

valid_sha256() {
  [[ "${1:-}" =~ ^[a-fA-F0-9]{64}$ ]]
}

# Desktop Entry spec: quote Exec args that contain reserved characters;
# escape \, ", $, ` inside quotes; a literal % is %%.
desktop_escape_exec() {
  local s="${1:-}"
  local escaped
  escaped="$(printf '%s' "${s}" | sed -e 's/%/%%/g')"
  case "${escaped}" in
    *' '*|*$'\t'*|*\"*|*"'"*|*'\\'*|*'$'*|*'`'*|*'#'*)
      escaped="$(printf '%s' "${escaped}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/\\$/g' -e 's/`/\\`/g')"
      printf '"%s"' "${escaped}"
      ;;
    *)
      printf '%s' "${escaped}"
      ;;
  esac
}

write_desktop_entry() {
  local exec_path="$1"
  local exec_esc fuse_env=""
  exec_esc="$(desktop_escape_exec "${exec_path}")"
  if ! has_libfuse2; then
    fuse_env="env APPIMAGE_EXTRACT_AND_RUN=1 "
  fi
  mkdir -p "${DESKTOP_DIR}"
  cat >"${DESKTOP_DIR}/rivethub.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=RivetHub
Comment=RivetHub — local mesh of one
Exec=${fuse_env}${exec_esc} --ozone-platform-hint=auto
Terminal=false
Categories=Development;Network;
StartupNotify=true
EOF
  log "wrote ${DESKTOP_DIR}/rivethub.desktop"
}

desktop_launch_log() {
  printf '%s\n' "${HOME_DIR}/.rivetos/logs/desktop-launch.log"
}

launch_desktop_linux() {
  local bin="$1"
  local logf pid extract=""
  logf="$(desktop_launch_log)"
  mkdir -p "$(dirname "${logf}")"
  if [[ ! -x "${bin}" ]]; then
    warn "desktop binary ${bin} is not executable; not launching"
    return 0
  fi
  if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
    warn "no DISPLAY or WAYLAND_DISPLAY; desktop app needs a graphical seat"
  fi
  if ! has_libfuse2; then
    extract=1
    log "libfuse.so.2 not found; launching with APPIMAGE_EXTRACT_AND_RUN=1"
  fi
  if [[ -n "${extract}" ]]; then
    log "launching desktop app (detached): env APPIMAGE_EXTRACT_AND_RUN=1 ${bin} --ozone-platform-hint=auto"
    nohup env APPIMAGE_EXTRACT_AND_RUN=1 "${bin}" --ozone-platform-hint=auto >"${logf}" 2>&1 &
  else
    log "launching desktop app (detached): ${bin} --ozone-platform-hint=auto"
    nohup "${bin}" --ozone-platform-hint=auto >"${logf}" 2>&1 &
  fi
  pid=$!
  # Reap a crash-on-start binary before treating kill -0 as "still running"
  # (a zombie still succeeds kill -0; disown first would leave it unreaped).
  sleep 1
  if ! kill -0 "${pid}" 2>/dev/null; then
    wait "${pid}" 2>/dev/null || true
    warn "desktop app exited immediately (pid ${pid}). See ${logf}"
    return 0
  fi
  disown "${pid}" 2>/dev/null || disown 2>/dev/null || true
  log "desktop app launched (pid ${pid}); log ${logf}"
}

copy_or_curl() {
  local src="$1"
  local dest="$2"
  local timeout="${3:-30}"
  if [[ -f "${src}" ]]; then
    cp "${src}" "${dest}"
    return 0
  fi
  case "${src}" in
    file://*)
      cp "${src#file://}" "${dest}"
      return 0
      ;;
  esac
  if in_test; then
    return 1
  fi
  curl -fsSL --max-time "${timeout}" -o "${dest}" -- "${src}"
}

fetch_latest_json() {
  local dest="$1"
  local src="${RIVETHUB_RELEASES_JSON:-https://rivethub.io/releases/latest.json}"
  if copy_or_curl "${src}" "${dest}" 30; then
    [[ -s "${dest}" ]] || return 1
    return 0
  fi
  return 1
}

release_file_url() {
  local file="$1"
  local base="${RIVETHUB_RELEASES_BASE:-https://rivethub.io/releases}"
  case "${base}" in
    */) printf '%s%s\n' "${base}" "${file}" ;;
    *) printf '%s/%s\n' "${base}" "${file}" ;;
  esac
}

download_release_file() {
  local url="$1"
  local dest="$2"
  local base_dir
  base_dir="${RIVETHUB_RELEASES_BASE:-}"
  if [[ -n "${base_dir}" && -d "${base_dir}" ]]; then
    if [[ -f "${base_dir}/${url##*/}" ]]; then
      cp "${base_dir}/${url##*/}" "${dest}"
      return 0
    fi
  fi
  copy_or_curl "${url}" "${dest}" 300
}

verify_sha256_or_err() {
  local file="$1"
  local expected="$2"
  local label="$3"
  local got
  got="$(sha256_file "${file}")"
  if [[ "${got}" != "${expected}" ]]; then
    err "${label} sha256 mismatch (got ${got}, expected ${expected}). Refusing to install."
  fi
}

install_desktop_linux() {
  local json tmp sha file url dest
  dest="${APPIMAGE_PATH}"
  json="$(mktemp "${TMPDIR:-/tmp}/rivethub-latest.XXXXXX")"
  register_tmp "${json}"
  if ! fetch_latest_json "${json}"; then
    warn "could not fetch ${RIVETHUB_RELEASES_JSON:-https://rivethub.io/releases/latest.json}; skipping desktop app (open https://localhost:${DEN_PORT} in a browser)"
    return 0
  fi
  file="$(json_app_field "${json}" linux file "")"
  sha="$(json_app_field "${json}" linux sha256 "")"
  if [[ -z "${file}" ]]; then
    warn "releases/latest.json has no apps.linux.file; skipping desktop app"
    return 0
  fi
  valid_app_filename "${file}" || err "apps.linux.file '${file}' is not a safe filename"
  if [[ -n "${sha}" ]]; then
    valid_sha256 "${sha}" || err "apps.linux.sha256 is not a 64-char hex digest"
  else
    err "apps.linux.sha256 missing; refusing to install an unverified AppImage"
  fi
  url="$(release_file_url "${file}")"
  mkdir -p "$(dirname "${dest}")"
  tmp="$(mktemp "${TMPDIR:-/tmp}/rivethub-appimage.XXXXXX")"
  register_tmp "${tmp}"
  log "downloading ${url}"
  download_release_file "${url}" "${tmp}" || err "failed to download ${url}"
  verify_sha256_or_err "${tmp}" "${sha}" "AppImage"
  chmod +x "${tmp}"
  mv -f "${tmp}" "${dest}"
  chmod +x "${dest}"
  log "installed ${dest}"
  write_desktop_entry "${dest}"
  if have_cmd update-desktop-database; then
    update-desktop-database "${DESKTOP_DIR}" || warn "update-desktop-database ${DESKTOP_DIR} failed (non-fatal)"
  fi
  launch_desktop_linux "${dest}"
}

find_unpacked_app() {
  local unpack="$1"
  local found=""
  if [[ -d "${unpack}/RivetHub.app" ]]; then
    printf '%s\n' "${unpack}/RivetHub.app"
    return 0
  fi
  found="$(find "${unpack}" -maxdepth 3 -name '*.app' -type d 2>/dev/null | sed -n '1p')"
  if [[ -n "${found}" ]]; then
    printf '%s\n' "${found}"
    return 0
  fi
  return 1
}

install_darwin_zip() {
  local archive="$1"
  local dest_app="$2"
  local unpack app_src
  have_cmd unzip || err "macOS .app zip install needs unzip (install with: $(pkg_hint unzip))"
  unpack="$(mktemp -d "${TMPDIR:-/tmp}/rivethub-darwin.XXXXXX")"
  register_tmp_dir "${unpack}"
  unzip -q -o "${archive}" -d "${unpack}" || err "unzip of Darwin desktop archive failed"
  app_src="$(find_unpacked_app "${unpack}")" || err "Darwin archive has no .app bundle"
  mkdir -p "$(dirname "${dest_app}")"
  rm -rf "${dest_app}"
  cp -R "${app_src}" "${dest_app}" || err "failed to copy ${app_src} to ${dest_app}"
}

install_darwin_dmg() {
  local archive="$1"
  local dest_app="$2"
  local mnt app_src
  have_cmd hdiutil || err "apps.darwin.file is a dmg; hdiutil is required"
  mnt="$(mktemp -d "${TMPDIR:-/tmp}/rivethub-dmg.XXXXXX")"
  register_tmp_dir "${mnt}"
  hdiutil attach -nobrowse -mountpoint "${mnt}" "${archive}" \
    || err "hdiutil attach failed for Darwin desktop dmg"
  app_src="$(find_unpacked_app "${mnt}")" || {
    hdiutil detach "${mnt}" >/dev/null 2>&1 || true
    err "Darwin dmg has no .app bundle"
  }
  mkdir -p "$(dirname "${dest_app}")"
  rm -rf "${dest_app}"
  cp -R "${app_src}" "${dest_app}" || {
    hdiutil detach "${mnt}" >/dev/null 2>&1 || true
    err "failed to copy ${app_src} to ${dest_app}"
  }
  hdiutil detach "${mnt}" >/dev/null 2>&1 || warn "hdiutil detach failed (non-fatal)"
}

install_desktop_darwin() {
  local json tmp sha file url dest_app
  dest_app="${APPLICATIONS_DIR}/RivetHub.app"
  json="$(mktemp "${TMPDIR:-/tmp}/rivethub-latest.XXXXXX")"
  register_tmp "${json}"
  if ! fetch_latest_json "${json}"; then
    log "macOS desktop app is coming — use https://localhost:${DEN_PORT} in the browser"
    return 0
  fi
  file="$(json_app_field "${json}" darwin file "")"
  sha="$(json_app_field "${json}" darwin sha256 "")"
  if [[ -z "${file}" ]]; then
    log "macOS desktop app is coming — use https://localhost:${DEN_PORT} in the browser"
    return 0
  fi
  valid_app_filename "${file}" || err "apps.darwin.file '${file}' is not a safe filename"
  if [[ -n "${sha}" ]]; then
    valid_sha256 "${sha}" || err "apps.darwin.sha256 is not a 64-char hex digest"
  else
    err "apps.darwin.sha256 missing; refusing to install an unverified macOS app"
  fi
  url="$(release_file_url "${file}")"
  tmp="$(mktemp "${TMPDIR:-/tmp}/rivethub-darwin.XXXXXX")"
  register_tmp "${tmp}"
  log "downloading ${url}"
  download_release_file "${url}" "${tmp}" || err "failed to download ${url}"
  verify_sha256_or_err "${tmp}" "${sha}" "Darwin app"
  case "${file}" in
    *.zip)
      install_darwin_zip "${tmp}" "${dest_app}"
      ;;
    *.dmg)
      install_darwin_dmg "${tmp}" "${dest_app}"
      ;;
    *)
      err "apps.darwin.file '${file}' must be a .zip or .dmg (electron-builder mac targets)"
      ;;
  esac
  if have_cmd xattr; then
    xattr -d com.apple.quarantine "${dest_app}" 2>/dev/null || true
  fi
  log "installed ${dest_app}"
  if ! in_test && [[ "$(kernel_name)" == "Darwin" ]] && have_cmd open; then
    open "${dest_app}" || warn "failed to launch ${dest_app}; open https://localhost:${DEN_PORT} in the browser"
  fi
}

install_desktop_app() {
  local k
  if [[ "${FLAG_NO_APP}" -eq 1 ]]; then
    log "skipping desktop app (--no-app)"
    return 0
  fi
  k="$(kernel_name)"
  case "${k}" in
    Linux)
      install_desktop_linux
      ;;
    Darwin)
      install_desktop_darwin
      ;;
    *)
      warn "no desktop app for OS '${k}'"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# banner
# ---------------------------------------------------------------------------

print_banner() {
  local lan="(loopback only)"
  local harness="" status=""
  local path_lines fnm_bin
  if [[ "${FLAG_NO_LAN}" -eq 0 ]]; then
    lan="LAN discovery on port ${DEN_PORT}"
  fi
  if have_cmd rivetos; then
    status="$(rivetos local status 2>/dev/null || true)"
  fi
  if [[ -n "${status}" ]]; then
    harness="${status}"
  else
    harness="(run: rivetos local status)"
  fi
  if [[ -n "${NODE_FALLBACK_BIN}" ]]; then
    path_lines="  export PATH=\"${LOCAL_BIN}:${NODE_FALLBACK_BIN}:\$PATH\""
  else
    path_lines="  export PATH=\"${LOCAL_BIN}:\$PATH\""
  fi
  if [[ "${FNM_INSTALLED}" -eq 1 ]]; then
    fnm_bin="${FNM_BIN}"
    if [[ -z "${fnm_bin}" ]]; then
      resolve_fnm_bin || true
      fnm_bin="${FNM_BIN}"
    fi
    if [[ -z "${fnm_bin}" ]]; then
      fnm_bin="${FNM_DIR}/fnm"
    fi
    path_lines="${path_lines}
  eval \"\$(\"${fnm_bin}\" env)\""
  fi
  cat <<EOF

RivetHub local mode ${LOCAL_SH_VERSION} is installed.

  node:           https://localhost:${DEN_PORT}
  LAN:            ${lan}
  checkout:       ${INSTALL_ROOT} @ ${REF:-?}
  CLI:            ${LOCAL_BIN}/rivetos

Next shells — add to ~/.bashrc or ~/.zshrc so PATH persists:
${path_lines}

Detected harnesses:
${harness}

Pair a phone: open RivetHub → Settings → Devices → QR.

Day-2:
  rivetos local status
  rivetos local backup
  rivetos local reset

Docs: https://rivethub.io/install-local.html

EOF
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

local_main() {
  parse_args "$@"
  if [[ "${FLAG_HELP}" -eq 1 ]]; then
    usage
    return 0
  fi
  init_paths
  run_wizard_flow
  resolve_ref
  preflight
  if can_prompt; then
    print_summary
  fi
  confirm_or_die
  clone_or_refresh
  ensure_node22
  build_rivetos
  link_rivetos_bin
  run_rivetos_local
  persist_shell_init
  install_desktop_app
  print_banner
}

# True when executed (bash script.sh, ./script, curl | bash -s). False when
# sourced. Do not use BASH_SOURCE==$0 — under bash -s they differ and the
# installer would silently exit 0.
if ! (return 0 2>/dev/null); then
  local_main "$@"
fi
