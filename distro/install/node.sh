#!/usr/bin/env bash
# RivetHub agent-node installer
#
#   sudo bash install/node.sh [--docker] [--hub user@host] [--name NAME] \
#        [--advertise-host HOST] [--answers-file FILE] [--yes] [--force]
#
# Curl-pipe is supported:
#   curl -fsSL https://get.rivethub.io/node.sh | bash -s -- --hub user@192.0.2.10
#
# Installs an AGENT node: rivet user, Node 22+, pinned rivetOS checkout (or
# GHCR image with --docker), `rivetos init`, mesh enroll over SSH against a
# datahub, systemd unit. Debian 12 / Ubuntu LTS. Bare-metal systemd is
# first-class; --docker is the alternative.
#
# Enrollment talks to the datahub TODAY without `rivetos mesh enroll`
# (that CLI wrapper is not merged). enroll_via_ssh is the replaceable
# function: ssh <user@datahub> rivethub-hub enroll <node> <this-host> →
# base64 tarball on stdout → unpack into the local RIVETOS_SHARED_DIR.
#
# Read this file. Curl-pipe installers should be boring.
#
# Layout:
#   $RIVETOS_INSTALL_ROOT     rivetOS checkout (default /opt/rivetos)
#   $RIVETOS_SHARED_DIR       local mesh.json + rivet-ca (default
#                             /var/lib/rivethub/shared)
#   /rivet-shared             symlink → $RIVETOS_SHARED_DIR so rivetOS
#                             hardcoded TLS paths work without new runtime
#   /home/rivet/.rivetos      config.yaml + .env (User=rivet)
#
# Pins: every fetch from rivetOS uses pins/stable.json (rivetos_tag, image).
# Checkout: sibling pins/stable.json. Curl-pipe: fetch
# https://get.rivethub.io/pins/stable.json, else the embedded copy of that
# file (kept in sync here). Values are still UNPINNED placeholders — clone
# falls back to the default branch with a loud warning; --docker falls back
# to a floating GHCR tag. Reviewer gate: a real rivetos_tag plus digest-form
# image; until then the gate warns (does not block).
#
# Wizard / TTY (parity with datahub.sh C2b + e2e F1/F2/F4):
#   Prompts are NOT read from the script pipe. When /dev/tty can actually
#   be opened (or stdin is a TTY), unset fields are asked, then a SUMMARY,
#   then an explicit yes before mutation unless --yes. --yes skips confirm;
#   on non-TTY it also accepts documented defaults (name = hostname,
#   advertise-host = hostname -f). --hub has no default: non-TTY without
#   --hub / RIVETHUB_HUB / a recorded node.env HUB_TARGET errors, listing
#   every unanswerable question at once. RIVETHUB_PROMPT_IN is the test
#   seam (one line per prompt). RIVETHUB_TEST=1 never opens /dev/tty.
#
# Test-only: RIVETHUB_TEST=1 skips root/apt/useradd/git/npm/systemctl/docker
# so the bats suite can exercise parse/preflight/enroll/banner with fakes
# in PATH. Do not set this on a real host.

set -euo pipefail

VERSION="0.1.0"

# Defaults (overridden by parse_args / env).
FLAG_DOCKER=0
FLAG_HELP=0
FLAG_FORCE=0
FLAG_YES=0
HUB_TARGET=""
HUB_SET=0
NODE_NAME=""
NAME_SET=0
ADVERTISE_HOST=""
ANSWERS_FILE=""
PREV_NODE_NAME=""
PREV_HUB_TARGET=""
PREV_ADVERTISE_HOST=""
IDENTITY_DRIFT=0
_WIZARD_PROMPT_FD=""
WIZARD_REPLY=""
UNANSWERED_QUESTIONS=()
WIZARD_ACTION=""

RIVET_HOME=""
RIVET_UID=""
RIVET_GID=""
INSTALL_ROOT=""
SHARED_DIR=""
HUB_ROOT=""
CONFIG_YAML=""
ENV_FILE=""
NODE_ENV_FILE=""
SYSTEMD_DIR=""
DISTRO_ROOT=""
PINS_FILE=""
RIVET_UID_RECORDED=""

# rivetOS GitHub (DEPLOYMENT.md clone URL). Not a pin field — see notes.
RIVETOS_GITHUB_REPO="philbert440/rivetOS"

# Agent-channel port. Matches rivethub-hub MESH_PORT / AgentChannelServer.
MESH_PORT=3000

# Preferred rivet uid/gid (provision-ct.sh). Used if free.
WANT_UID=2000
WANT_GID=2000

# ---------------------------------------------------------------------------
# logging — secrets never go through log()
# ---------------------------------------------------------------------------

log() { printf 'node.sh: %s\n' "$*" >&2; }
err() { printf 'node.sh: %s\n' "$*" >&2; exit 1; }
warn() { printf 'node.sh: warning: %s\n' "$*" >&2; }

in_test() { [[ "${RIVETHUB_TEST:-}" == "1" ]]; }

_RIVETHUB_TMP_FILES=()
_RIVETHUB_TMP_DIRS=()
register_tmp() { _RIVETHUB_TMP_FILES+=("$1"); }
register_tmp_dir() { _RIVETHUB_TMP_DIRS+=("$1"); }
cleanup_tmp() {
  local f d
  for f in "${_RIVETHUB_TMP_FILES[@]+"${_RIVETHUB_TMP_FILES[@]}"}"; do
    rm -f "${f}"
  done
  for d in "${_RIVETHUB_TMP_DIRS[@]+"${_RIVETHUB_TMP_DIRS[@]}"}"; do
    rm -rf "${d}"
  done
  _RIVETHUB_TMP_FILES=()
  _RIVETHUB_TMP_DIRS=()
  wizard_close_prompt_fd
}
trap cleanup_tmp EXIT

# ---------------------------------------------------------------------------
# wizard I/O — /dev/tty for curl-pipe; RIVETHUB_PROMPT_IN is the test seam
# (parity with install/datahub.sh)
# ---------------------------------------------------------------------------

wizard_close_prompt_fd() {
  if [[ -z "${_WIZARD_PROMPT_FD:-}" || "${_WIZARD_PROMPT_FD}" == "0" ]]; then
    _WIZARD_PROMPT_FD=""
    return 0
  fi
  if [[ "${_WIZARD_PROMPT_FD}" =~ ^[0-9]+$ ]]; then
    eval "exec ${_WIZARD_PROMPT_FD}<&-" || true
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
  if [[ -n "${_WIZARD_PROMPT_FD:-}" ]]; then
    return 0
  fi
  if [[ -n "${RIVETHUB_PROMPT_IN:-}" ]]; then
    if [[ ! -r "${RIVETHUB_PROMPT_IN}" ]]; then
      return 1
    fi
    if exec {_WIZARD_PROMPT_FD}<"${RIVETHUB_PROMPT_IN}"; then
      return 0
    fi
    return 1
  fi
  if in_test; then
    return 1
  fi
  if [[ -e /dev/tty && -r /dev/tty ]]; then
    if exec {_WIZARD_PROMPT_FD}<>/dev/tty; then
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
  case "${1,,}" in
    y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# usage
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: node.sh [options]

Install a RivetHub agent node on Debian 12 or Ubuntu LTS and enroll it
against a datahub over SSH. Re-running is safe (idempotent). Version ${VERSION}.

On a terminal, unset fields are prompted (defaults shown), then a SUMMARY,
then an explicit yes before any write. --yes skips the confirm. On non-TTY
(plain ssh, no controlling terminal), --yes also accepts documented defaults
(name = hostname, advertise-host = hostname -f). --hub has no default.

Options:
  --docker                 Run the pinned GHCR image (pins/stable.json image)
                           under systemd with host networking on mesh port
                           ${MESH_PORT}, instead of a bare-metal checkout.
  --hub USER@HOST          Datahub SSH target that can run rivethub-hub
                           (example: owner@192.0.2.10). Required when stdin
                           is not a TTY and \$RIVETHUB_ROOT/node.env has no
                           recorded HUB_TARGET (re-run resumes from that file).
  --name NAME              Mesh node name (certificate CN). [a-z0-9-], max 63,
                           no leading/trailing hyphen. Default: hostname.
  --advertise-host HOST    Address other nodes should use to reach THIS
                           node (DNS or RFC 5737 example 192.0.2.11).
                           Defaults to hostname -f.
  --answers-file FILE      Passed through to \`rivetos init --answers-file\`
                           (the wizard does not implement this flag yet;
                           provided so a future CLI can consume it).
  -y, --yes                Skip the pre-mutation confirm. On non-TTY, also
                           accept documented defaults for unset fields.
  --force                  Re-clone / rewrite the systemd unit even if a
                           previous install is present.
  -h, --help               Show this help.

Environment:
  RIVETHUB_HUB             Default for --hub
  RIVETHUB_ADVERTISE_HOST  Default for --advertise-host
  RIVETHUB_ROOT            Hub/state root (default /var/lib/rivethub)
  RIVETOS_INSTALL_ROOT     Checkout path (default /opt/rivetos)
  RIVETOS_SHARED_DIR       Local mesh dir (default /var/lib/rivethub/shared)
  RIVETOS_HOME             rivet user home (default /home/rivet)
  RIVETHUB_DISTRO_DIR      Checkout containing pins/stable.json
  RIVETHUB_PINS_FILE       Override path to pins/stable.json
  RIVETHUB_PINS_URL        Override pins fetch URL (default
                           https://get.rivethub.io/pins/stable.json)
  RIVETHUB_AGENT_IMAGE     Override GHCR image when the pin is UNPINNED
  RIVETOS_GIT_REPO         Override clone URL
  RIVETHUB_PROMPT_IN       Test seam: file of wizard answers, one per prompt.

SSH keys: the installer runs as root, so BatchMode ssh uses /root/.ssh —
copy your key there (or ssh-copy-id as root) before a curl-pipe / sudo run.
It also generates ${RIVETOS_HOME:-/home/rivet}/.ssh/id_ed25519 for the rivet
user and installs that pubkey on --hub (via the root hop) so day-2
\`sudo -u rivet -H rivetos mesh sync\` / renew work without a second
ssh-copy-id.

Examples:
  sudo bash install/node.sh --hub owner@192.0.2.10 --name node-a --advertise-host 192.0.2.11
  curl -fsSL https://get.rivethub.io/node.sh | bash -s -- --hub owner@192.0.2.10 --yes
  sudo bash install/node.sh --docker --hub owner@192.0.2.10 --name node-b --yes
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
  src="${BASH_SOURCE[0]:-}"
  if [[ -n "${src}" && -f "${src}" ]]; then
    here="$(cd "$(dirname "${src}")" && pwd)" || return 1
    parent="$(cd "${here}/.." && pwd)" || return 1
    if [[ -f "${parent}/pins/stable.json" || -f "${parent}/bin/rivethub-hub" ]]; then
      printf '%s\n' "${parent}"
      return 0
    fi
  fi
  return 1
}

init_paths() {
  HUB_ROOT="${RIVETHUB_ROOT:-/var/lib/rivethub}"
  SHARED_DIR="${RIVETOS_SHARED_DIR:-${HUB_ROOT}/shared}"
  INSTALL_ROOT="${RIVETOS_INSTALL_ROOT:-/opt/rivetos}"
  RIVET_HOME="${RIVETOS_HOME:-/home/rivet}"
  CONFIG_YAML="${RIVET_HOME}/.rivetos/config.yaml"
  ENV_FILE="${RIVET_HOME}/.rivetos/.env"
  NODE_ENV_FILE="${HUB_ROOT}/node.env"
  SYSTEMD_DIR="${RIVETHUB_SYSTEMD_DIR:-/etc/systemd/system}"
  DISTRO_ROOT=""
  if DISTRO_ROOT="$(discover_distro_root)"; then
    :
  else
    DISTRO_ROOT=""
  fi
  if [[ -n "${RIVETHUB_PINS_FILE:-}" && -f "${RIVETHUB_PINS_FILE}" ]]; then
    PINS_FILE="${RIVETHUB_PINS_FILE}"
  elif [[ -n "${DISTRO_ROOT}" && -f "${DISTRO_ROOT}/pins/stable.json" ]]; then
    PINS_FILE="${DISTRO_ROOT}/pins/stable.json"
  else
    PINS_FILE=""
    ensure_pins_file
  fi
}

# ---------------------------------------------------------------------------
# pins/stable.json — UNPINNED placeholders are expected
#
# Curl-pipe has no sibling pins/. Fetch get.rivethub.io/pins/stable.json;
# if that fails, write the embedded copy (must match pins/stable.json).
# ---------------------------------------------------------------------------

# Keep in sync with pins/stable.json.
write_embedded_pins() {
  cat >"$1" <<'EOF'
{
  "rivetos_tag": "UNPINNED",
  "image": "ghcr.io/philbert440/rivetos:UNPINNED",
  "rivet_ca_sha256": "UNPINNED",
  "hub_helper_version": "0.1.0",
  "pgvector_image": "UNPINNED"
}
EOF
}

fetch_remote_pins() {
  local dest="$1"
  local url="${RIVETHUB_PINS_URL:-https://get.rivethub.io/pins/stable.json}"
  have_cmd curl || return 1
  curl -fsSL --max-time 15 -o "${dest}" -- "${url}" || return 1
  [[ -s "${dest}" ]] || return 1
  python3 - "${dest}" <<'PY' || return 1
import json, sys
json.load(open(sys.argv[1], encoding="utf-8"))
PY
}

ensure_pins_file() {
  local fetched=""
  if [[ -n "${PINS_FILE}" && -f "${PINS_FILE}" ]]; then
    return 0
  fi
  if ! in_test || [[ -n "${RIVETHUB_PINS_URL:-}" ]]; then
    fetched="$(mktemp "${TMPDIR:-/tmp}/rivethub-pins.XXXXXX.json")"
    register_tmp "${fetched}"
    if fetch_remote_pins "${fetched}"; then
      PINS_FILE="${fetched}"
      log "loaded pins from ${RIVETHUB_PINS_URL:-https://get.rivethub.io/pins/stable.json}"
      return 0
    fi
    rm -f "${fetched}"
    warn "could not fetch pins/stable.json from ${RIVETHUB_PINS_URL:-https://get.rivethub.io}; using embedded pin values"
  fi
  fetched="$(mktemp "${TMPDIR:-/tmp}/rivethub-pins.XXXXXX.json")"
  register_tmp "${fetched}"
  write_embedded_pins "${fetched}"
  PINS_FILE="${fetched}"
}

# Real rivetos_tag (not UNPINNED) + digest-form image. Warns; does not block
# while pins/stable.json still holds placeholders.
pin_gate_warn() {
  local tag img
  tag="$(pin_get rivetos_tag UNPINNED)"
  img="$(pin_get image UNPINNED)"
  if [[ "${tag}" == "UNPINNED" ]] || ! valid_pin_tag "${tag}"; then
    warn "reviewer gate: rivetos_tag is '${tag}' (need a real tag before shipping)"
  fi
  if [[ "${img}" == "UNPINNED" || "${img}" == *":UNPINNED" || "${img}" != *@sha256:* ]]; then
    warn "reviewer gate: image is '${img}' (need digest-form @sha256:... before shipping)"
  fi
}

pin_get() {
  local key="$1"
  local fallback="${2:-UNPINNED}"
  if [[ -z "${PINS_FILE}" || ! -f "${PINS_FILE}" ]]; then
    printf '%s\n' "${fallback}"
    return 0
  fi
  python3 - "${PINS_FILE}" "${key}" "${fallback}" <<'PY'
import json, sys
path, key, fallback = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    print(fallback)
    raise SystemExit(0)
val = data.get(key)
if val is None or str(val).strip() == "":
    print(fallback)
else:
    print(val)
PY
}

# Pin / GitHub ref: letters, digits, dot, underscore, hyphen only.
valid_pin_tag() {
  [[ "${1:-}" =~ ^[A-Za-z0-9._-]+$ ]]
}

valid_image_ref() {
  local img="${1:-}"
  [[ -n "${img}" ]] || return 1
  [[ "${img}" != *..* ]] || return 1
  if [[ "${img}" =~ ^[A-Za-z0-9._/-]+@[Ss][Hh][Aa]256:[a-fA-F0-9]{64}$ ]]; then
    return 0
  fi
  [[ "${img}" =~ ^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?$ ]]
}

agent_image() {
  local img
  img="$(pin_get image UNPINNED)"
  if [[ -n "${RIVETHUB_AGENT_IMAGE:-}" ]]; then
    valid_image_ref "${RIVETHUB_AGENT_IMAGE}" || err "RIVETHUB_AGENT_IMAGE '${RIVETHUB_AGENT_IMAGE}' is not a valid image ref"
    printf '%s\n' "${RIVETHUB_AGENT_IMAGE}"
    return 0
  fi
  if [[ -z "${img}" || "${img}" == "UNPINNED" || "${img}" == *":UNPINNED" ]]; then
    warn "pins/stable.json image is UNPINNED; using floating tag ghcr.io/philbert440/rivetos:latest"
    printf '%s\n' "ghcr.io/philbert440/rivetos:latest"
    return 0
  fi
  printf '%s\n' "${img}"
}

# ---------------------------------------------------------------------------
# validation (match bin/rivethub-hub)
# ---------------------------------------------------------------------------

# [a-z0-9-], must start and end with alnum, max 63. Same as rivethub-hub.
validate_node_name() {
  local name="${1:-}"
  if [[ -z "${name}" ]]; then
    return 1
  fi
  if [[ "${#name}" -gt 63 ]]; then
    return 1
  fi
  [[ "${name}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]
}

is_ipv4() {
  local h="${1:-}"
  [[ "${h}" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local a="${BASH_REMATCH[1]}" b="${BASH_REMATCH[2]}" c="${BASH_REMATCH[3]}" d="${BASH_REMATCH[4]}"
  if ((10#${a} <= 255 && 10#${b} <= 255 && 10#${c} <= 255 && 10#${d} <= 255)); then
    return 0
  fi
  return 1
}

valid_advertise_host() {
  local h="${1:-}"
  [[ -n "${h}" ]] || return 1
  [[ "${h}" != *[[:space:]]* ]] || return 1
  is_ipv4 "${h}" && return 0
  # Bracketed IPv6: [::1], or a link-local address with a %zone id.
  if [[ "${h}" == \[*\] ]]; then
    h="${h:1:${#h}-2}"
  fi
  # IPv6: hex + colons only (no shell metacharacters). Optional zone id.
  if [[ "${h}" == *:* ]]; then
    [[ "${h}" =~ ^[0-9A-Fa-f:]+(%[A-Za-z0-9._-]+)?$ ]] && return 0
    return 1
  fi
  [[ "${h}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]
}

# Strip [::1] brackets so the value is safe in the remote ssh command.
normalize_advertise_host() {
  local h="${1:-}"
  if [[ "${h}" == \[*\] ]]; then
    printf '%s\n' "${h:1:${#h}-2}"
  else
    printf '%s\n' "${h}"
  fi
}

valid_hub_target() {
  local t="${1:-}"
  local user host
  [[ -n "${t}" ]] || return 1
  [[ "${t}" == *@* ]] || return 1
  user="${t%%@*}"
  host="${t#*@}"
  [[ -n "${user}" && -n "${host}" ]] || return 1
  [[ "${user}" != *[[:space:]]* && "${host}" != *[[:space:]]* ]] || return 1
  # User must start with alnum so ssh does not take it as an option (also pass --).
  [[ "${user}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || return 1
}

sanitize_hostname_to_node_name() {
  local raw="${1:-}"
  local s
  s="$(printf '%s' "${raw}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')"
  s="${s#-}"
  s="${s%-}"
  while [[ "${s}" == *--* ]]; do
    s="${s//--/-}"
  done
  printf '%s\n' "${s}"
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------

parse_args() {
  FLAG_DOCKER=0
  FLAG_HELP=0
  FLAG_FORCE=0
  FLAG_YES=0
  HUB_TARGET=""
  HUB_SET=0
  NODE_NAME=""
  NAME_SET=0
  ADVERTISE_HOST=""
  ANSWERS_FILE=""
  IDENTITY_DRIFT=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        FLAG_HELP=1
        return 0
        ;;
      --docker)
        FLAG_DOCKER=1
        shift
        ;;
      --force)
        FLAG_FORCE=1
        shift
        ;;
      -y|--yes)
        FLAG_YES=1
        shift
        ;;
      --hub)
        if [[ $# -lt 2 ]]; then
          err "--hub requires USER@HOST"
        fi
        HUB_TARGET="$2"
        HUB_SET=1
        shift 2
        ;;
      --hub=*)
        HUB_TARGET="${1#--hub=}"
        HUB_SET=1
        shift
        ;;
      --name)
        if [[ $# -lt 2 ]]; then
          err "--name requires a node name"
        fi
        NODE_NAME="$2"
        NAME_SET=1
        shift 2
        ;;
      --name=*)
        NODE_NAME="${1#--name=}"
        NAME_SET=1
        shift
        ;;
      --advertise-host)
        if [[ $# -lt 2 ]]; then
          err "--advertise-host requires a host"
        fi
        ADVERTISE_HOST="$2"
        shift 2
        ;;
      --advertise-host=*)
        ADVERTISE_HOST="${1#--advertise-host=}"
        shift
        ;;
      --answers-file)
        if [[ $# -lt 2 ]]; then
          err "--answers-file requires a path"
        fi
        ANSWERS_FILE="$2"
        shift 2
        ;;
      --answers-file=*)
        ANSWERS_FILE="${1#--answers-file=}"
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
  if [[ -z "${HUB_TARGET}" && -n "${RIVETHUB_HUB:-}" ]]; then
    HUB_TARGET="${RIVETHUB_HUB}"
    HUB_SET=1
  fi
  if [[ -z "${ADVERTISE_HOST}" && -n "${RIVETHUB_ADVERTISE_HOST:-}" ]]; then
    ADVERTISE_HOST="${RIVETHUB_ADVERTISE_HOST}"
  fi
  if [[ "${HUB_SET}" -eq 1 ]]; then
    valid_hub_target "${HUB_TARGET}" || err "invalid --hub '${HUB_TARGET}' (expected user@host, example owner@192.0.2.10)"
  fi
  if [[ "${NAME_SET}" -eq 1 ]]; then
    validate_node_name "${NODE_NAME}" || err "invalid --name '${NODE_NAME}' (expected [a-z0-9]([a-z0-9-]*[a-z0-9])?, max 63)"
  fi
  if [[ -n "${ADVERTISE_HOST}" ]]; then
    valid_advertise_host "${ADVERTISE_HOST}" || err "invalid --advertise-host '${ADVERTISE_HOST}'"
    ADVERTISE_HOST="$(normalize_advertise_host "${ADVERTISE_HOST}")"
  fi
  if [[ -n "${ANSWERS_FILE}" && ! -f "${ANSWERS_FILE}" ]]; then
    err "--answers-file '${ANSWERS_FILE}' is not a file"
  fi
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

os_release_file() {
  printf '%s\n' "${RIVETHUB_OS_RELEASE:-/etc/os-release}"
}

preflight_os() {
  local file id like="" pretty=""
  file="$(os_release_file)"
  if [[ ! -f "${file}" ]]; then
    warn "cannot read ${file}; expected Debian 12 / Ubuntu LTS"
    return 0
  fi
  # shellcheck source=/dev/null
  . "${file}"
  id="${ID:-}"
  like="${ID_LIKE:-}"
  pretty="${PRETTY_NAME:-$id}"
  if [[ "${id}" == "debian" || "${id}" == "ubuntu" || " ${like} " == *" debian "* ]]; then
    log "os: ${pretty}"
    return 0
  fi
  warn "blessed server OS is Debian 12 / Ubuntu LTS (got '${pretty}'); continuing anyway"
}

preflight_arch() {
  local m
  m="$(uname -m 2>/dev/null || true)"
  case "${m}" in
    x86_64|amd64|aarch64|arm64)
      log "arch: ${m}"
      ;;
    *)
      warn "untested architecture '${m}' (expected x86_64 or aarch64); continuing"
      ;;
  esac
}

preflight_root() {
  if in_test; then
    return 0
  fi
  if [[ "${EUID}" -ne 0 ]]; then
    err "must run as root (sudo bash install/node.sh)"
  fi
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

preflight_tools() {
  local t missing=()
  local -a need=(curl python3 tar ssh flock)
  if [[ "${FLAG_DOCKER}" -eq 0 ]]; then
    need+=(git)
  fi
  for t in "${need[@]}"; do
    if ! have_cmd "${t}"; then
      missing+=("${t}")
    fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    return 0
  fi
  if in_test; then
    err "missing required tools: ${missing[*]}"
  fi
  if have_cmd apt-get && [[ "${EUID}" -eq 0 ]]; then
    log "installing missing tools: ${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      curl ca-certificates python3 tar openssh-client git util-linux
  else
    err "missing required tools: ${missing[*]}"
  fi
  for t in "${need[@]}"; do
    have_cmd "${t}" || err "still missing required tool: ${t}"
  done
}

preflight_docker() {
  if [[ "${FLAG_DOCKER}" -eq 0 ]]; then
    return 0
  fi
  if in_test; then
    return 0
  fi
  have_cmd docker || err "--docker requires docker in PATH"
}

preflight_hub() {
  if [[ -n "${HUB_TARGET}" ]]; then
    valid_hub_target "${HUB_TARGET}" || err "invalid --hub '${HUB_TARGET}' (expected user@host)"
    log "hub: ${HUB_TARGET}"
    return 0
  fi
  if [[ -t 0 ]]; then
    return 0
  fi
  err "--hub USER@HOST is required when stdin is not a TTY (example: --hub owner@192.0.2.10)"
}

preflight_answers_file() {
  if [[ -z "${ANSWERS_FILE}" ]]; then
    return 0
  fi
  [[ -f "${ANSWERS_FILE}" ]] || err "--answers-file '${ANSWERS_FILE}' is not a file"
}

# Existing install is resumed, not refused — failure must leave resumable
# state and re-run is idempotent. --force still rewrites the unit / clone.
preflight_already_installed() {
  if [[ -f "${SYSTEMD_DIR}/rivetos-agent.service" && -d "${INSTALL_ROOT}" ]]; then
    log "existing agent install found (${INSTALL_ROOT} + rivetos-agent.service); resuming (idempotent; pass --force to re-clone)"
  fi
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
  if [[ "${kb}" -lt 524288 ]]; then
    err "not enough free disk on ${target} (need ~512 MiB, have ${kb} KiB)"
  fi
  if [[ "${FLAG_DOCKER}" -eq 0 && "${kb}" -lt 2097152 ]]; then
    warn "low disk on ${target} (${kb} KiB free); 2 GiB is a comfortable minimum for npm ci"
  fi
}

preflight() {
  preflight_root
  preflight_os
  preflight_arch
  preflight_tools
  preflight_hub
  preflight_answers_file
  preflight_already_installed
  preflight_disk
  preflight_docker
}

# ---------------------------------------------------------------------------
# prompts / identity
# ---------------------------------------------------------------------------

prompt_if_tty() {
  local prompt="$1"
  local default="$2"
  if ! can_prompt; then
    WIZARD_REPLY="${default}"
    return 0
  fi
  prompt_line "${prompt}" "${default}"
}

hostname_node_name_default() {
  local hn
  hn="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"
  sanitize_hostname_to_node_name "${hn}"
}

hostname_advertise_default() {
  hostname -f 2>/dev/null || hostname 2>/dev/null || true
}

fail_unanswered_questions() {
  local line
  if [[ ${#UNANSWERED_QUESTIONS[@]} -eq 0 ]]; then
    return 0
  fi
  printf 'node.sh: cannot prompt (stdin is not a TTY and /dev/tty is unavailable). Unanswered questions:\n' >&2
  for line in "${UNANSWERED_QUESTIONS[@]}"; do
    printf '  - %s\n' "${line}" >&2
  done
  printf 'node.sh: pass the flags or environment variables above, or re-run on a TTY. --yes accepts documented defaults on non-TTY. --hub has no default.\n' >&2
  exit 1
}

collect_unanswered_questions() {
  UNANSWERED_QUESTIONS=()
  if [[ -z "${HUB_TARGET}" ]]; then
    UNANSWERED_QUESTIONS+=("Datahub SSH target (user@host) (--hub / RIVETHUB_HUB)")
  fi
}

apply_identity_defaults() {
  local candidate
  if [[ -z "${NODE_NAME}" ]]; then
    candidate="$(hostname_node_name_default)"
    NODE_NAME="${candidate}"
  fi
  if [[ -z "${ADVERTISE_HOST}" ]]; then
    ADVERTISE_HOST="$(hostname_advertise_default)"
  fi
}

prompt_hub_field() {
  if [[ -n "${HUB_TARGET}" ]]; then
    return 0
  fi
  prompt_line "Datahub SSH target (user@host)" ""
  HUB_TARGET="${WIZARD_REPLY}"
}

prompt_name_field() {
  local candidate
  if [[ "${NAME_SET}" -eq 1 || -n "${NODE_NAME}" ]]; then
    return 0
  fi
  candidate="$(hostname_node_name_default)"
  prompt_line "Mesh node name" "${candidate}"
  NODE_NAME="${WIZARD_REPLY}"
}

prompt_advertise_field() {
  local candidate
  if [[ -n "${ADVERTISE_HOST}" ]]; then
    return 0
  fi
  candidate="$(hostname_advertise_default)"
  prompt_line "Advertise host" "${candidate}"
  ADVERTISE_HOST="${WIZARD_REPLY}"
}

print_node_summary() {
  local kind
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    kind="docker"
  else
    kind="bare-metal"
  fi
  cat <<EOF

SUMMARY — about to install RivetHub agent node ${VERSION}

  hub:            ${HUB_TARGET:-<required>}
  node name:      ${NODE_NAME:-<hostname>}
  advertise:      ${ADVERTISE_HOST:-<hostname -f>}
  install mode:   ${kind}
  action:         ${WIZARD_ACTION:-fresh}

  packages:       Node 22+ (NodeSource) unless --docker; git clone of rivetOS
  services:       rivetos-agent.service (not rivetos.service)

  paths:
    ${INSTALL_ROOT}          rivetOS checkout
    ${SHARED_DIR}            local mesh.json + rivet-ca
    ${RIVET_HOME}            rivet user home (chowned rivet:rivet)
    ${CONFIG_YAML}           config
    ${ENV_FILE}              secrets (0600 — values never printed)

  SSH: root hop to ${HUB_TARGET:-user@hub} enrolls the node; a rivet
  user keypair is generated and installed hubside so day-2
  \`sudo -u rivet -H rivetos mesh sync\` / renew work.

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
    apply_identity_defaults
    if [[ -n "${HUB_TARGET}" ]]; then
      WIZARD_ACTION="fresh"
      if [[ -n "${PREV_HUB_TARGET}" || -n "${PREV_NODE_NAME}" ]]; then
        WIZARD_ACTION="resume"
      fi
    fi
    if [[ "${FLAG_YES}" -eq 1 ]]; then
      log "non-TTY --yes: accepting documented defaults for unset fields"
    fi
    collect_unanswered_questions
    fail_unanswered_questions
    return 0
  fi
  if ! wizard_open_prompt_fd; then
    apply_identity_defaults
    collect_unanswered_questions
    fail_unanswered_questions
    return 0
  fi
  if [[ -n "${PREV_HUB_TARGET}" || -n "${PREV_NODE_NAME}" ]]; then
    WIZARD_ACTION="resume"
    if [[ "${FLAG_YES}" -eq 1 ]]; then
      log "existing node.env: resume (--yes)"
    fi
  else
    WIZARD_ACTION="fresh"
  fi
  if [[ "${FLAG_YES}" -eq 0 ]]; then
    prompt_hub_field
    prompt_name_field
    prompt_advertise_field
  else
    apply_identity_defaults
    collect_unanswered_questions
    fail_unanswered_questions
  fi
}

load_node_env() {
  PREV_NODE_NAME=""
  PREV_HUB_TARGET=""
  PREV_ADVERTISE_HOST=""
  [[ -f "${NODE_ENV_FILE}" ]] || return 0
  local line key val
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    case "${key}" in
      RIVET_UID) RIVET_UID_RECORDED="${val}" ;;
      NODE_NAME)
        PREV_NODE_NAME="${val}"
        if [[ "${NAME_SET}" -eq 0 && -z "${NODE_NAME}" ]]; then
          NODE_NAME="${val}"
        fi
        ;;
      HUB_TARGET)
        PREV_HUB_TARGET="${val}"
        if [[ "${HUB_SET}" -eq 0 && -z "${HUB_TARGET}" ]]; then
          HUB_TARGET="${val}"
        fi
        ;;
      ADVERTISE_HOST)
        PREV_ADVERTISE_HOST="${val}"
        if [[ -z "${ADVERTISE_HOST}" ]]; then
          ADVERTISE_HOST="${val}"
        fi
        ;;
    esac
  done <"${NODE_ENV_FILE}"
}

resolve_identity() {
  load_node_env
  apply_identity_defaults
  [[ -n "${HUB_TARGET}" ]] || err "--hub USER@HOST is required"
  valid_hub_target "${HUB_TARGET}" || err "invalid hub target '${HUB_TARGET}' (expected user@host)"
  validate_node_name "${NODE_NAME}" || err "invalid node name '${NODE_NAME}' (expected [a-z0-9]([a-z0-9-]*[a-z0-9])?, max 63). Pass --name."
  [[ -n "${ADVERTISE_HOST}" ]] || err "--advertise-host is required (could not detect hostname)"
  valid_advertise_host "${ADVERTISE_HOST}" || err "invalid advertise-host '${ADVERTISE_HOST}'"
  ADVERTISE_HOST="$(normalize_advertise_host "${ADVERTISE_HOST}")"
  warn_identity_drift
  log "node=${NODE_NAME} advertise=${ADVERTISE_HOST} hub=${HUB_TARGET}"
}

warn_identity_drift() {
  IDENTITY_DRIFT=0
  if [[ -n "${PREV_NODE_NAME}" && "${PREV_NODE_NAME}" != "${NODE_NAME}" ]]; then
    warn "recorded NODE_NAME '${PREV_NODE_NAME}' differs from '${NODE_NAME}'; replacing mesh: config and stale certs"
    IDENTITY_DRIFT=1
  fi
  if [[ -n "${PREV_ADVERTISE_HOST}" && "${PREV_ADVERTISE_HOST}" != "${ADVERTISE_HOST}" ]]; then
    warn "recorded ADVERTISE_HOST '${PREV_ADVERTISE_HOST}' differs from '${ADVERTISE_HOST}'; replacing mesh: config"
    IDENTITY_DRIFT=1
  fi
  if [[ -n "${PREV_HUB_TARGET}" && "${PREV_HUB_TARGET}" != "${HUB_TARGET}" ]]; then
    warn "recorded HUB_TARGET '${PREV_HUB_TARGET}' differs from '${HUB_TARGET}'"
  fi
}

write_node_env() {
  local tmp old_umask
  mkdir -p "${HUB_ROOT}"
  tmp="${NODE_ENV_FILE}.tmp"
  old_umask="$(umask)"
  umask 022
  cat >"${tmp}" <<EOF
# Written by install/node.sh. No secrets. Re-run reads NODE_NAME / HUB_TARGET
# when flags are omitted. RIVET_SSH_KEY is the rivet-user key used for
# day-2 mesh sync/renew (installed hubside via the root hop).
RIVET_UID=${RIVET_UID}
RIVET_GID=${RIVET_GID}
NODE_NAME=${NODE_NAME}
HUB_TARGET=${HUB_TARGET}
ADVERTISE_HOST=${ADVERTISE_HOST}
RIVETOS_INSTALL_ROOT=${INSTALL_ROOT}
RIVETOS_SHARED_DIR=${SHARED_DIR}
FLAG_DOCKER=${FLAG_DOCKER}
RIVET_SSH_KEY=${RIVET_HOME}/.ssh/id_ed25519
EOF
  umask "${old_umask}"
  mv -f "${tmp}" "${NODE_ENV_FILE}"
  chmod 0644 "${NODE_ENV_FILE}"
}

# ---------------------------------------------------------------------------
# layout
# ---------------------------------------------------------------------------

ensure_layout() {
  mkdir -p "${SHARED_DIR}/rivet-ca/issued" "${SHARED_DIR}/rivet-ca/intermediate"
  mkdir -p "${HUB_ROOT}"
  mkdir -p "${RIVET_HOME}/.rivetos"
  chmod 0755 "${HUB_ROOT}" 2>/dev/null || true
  chmod 0755 "${SHARED_DIR}" 2>/dev/null || true
  chmod 0755 "${SHARED_DIR}/rivet-ca" 2>/dev/null || true
  chmod 0755 "${SHARED_DIR}/rivet-ca/intermediate" 2>/dev/null || true
  chmod 0700 "${SHARED_DIR}/rivet-ca/issued"
}

rivet_shared_link_path() {
  printf '%s\n' "${RIVETHUB_RIVET_SHARED_LINK:-/rivet-shared}"
}

# rivetOS loadTlsConfig / mtls.ts / FileMeshRegistry still hardcode
# /rivet-shared. Point that path at the distro local shared dir so
# enrollment works today without new rivetOS code.
ensure_rivet_shared_link() {
  local link current
  link="$(rivet_shared_link_path)"
  if in_test && [[ -z "${RIVETHUB_RIVET_SHARED_LINK:-}" ]]; then
    return 0
  fi
  if [[ "${SHARED_DIR}" == "${link}" ]]; then
    return 0
  fi
  if [[ -L "${link}" ]]; then
    current="$(readlink "${link}")"
    if [[ "${current}" == "${SHARED_DIR}" ]]; then
      log "${link} is a symlink to ${SHARED_DIR}"
      return 0
    fi
    warn "${link} points at ${current}, not ${SHARED_DIR}; leaving it in place"
    return 0
  fi
  if [[ -e "${link}" ]]; then
    warn "${link} exists and is not a symlink; rivetOS hardcoded TLS paths may not see ${SHARED_DIR}"
    return 0
  fi
  ln -s "${SHARED_DIR}" "${link}"
  log "linked ${link} -> ${SHARED_DIR}"
}

# ---------------------------------------------------------------------------
# rivet user (uid 2000 if free, else next available)
# ---------------------------------------------------------------------------

uid_free() {
  ! getent passwd "$1" >/dev/null 2>&1
}

gid_free() {
  ! getent group "$1" >/dev/null 2>&1
}

next_free_uid() {
  local u="${WANT_UID}"
  while ! uid_free "${u}"; do
    u=$((u + 1))
    if [[ "${u}" -gt 2999 ]]; then
      err "could not find a free uid starting at ${WANT_UID}"
    fi
  done
  printf '%s\n' "${u}"
}

next_free_gid() {
  local g="${WANT_GID}"
  while ! gid_free "${g}"; do
    g=$((g + 1))
    if [[ "${g}" -gt 2999 ]]; then
      err "could not find a free gid starting at ${WANT_GID}"
    fi
  done
  printf '%s\n' "${g}"
}

ensure_rivet_home_owned() {
  # useradd --create-home does not chown an already-existing home (this
  # fleet often has /home/rivet from a prior mkdir as root). npm ci as
  # rivet then fails mkdir ~/.npm (EACCES). Always chown after useradd.
  mkdir -p "${RIVET_HOME}"
  chown_rivet "${RIVET_HOME}"
}

preflight_rivet_home() {
  local owner
  if in_test; then
    [[ -d "${RIVET_HOME}" ]] || err "rivet home ${RIVET_HOME} is missing"
    return 0
  fi
  [[ -d "${RIVET_HOME}" ]] || err "rivet home ${RIVET_HOME} is missing after user creation"
  if ! have_cmd stat; then
    warn "stat not found; skipping rivet-home owner assert"
    return 0
  fi
  owner="$(stat -c %U "${RIVET_HOME}" 2>/dev/null || true)"
  if [[ "${owner}" != "rivet" ]]; then
    err "rivet home ${RIVET_HOME} is owned by '${owner:-unknown}', not rivet (npm ci as rivet would EACCES on ~/.npm). chown -R rivet:rivet ${RIVET_HOME} and re-run."
  fi
  log "rivet home ${RIVET_HOME} owned by rivet"
}

ensure_rivet_user() {
  if in_test; then
    RIVET_UID="${RIVET_UID_RECORDED:-${WANT_UID}}"
    RIVET_GID="${WANT_GID}"
    mkdir -p "${RIVET_HOME}"
    log "RIVETHUB_TEST=1: skipping useradd (uid ${RIVET_UID})"
    return 0
  fi
  if id -u rivet >/dev/null 2>&1; then
    RIVET_UID="$(id -u rivet)"
    RIVET_GID="$(id -g rivet || true)"
    [[ -n "${RIVET_GID}" ]] || err "rivet user exists but id -g rivet returned empty; fix the account (primary group) before re-running"
    log "rivet user exists (uid ${RIVET_UID} gid ${RIVET_GID}); leaving it in place"
    ensure_rivet_home_owned
    return 0
  fi
  if getent group rivet >/dev/null 2>&1; then
    RIVET_GID="$(getent group rivet | cut -d: -f3)"
  else
    if gid_free "${WANT_GID}"; then
      RIVET_GID="${WANT_GID}"
    else
      RIVET_GID="$(next_free_gid)"
      warn "gid ${WANT_GID} is taken; rivet group will use gid ${RIVET_GID}"
    fi
    groupadd --gid "${RIVET_GID}" rivet
  fi
  if uid_free "${WANT_UID}"; then
    RIVET_UID="${WANT_UID}"
  else
    RIVET_UID="$(next_free_uid)"
    warn "uid ${WANT_UID} is taken; rivet user will use uid ${RIVET_UID}"
  fi
  if [[ -d "${RIVET_HOME}" ]]; then
    useradd --uid "${RIVET_UID}" --gid rivet --home-dir "${RIVET_HOME}" --no-create-home --shell /bin/bash rivet
  else
    useradd --uid "${RIVET_UID}" --gid rivet --home-dir "${RIVET_HOME}" --create-home --shell /bin/bash rivet
  fi
  log "created rivet user uid=${RIVET_UID} gid=${RIVET_GID} home=${RIVET_HOME}"
  ensure_rivet_home_owned
}

chown_rivet() {
  if in_test; then
    return 0
  fi
  if id -u rivet >/dev/null 2>&1; then
    chown -R rivet:rivet "$@"
  fi
}

rivet_ssh_key_path() {
  printf '%s\n' "${RIVET_HOME}/.ssh/id_ed25519"
}

# Generate a rivet-user keypair so day-2 mesh sync/renew (run as rivet, not
# root) can hop to the hub. Idempotent: leave an existing key in place.
ensure_rivet_ssh_key() {
  local dir key pub
  dir="${RIVET_HOME}/.ssh"
  key="$(rivet_ssh_key_path)"
  pub="${key}.pub"
  mkdir -p "${dir}"
  chmod 0700 "${dir}" 2>/dev/null || true
  if [[ -f "${key}" && -f "${pub}" ]]; then
    log "rivet ssh key already at ${key}"
  elif in_test; then
    # Deterministic fixture; never a real private key.
    # printf treats a format starting with - as options (same trap as
    # test/node-sh.bats make_bundle). Keep the PEM on argv after -- / %s.
    printf '%s\n' '-----BEGIN OPENSSH PRIVATE KEY-----' 'TEST-RIVET-KEY' '-----END OPENSSH PRIVATE KEY-----' >"${key}"
    printf '%s\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRivetTestFixture rivet@test' >"${pub}"
    log "RIVETHUB_TEST=1: wrote fixture rivet ssh keypair under ${dir}"
  else
    have_cmd ssh-keygen || err "ssh-keygen not found (openssh-client); cannot generate the rivet user key"
    ssh-keygen -t ed25519 -N "" -f "${key}" -C "rivet@$(hostname -s 2>/dev/null || echo node)" >/dev/null
    log "generated rivet ssh keypair at ${key}"
  fi
  chmod 0600 "${key}"
  chmod 0644 "${pub}"
  chown_rivet "${dir}"
}

# Install rivet's pubkey on the hub using the operator's root BatchMode hop.
# Day-2 \`sudo -u rivet -H rivetos mesh sync\` / renew then work as rivet.
# Idempotent: skip if the exact pubkey is already authorized.
install_rivet_key_on_hub() {
  local target="${1:-${HUB_TARGET}}"
  local pub remote
  pub="$(rivet_ssh_key_path).pub"
  [[ -n "${target}" ]] || err "install_rivet_key_on_hub: empty hub target"
  [[ -f "${pub}" ]] || err "install_rivet_key_on_hub: missing ${pub}"
  if in_test && [[ "${RIVETHUB_TEST_SSH_KEY:-}" != "1" ]]; then
    log "RIVETHUB_TEST=1: skipping hubside rivet pubkey install"
    return 0
  fi
  ssh_preflight "${target}"
  ssh_opts
  # Read the pubkey on stdin of the remote shell so we never interpolate it
  # into the ssh command line. $key / $(cat) must expand remotely (SC2016).
  # shellcheck disable=SC2016
  remote='umask 077; mkdir -p ~/.ssh; chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; key=$(cat); grep -qxF "$key" ~/.ssh/authorized_keys || printf "%s\n" "$key" >> ~/.ssh/authorized_keys'
  # shellcheck disable=SC2029
  if ! ssh "${SSH_OPTS[@]}" -- "${target}" "${remote}" <"${pub}"; then
    err "failed to install rivet pubkey on ${target} via the root hop. Re-run this installer (ssh-copy-id ${target} as root first if BatchMode still fails)."
  fi
  log "installed rivet pubkey on ${target} (day-2 mesh sync/renew run as user rivet, key ${pub})"
}

# ---------------------------------------------------------------------------
# Node.js 22+
# ---------------------------------------------------------------------------

node_major() {
  node -e 'process.stdout.write(String(parseInt(process.versions.node, 10)))' 2>/dev/null || true
}

install_node22() {
  local major=""
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    log "--docker: skipping host Node.js install"
    return 0
  fi
  if in_test; then
    log "RIVETHUB_TEST=1: skipping Node.js install"
    return 0
  fi
  if have_cmd node; then
    major="$(node_major)"
    if [[ -n "${major}" && "${major}" -ge 22 ]]; then
      log "node $(node --version) (>= 22)"
      return 0
    fi
    warn "node $(node --version 2>/dev/null || echo missing) is older than 22; installing NodeSource 22.x"
  fi
  log "installing Node.js 22.x from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  have_cmd node || err "node not found after NodeSource install"
  major="$(node_major)"
  if [[ -z "${major}" || "${major}" -lt 22 ]]; then
    err "node $(node --version) is still < 22 after NodeSource install"
  fi
  log "node $(node --version)"
}

# ---------------------------------------------------------------------------
# clone + build
# ---------------------------------------------------------------------------

clone_rivetos() {
  local tag repo dest
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    log "--docker: skipping git clone"
    return 0
  fi
  dest="${INSTALL_ROOT}"
  repo="${RIVETOS_GIT_REPO:-https://github.com/${RIVETOS_GITHUB_REPO}.git}"
  tag="$(pin_get rivetos_tag UNPINNED)"
  if [[ -d "${dest}/.git" || -f "${dest}/package.json" ]]; then
    if [[ "${FLAG_FORCE}" -eq 0 ]]; then
      log "rivetOS already at ${dest}; leaving checkout in place"
      return 0
    fi
    warn "--force: replacing ${dest}"
    rm -rf "${dest}"
  fi
  if in_test; then
    log "RIVETHUB_TEST=1: skipping git clone"
    mkdir -p "${dest}"
    return 0
  fi
  mkdir -p "$(dirname "${dest}")"
  if [[ "${tag}" == "UNPINNED" ]]; then
    warn "pins/stable.json rivetos_tag is UNPINNED; cloning default branch of ${repo} (not a release pin)"
    GIT_TERMINAL_PROMPT=0 git clone "${repo}" "${dest}"
  else
    valid_pin_tag "${tag}" || err "pins/stable.json rivetos_tag '${tag}' is not a safe tag (expected [A-Za-z0-9._-]+)"
    log "cloning ${repo} @ ${tag} into ${dest}"
    GIT_TERMINAL_PROMPT=0 git clone --branch "${tag}" --depth 1 "${repo}" "${dest}"
  fi
  chown_rivet "${dest}"
}

build_rivetos() {
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    log "--docker: skipping npm ci / nx build"
    return 0
  fi
  if in_test; then
    log "RIVETHUB_TEST=1: skipping npm ci / nx build"
    return 0
  fi
  [[ -f "${INSTALL_ROOT}/package.json" ]] || err "no package.json at ${INSTALL_ROOT}; clone failed"
  log "npm ci + nx build in ${INSTALL_ROOT} (as rivet)"
  # Match provision-ct.sh phase 5. NX_DAEMON=false so a leftover daemon
  # cannot outlive the installer.
  runuser -u rivet -- env HOME="${RIVET_HOME}" NX_DAEMON=false \
    bash -lc "cd $(printf '%q' "${INSTALL_ROOT}") && npm ci && npx nx run-many -t build --exclude container-rivetos,site"
}

# ---------------------------------------------------------------------------
# rivetos init (wizard)
# ---------------------------------------------------------------------------

run_init_wizard() {
  local extra=() qextra=""
  if [[ -n "${ANSWERS_FILE}" ]]; then
    extra+=(--answers-file "${ANSWERS_FILE}")
    log "passing --answers-file to rivetos init (CLI may not implement this flag yet)"
  fi
  # Never call printf %q with zero args — that emits a literal '' argv.
  if ((${#extra[@]})); then
    qextra="$(printf '%q ' "${extra[@]}")"
  fi
  if in_test; then
    log "RIVETHUB_TEST=1: skipping rivetos init extra=[${qextra}]"
    mkdir -p "$(dirname "${CONFIG_YAML}")"
    return 0
  fi
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    run_init_docker
    return 0
  fi
  if [[ ! -t 0 && -z "${ANSWERS_FILE}" ]]; then
    if [[ -f "${CONFIG_YAML}" ]]; then
      log "no TTY and no --answers-file; leaving existing ${CONFIG_YAML}"
      return 0
    fi
    warn "no TTY and no --answers-file; skipping rivetos init (enroll snippet will seed mesh:). Re-run with a TTY or --answers-file to generate a full config."
    mkdir -p "$(dirname "${CONFIG_YAML}")"
    return 0
  fi
  log "running rivetos init as rivet (HOME=${RIVET_HOME})"
  runuser -u rivet -- env HOME="${RIVET_HOME}" \
    bash -lc "cd $(printf '%q' "${INSTALL_ROOT}") && npx rivetos init ${qextra}"
}

run_init_docker() {
  local image
  local -a extra=()
  local -a mounts=()
  image="$(agent_image)"
  valid_image_ref "${image}" || err "refusing image ref '${image}'"
  [[ -n "${RIVET_UID}" && -n "${RIVET_GID}" ]] || err "cannot run docker init with empty uid/gid"
  mounts+=(-v "${RIVET_HOME}/.rivetos:/home/rivetos/.rivetos")
  if [[ -n "${ANSWERS_FILE}" ]]; then
    mounts+=(-v "${ANSWERS_FILE}:/answers.yaml:ro")
    extra+=(--answers-file /answers.yaml)
  fi
  if [[ ! -t 0 && -z "${ANSWERS_FILE}" ]]; then
    if [[ -f "${CONFIG_YAML}" ]]; then
      log "no TTY and no --answers-file; leaving existing ${CONFIG_YAML}"
      return 0
    fi
    warn "no TTY and no --answers-file; skipping rivetos init inside the image"
    mkdir -p "$(dirname "${CONFIG_YAML}")"
    return 0
  fi
  log "running rivetos init in ${image}"
  mkdir -p "$(dirname "${CONFIG_YAML}")"
  docker run --rm -i \
    --user "${RIVET_UID}:${RIVET_GID}" \
    -e HOME=/home/rivetos \
    "${mounts[@]}" \
    "${image}" \
    node dist/rivetos.js init "${extra[@]+"${extra[@]}"}"
}

# ---------------------------------------------------------------------------
# SSH preflight + enroll_via_ssh
#
# Future: replace enroll_via_ssh with `rivetos mesh enroll` once that CLI
# exists. Keep unpack_enroll_bundle + merge_config_snippet either way.
# ---------------------------------------------------------------------------

ssh_opts() {
  # BatchMode=yes: never prompt for a password (would hang curl-pipe).
  # accept-new: first-connect host key without an interactive prompt
  # (OpenSSH 7.6+; Debian 12 / Ubuntu LTS).
  SSH_OPTS=(
    -o BatchMode=yes
    -o ConnectTimeout=8
    -o StrictHostKeyChecking=accept-new
  )
}

# Probe key-based auth. Do not hang on password prompts.
# Branches: success / Permission denied (coach ssh-copy-id) / other failure.
ssh_preflight() {
  local target="${1:-${HUB_TARGET}}"
  local rc=0
  local errfile
  [[ -n "${target}" ]] || err "ssh_preflight: empty target"
  ssh_opts
  errfile="$(mktemp "${TMPDIR:-/tmp}/rivethub-ssh.XXXXXX")"
  register_tmp "${errfile}"
  if ssh "${SSH_OPTS[@]}" -- "${target}" true >/dev/null 2>"${errfile}"; then
    log "ssh to ${target} ok (BatchMode)"
    rm -f "${errfile}"
    return 0
  fi
  rc=$?
  if grep -qi 'permission denied' "${errfile}" 2>/dev/null; then
    err "cannot ssh to ${target} with key-based auth (BatchMode=yes, Permission denied). This installer runs as root, so ssh uses /root/.ssh. Install a key for root (ssh-copy-id ${target} as root, or copy your pubkey into /root/.ssh) then re-run this installer."
  fi
  err "cannot reach ${target} over ssh (BatchMode=yes, rc=${rc}). Check the host is up. This installer runs as root (keys in /root/.ssh). If this is the first login, ssh-copy-id ${target} as root then re-run."
}

# Place tarball members into the local shared dir (rivet-ca layout) and
# merge the config snippet. Idempotent: re-run does not duplicate the snippet.
unpack_enroll_bundle() {
  local b64_file="$1"
  local name="${2:-${NODE_NAME}}"
  local work unpack
  [[ -n "${name}" ]] || err "unpack_enroll_bundle: empty node name"
  [[ -f "${b64_file}" ]] || err "unpack_enroll_bundle: missing ${b64_file}"
  work="$(mktemp -d "${TMPDIR:-/tmp}/rivethub-enroll.XXXXXX")"
  register_tmp_dir "${work}"
  unpack="${work}/unpack"
  mkdir -p "${unpack}"
  if ! base64 -d <"${b64_file}" >"${work}/bundle.tgz" 2>/dev/null; then
    err "failed to base64-decode enroll tarball (not a GNU base64 blob?)"
  fi
  if tar_members_unsafe "${work}/bundle.tgz"; then
    err "enroll tarball contains an unsafe member path; refusing to unpack"
  fi
  if ! tar --no-same-owner -C "${unpack}" -xzf "${work}/bundle.tgz"; then
    err "failed to unpack enroll tarball"
  fi
  [[ -f "${unpack}/${name}.crt" ]] || err "enroll tarball missing ${name}.crt"
  [[ -f "${unpack}/${name}.key" ]] || err "enroll tarball missing ${name}.key"
  [[ -f "${unpack}/ca-chain.pem" ]] || err "enroll tarball missing ca-chain.pem"
  [[ -f "${unpack}/mesh.json" ]] || err "enroll tarball missing mesh.json"
  [[ -f "${unpack}/node-config-snippet.yaml" ]] || err "enroll tarball missing node-config-snippet.yaml"

  mkdir -p "${SHARED_DIR}/rivet-ca/issued" "${SHARED_DIR}/rivet-ca/intermediate"
  chmod 0700 "${SHARED_DIR}/rivet-ca/issued"
  cp -f "${unpack}/${name}.crt" "${SHARED_DIR}/rivet-ca/issued/${name}.crt"
  cp -f "${unpack}/${name}.key" "${SHARED_DIR}/rivet-ca/issued/${name}.key"
  chmod 0600 "${SHARED_DIR}/rivet-ca/issued/${name}.key"
  cp -f "${unpack}/ca-chain.pem" "${SHARED_DIR}/rivet-ca/intermediate/ca-chain.pem"
  cp -f "${unpack}/ca-chain.pem" "${SHARED_DIR}/rivet-ca/intermediate/chain.pem"
  cp -f "${unpack}/mesh.json" "${SHARED_DIR}/mesh.json"
  chmod 0644 "${SHARED_DIR}/mesh.json" "${SHARED_DIR}/rivet-ca/issued/${name}.crt" \
    "${SHARED_DIR}/rivet-ca/intermediate/ca-chain.pem" \
    "${SHARED_DIR}/rivet-ca/intermediate/chain.pem"
  chown_rivet "${SHARED_DIR}"

  remove_stale_issued_certs
  merge_config_snippet "${unpack}/node-config-snippet.yaml"
  log "placed mesh certs under ${SHARED_DIR}/rivet-ca/issued (key mode 0600); mesh.json at ${SHARED_DIR}/mesh.json"
}

# True if any stored member is absolute, ~-prefixed, or has a .. component
# (normalized path would escape the extract root). Uses tarfile so we see
# names as stored; GNU tar -t may strip leading ../ before we can match.
# Python exit 0 = unsafe, 1 = safe; any other rc is unlistable → refuse.
tar_members_unsafe() {
  local tgz="$1" rc=0
  python3 - "${tgz}" <<'PY' || rc=$?
import os, sys, tarfile

path = sys.argv[1]
anchor = "/rivethub-unpack-anchor"


def member_unsafe(name):
    n = name.replace("\\", "/")
    if not n or n.startswith("/") or n.startswith("~") or os.path.isabs(name):
        return True
    if any(part == ".." for part in n.split("/")):
        return True
    joined = os.path.normpath(anchor + "/" + n)
    root = os.path.normpath(anchor)
    return joined != root and not joined.startswith(root + "/")


try:
    with tarfile.open(path, "r:gz") as tf:
        for member in tf.getmembers():
            if member_unsafe(member.name):
                raise SystemExit(0)
except tarfile.TarError:
    raise SystemExit(1)
raise SystemExit(1)
PY
  [[ "${rc}" -eq 1 ]] && return 1
  return 0
}

remove_stale_issued_certs() {
  local old="${PREV_NODE_NAME:-}"
  [[ -n "${old}" && "${old}" != "${NODE_NAME}" ]] || return 0
  validate_node_name "${old}" || return 0
  rm -f "${SHARED_DIR}/rivet-ca/issued/${old}.crt" "${SHARED_DIR}/rivet-ca/issued/${old}.key"
  log "removed stale issued certs for ${old}"
}

# Merge (or replace) the enroll snippet. Backup first. Sentinel is the
# comment rivethub-hub writes. Rewrites storage_dir to this node's
# SHARED_DIR. Replaces a prior enroll block / top-level mesh: on drift so
# re-enroll under a new --name does not leave a stale node_name.
merge_config_snippet() {
  local snippet="$1"
  local config="${CONFIG_YAML}"
  local dir
  dir="$(dirname "${config}")"
  mkdir -p "${dir}"
  [[ -f "${snippet}" ]] || err "merge_config_snippet: missing ${snippet}"
  if [[ -f "${config}" ]] \
    && grep -qF '# Generated by rivethub-hub enroll' "${config}" \
    && [[ "${IDENTITY_DRIFT}" -eq 0 ]] \
    && grep -qF "node_name: \"${NODE_NAME}\"" "${config}" \
    && grep -qF "storage_dir: \"${SHARED_DIR}\"" "${config}"; then
    log "config snippet already merged in ${config}; leaving it in place"
    return 0
  fi
  if [[ -f "${config}" ]]; then
    cp -f "${config}" "${config}.bak"
  fi
  python3 - "${snippet}" "${config}" "${SHARED_DIR}" <<'PY' || err "failed to merge enroll snippet into ${config}"
import re, sys

snippet_path, config_path, shared_dir = sys.argv[1], sys.argv[2], sys.argv[3]
SENTINEL = "# Generated by rivethub-hub enroll"

def rewrite_storage_dir(text, shared):
    escaped = shared.replace("\\", "\\\\").replace('"', '\\"')
    return re.sub(
        r'(storage_dir:\s*)".*?"',
        r'\1"' + escaped + '"',
        text,
        count=1,
    )

def drop_enroll_block(text):
    lines = text.splitlines(keepends=True)
    out = []
    i = 0
    while i < len(lines):
        if SENTINEL in lines[i]:
            i += 1
            while i < len(lines) and lines[i].lstrip().startswith("#"):
                i += 1
            if i < len(lines) and re.match(r"^mesh\s*:", lines[i]):
                i += 1
                while i < len(lines) and (
                    not lines[i].strip() or lines[i][:1] in " \t"
                ):
                    i += 1
            continue
        out.append(lines[i])
        i += 1
    return "".join(out)

def drop_top_level_key(text, key):
    lines = text.splitlines(keepends=True)
    out = []
    skipping = False
    for line in lines:
        if skipping:
            if not line.strip() or line[:1] in " \t":
                continue
            skipping = False
        if not skipping and re.match(rf"^{re.escape(key)}\s*:", line):
            skipping = True
            continue
        out.append(line)
    return "".join(out)

snippet = rewrite_storage_dir(open(snippet_path, encoding="utf-8").read(), shared_dir)
try:
    existing = open(config_path, encoding="utf-8").read()
except FileNotFoundError:
    existing = ""
if existing:
    existing = drop_enroll_block(existing)
    existing = drop_top_level_key(existing, "mesh")
    existing = existing.rstrip("\n")
    if existing:
        existing += "\n"
    text = existing + snippet
    if not text.endswith("\n"):
        text += "\n"
else:
    text = snippet if snippet.endswith("\n") else snippet + "\n"
open(config_path, "w", encoding="utf-8").write(text)
PY
  if [[ -f "${config}.bak" ]]; then
    log "merged enroll snippet into ${config} (backup ${config}.bak)"
  else
    log "wrote enroll snippet to new ${config}"
  fi
  chmod 0600 "${config}"
  if [[ -f "${config}.bak" ]]; then
    chmod 0600 "${config}.bak" 2>/dev/null || true
  fi
  chown_rivet "${dir}"
}

# SSH transport adapter for the enroll tarball contract.
# stdout of remote rivethub-hub is ONLY the base64 blob (diagnostics on stderr).
enroll_via_ssh() {
  local target="${1:-${HUB_TARGET}}"
  local name="${2:-${NODE_NAME}}"
  local host="${3:-${ADVERTISE_HOST}}"
  local b64 remote
  [[ -n "${target}" ]] || err "enroll_via_ssh: empty hub target"
  [[ -n "${name}" ]] || err "enroll_via_ssh: empty node name"
  [[ -n "${host}" ]] || err "enroll_via_ssh: empty advertise-host"
  validate_node_name "${name}" || err "enroll_via_ssh: invalid node name '${name}'"
  valid_advertise_host "${host}" || err "enroll_via_ssh: invalid advertise-host '${host}'"

  ssh_preflight "${target}"

  b64="$(mktemp "${TMPDIR:-/tmp}/rivethub-enroll.XXXXXX.b64")"
  register_tmp "${b64}"
  ssh_opts
  # name/host are charset-validated; PATH prefix because non-login ssh often
  # drops /usr/local/bin (where datahub.sh installs rivethub-hub).
  remote="PATH=/usr/local/bin:/usr/bin:/bin:\$PATH rivethub-hub enroll ${name} ${host}"
  log "enrolling ${name} via ssh ${target}"
  # Client-side expansion of ${remote} is intentional: name/host are charset-validated; \$PATH expands on the remote.
  # shellcheck disable=SC2029
  if ! ssh "${SSH_OPTS[@]}" -- "${target}" "${remote}" >"${b64}"; then
    err "ssh ${target} rivethub-hub enroll failed. Re-run this installer to resume (datahub enroll is idempotent; recorded HUB_TARGET in node.env is reused when --hub is omitted)."
  fi
  if [[ ! -s "${b64}" ]]; then
    err "enroll produced an empty tarball (remote diagnostics are on stderr). Re-run to resume."
  fi
  chmod 0600 "${b64}"
  unpack_enroll_bundle "${b64}" "${name}"
}

# ---------------------------------------------------------------------------
# systemd unit
# ---------------------------------------------------------------------------

node_bin() {
  local b
  b="$(command -v node 2>/dev/null || true)"
  if [[ -n "${b}" ]]; then
    printf '%s\n' "${b}"
    return 0
  fi
  printf '%s\n' "/usr/bin/node"
}

docker_bin() {
  local b
  b="$(command -v docker 2>/dev/null || true)"
  if [[ -n "${b}" ]]; then
    printf '%s\n' "${b}"
    return 0
  fi
  printf '%s\n' "/usr/bin/docker"
}

write_baremetal_unit() {
  local dest="${SYSTEMD_DIR}/rivetos-agent.service"
  local src="" nodeb
  nodeb="$(node_bin)"
  mkdir -p "${SYSTEMD_DIR}"
  if [[ -n "${DISTRO_ROOT}" && -f "${DISTRO_ROOT}/systemd/rivetos-agent.service" ]]; then
    src="${DISTRO_ROOT}/systemd/rivetos-agent.service"
    python3 - "${src}" "${dest}" "${RIVET_HOME}" "${INSTALL_ROOT}" "${SHARED_DIR}" "${nodeb}" <<'PY'
import sys
src, dest, home, root, shared, nodeb = sys.argv[1:7]
text = open(src, encoding="utf-8").read()
text = text.replace("/home/rivet", home)
text = text.replace("/opt/rivetos", root)
text = text.replace("/var/lib/rivethub/shared", shared)
text = text.replace("ExecStart=/usr/bin/node ", "ExecStart=" + nodeb + " ")
open(dest, "w", encoding="utf-8").write(text)
PY
  else
    cat >"${dest}" <<EOF
# Generated by install/node.sh (curl-pipe; no distro checkout).
[Unit]
Description=RivetOS Agent Runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rivet
Group=rivet
WorkingDirectory=${INSTALL_ROOT}
ExecStart=${nodeb} ${INSTALL_ROOT}/packages/cli/dist/index.js start --config ${CONFIG_YAML}
Restart=on-failure
RestartSec=5
EnvironmentFile=-${ENV_FILE}
Environment=HOME=${RIVET_HOME}
Environment=RIVETOS_LOG_LEVEL=info
Environment=RIVETOS_SHARED_DIR=${SHARED_DIR}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rivetos-agent
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=${RIVET_HOME} ${HUB_ROOT} ${INSTALL_ROOT} /rivet-shared
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  fi
  chmod 0644 "${dest}"
  log "wrote ${dest}"
}

write_docker_unit() {
  local dest="${SYSTEMD_DIR}/rivetos-agent.service"
  local image dockerb
  image="$(agent_image)"
  valid_image_ref "${image}" || err "refusing image ref '${image}'"
  [[ -n "${RIVET_UID}" && -n "${RIVET_GID}" ]] || err "cannot write docker unit with empty uid/gid (rivet user primary group missing?)"
  dockerb="$(docker_bin)"
  mkdir -p "${SYSTEMD_DIR}"
  cat >"${dest}" <<EOF
# RivetHub agent (--docker). Host networking so mesh port ${MESH_PORT} is
# on the host. Image: ${image} (pin \`image\` in pins/stable.json; digest
# form preferred when a pin exists). User matches the host rivet uid so
# 0600 mesh keys under the shared dir are readable.
[Unit]
Description=RivetOS Agent Runtime (docker ${image})
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=5
ExecStartPre=-${dockerb} rm -f rivetos-agent
ExecStart=${dockerb} run --name rivetos-agent --rm --network host --user ${RIVET_UID}:${RIVET_GID} --env-file ${ENV_FILE} -e HOME=/home/rivetos -e RIVETOS_SHARED_DIR=/rivet-shared -e RIVETOS_DATA_DIR=/home/rivetos/.rivetos -v ${RIVET_HOME}/.rivetos:/home/rivetos/.rivetos -v ${SHARED_DIR}:/rivet-shared -v ${SHARED_DIR}:${SHARED_DIR} ${image} node dist/rivetos.js start --role agent
ExecStop=${dockerb} stop rivetos-agent
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rivetos-agent

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "${dest}"
  log "wrote ${dest} (docker ${image})"
}

write_agent_unit() {
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    write_docker_unit
  else
    write_baremetal_unit
  fi
}

enable_agent_unit() {
  if in_test && [[ "${RIVETHUB_TEST_SYSTEMCTL:-}" != "1" ]]; then
    log "RIVETHUB_TEST=1: skipping systemctl enable/start"
    return 0
  fi
  if [[ ! -f "${ENV_FILE}" ]]; then
    umask 077
    : >"${ENV_FILE}"
    chmod 0600 "${ENV_FILE}"
    chown_rivet "${ENV_FILE}"
  fi
  have_cmd systemctl || err "systemctl not found; cannot enable rivetos-agent"
  systemctl daemon-reload
  restart_or_enable_agent
}

# Re-enroll / unit rewrite must pick up new certs: enable --now on an
# already-active unit does not restart it.
restart_or_enable_agent() {
  if systemctl is-active --quiet rivetos-agent.service; then
    systemctl enable rivetos-agent.service
    systemctl try-restart rivetos-agent.service
    log "rivetos-agent.service was already active; try-restarted to pick up new certs/unit"
  else
    systemctl enable --now rivetos-agent.service
  fi
}

# ---------------------------------------------------------------------------
# post-checks
# ---------------------------------------------------------------------------

post_checks() {
  local cert="${SHARED_DIR}/rivet-ca/issued/${NODE_NAME}.crt"
  if [[ -f "${cert}" ]]; then
    log "mesh cert present: ${cert}"
  else
    warn "mesh cert missing at ${cert} (enroll may have been skipped)"
  fi
  if in_test; then
    return 0
  fi
  if have_cmd systemctl; then
    if systemctl is-active --quiet rivetos-agent.service; then
      log "rivetos-agent.service is active"
    else
      warn "rivetos-agent.service is not active; see journalctl -u rivetos-agent -n 50"
    fi
  fi
  if have_cmd runuser && [[ -x "${INSTALL_ROOT}/node_modules/.bin/rivetos" || -f "${INSTALL_ROOT}/packages/cli/dist/index.js" ]]; then
    log "running rivetos doctor (best-effort)"
    runuser -u rivet -- env HOME="${RIVET_HOME}" \
      bash -lc "cd $(printf '%q' "${INSTALL_ROOT}") && npx rivetos doctor" \
      >/dev/null 2>&1 || warn "rivetos doctor reported issues (non-fatal); run it by hand"
  fi
}

# ---------------------------------------------------------------------------
# banner — next steps. Secrets are never printed.
# ---------------------------------------------------------------------------

print_banner() {
  local kind host
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    kind="docker"
  else
    kind="bare-metal"
  fi
  host="${HUB_TARGET:-user@datahub}"
  cat <<EOF

RivetHub agent node ${VERSION} is installed (${kind}).

  node name:      ${NODE_NAME:-<unset>}
  rivet user:     rivet (uid ${RIVET_UID:-?})
  install root:   ${INSTALL_ROOT}
  config:         ${CONFIG_YAML}
  secrets:        ${ENV_FILE}  (mode 0600 — values are not printed)
  shared dir:     ${SHARED_DIR}
  mesh cert:      ${SHARED_DIR}/rivet-ca/issued/${NODE_NAME:-NODE}.crt

Check (the systemd unit is rivetos-agent.service, not rivetos.service):
  systemctl status rivetos-agent.service
  journalctl -u rivetos-agent.service -n 50
  sudo -u rivet -H rivetos status
  sudo -u rivet -H rivetos doctor

Day-2 mesh sync / renew run as the rivet user (the installer generated
${RIVET_HOME}/.ssh/id_ed25519 and installed the pubkey on ${host}):
  sudo -u rivet -H rivetos mesh sync
  sudo -u rivet -H rivetos mesh renew

Add the next node (example RFC 5737 address):

  curl -fsSL https://get.rivethub.io/node.sh | bash -s -- --hub ${host} --name node-b --advertise-host 192.0.2.11 --yes

EOF
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

node_main() {
  parse_args "$@"
  if [[ "${FLAG_HELP}" -eq 1 ]]; then
    usage
    return 0
  fi
  init_paths
  # Before preflight_hub: non-TTY re-run without --hub must see recorded
  # HUB_TARGET. load_node_env does not clobber NAME_SET / HUB_SET flags.
  load_node_env
  run_wizard_flow
  if can_prompt; then
    print_node_summary
  fi
  confirm_or_die
  preflight
  resolve_identity
  pin_gate_warn
  ensure_layout

  exec 9>"${HUB_ROOT}/.node-install.lock"
  if ! flock -w 60 9; then
    err "another node install holds ${HUB_ROOT}/.node-install.lock (waited 60s). If no installer is running, remove the lock file and re-run."
  fi

  ensure_rivet_user
  ensure_rivet_home_owned
  preflight_rivet_home
  ensure_rivet_ssh_key
  write_node_env
  chown_rivet "${RIVET_HOME}" "${SHARED_DIR}" 2>/dev/null || true

  install_node22
  clone_rivetos
  build_rivetos
  run_init_wizard
  if in_test; then
    log "RIVETHUB_TEST=1: skipping enroll_via_ssh in main (bats calls the function directly)"
  else
    install_rivet_key_on_hub "${HUB_TARGET}"
    enroll_via_ssh "${HUB_TARGET}" "${NODE_NAME}" "${ADVERTISE_HOST}"
  fi
  ensure_rivet_shared_link
  write_agent_unit
  enable_agent_unit
  post_checks
  print_banner
}

# True when executed (bash script.sh, ./script, curl | bash -s). False when
# sourced. Do not use BASH_SOURCE==$0 — under bash -s they differ and the
# installer would silently exit 0.
if ! (return 0 2>/dev/null); then
  node_main "$@"
fi
