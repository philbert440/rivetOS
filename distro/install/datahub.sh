#!/usr/bin/env bash
# RivetHub datahub installer
#
#   sudo bash install/datahub.sh [--docker|--bare-metal] [--memory lite|full]
#        [--owner NAME] [--pg-port PORT] [--data-root DIR]
#        [--advertise-host HOST] [--yes] [--force]
#
#   curl -fsSL https://get.rivethub.io/datahub.sh | sudo bash
#   curl -fsSL https://get.rivethub.io/datahub.sh | sudo bash -s -- --yes
#
# This script needs bin/rivethub-hub, lib/rivet-ca.sh and systemd/ beside it.
# From a checkout (or RIVETHUB_DISTRO_DIR) they are used in place. Curl-pipe
# has no siblings: preflight fetches them from get.rivethub.io and checks
# each against its sha256 in pins/stable.json before any system write.
#
# Installs a DATAHUB host: Postgres 16 + pgvector, memory schema, the mesh CA,
# users.json, and rivethub-hub. No agent runs here. Debian 12 / Ubuntu LTS.
# Bare-metal Postgres is the default; --docker runs the pins pgvector image
# (floating tag pgvector/pgvector:pg16 until pins/stable.json pgvector_image is set).
# Memory workers are OFF (memory-lite) unless --memory full.
#
# Wizard / TTY contract (C2b + e2e F1/F2):
#   Prompts are NOT read from stdin when stdin is a pipe. `curl | bash` has
#   the script on stdin (not a TTY). When a controlling terminal exists,
#   answers are read from /dev/tty so the wizard can still run. can_prompt
#   is true only if that fd can actually be opened — a leftover /dev/tty
#   node that cannot be opened (plain ssh, no TTY) is NOT prompt-capable.
#   When we cannot prompt:
#     flags, RIVETHUB_* / RIVETOS_* env, and documented defaults apply
#     (no confirm). --yes is the one-click spelling of that: it means
#     "accept every prompt's default" plus skip confirm. Fields with no
#     default (memory-full URLs) are NOT guessed.
#     ALL remaining unanswerable questions are listed in ONE error with
#     their env var / flag names (a shopping list) — never one-at-a-time.
#   On a prompt-capable terminal, unset fields are asked (defaults shown);
#   a SUMMARY is printed; an explicit "yes" is required before any system
#   mutation unless --yes. Flags and env skip their own prompt (partial
#   wizard). --yes skips the confirm (and on non-TTY, applies defaults).
#   Re-run: existing install is detected; wizard offers
#   resume / reconfigure-safe-bits (memory workers) / abort. CA re-init
#   and postgres password rotation never happen silently — pass --force.
# Test seam: RIVETHUB_PROMPT_IN is a file of answers, one line per prompt.
#   Exhausting the file (or EOF / a failed read on /dev/tty) is a hard error
#   that names the unanswered question — never a blocking read. RIVETHUB_TEST=1
#   never opens /dev/tty (bats would hang / steal the TTY).
#
# Read this file. Curl-pipe installers should be boring.
#
# Layout (RIVETHUB_ROOT, default /var/lib/rivethub):
#   $ROOT/shared/              mesh.json, rivet-ca (exportable)
#   $ROOT/shared/rivetos/      users.json (tenancy registry)
#   $ROOT/ca-root/             root CA key, 0700, never exported
#   $ROOT/datahub.env          conninfo + worker env, 0600
#
# Helpers land at /usr/local/bin/rivethub-hub and
# /usr/local/lib/rivethub/rivet-ca.sh (rivethub-hub already searches there).
#
# Pins: every fetch from rivetOS uses pins/stable.json (rivetos_tag). An
# UNPINNED tag is refused unless RIVETHUB_MIGRATIONS_DIR points at a checkout.
#
# Test-only: RIVETHUB_TEST=1 skips root/port/disk/apt/systemctl/useradd so the
# bats suite can exercise parse/preflight/layout/env/migrations/users/banner
# with fakes in PATH. Do not set this on a real host. Wizard answers: set
# RIVETHUB_PROMPT_IN to a file (see "Test seam" above).

set -euo pipefail

VERSION="0.1.0"

# Defaults (overridden by parse_args / env). *_SET=1 means a flag or env
# supplied the value so the wizard must not ask that question.
FLAG_DOCKER=0
FLAG_HELP=0
FLAG_YES=0
FLAG_FORCE=0
MEMORY_MODE="lite"
MEMORY_SET=0
OWNER_ID="owner"
OWNER_SET=0
ADVERTISE_HOST=""
INSTALL_MODE_SET=0
PG_PORT_SET=0
ROOT_SET=0
WIZARD_ACTION=""
_WIZARD_PROMPT_FD=""
WIZARD_REPLY=""
UNANSWERED_QUESTIONS=()

HUB_ROOT=""
HUB_SHARED=""
HUB_CA_ROOT=""
HUB_ENV=""
HUB_USERS_DIR=""
HUB_USERS=""
BIN_DIR=""
LIB_DIR=""
SYSTEMD_DIR=""
DISTRO_ROOT=""
PINS_FILE=""

PG_USER="rivetos"
PG_DB="rivetos"
PG_HOST="127.0.0.1"
PG_PORT="5432"

# rivetOS GitHub (DEPLOYMENT.md clone URL). Not a pin field — see notes.
RIVETOS_GITHUB_REPO="philbert440/rivetOS"

# ---------------------------------------------------------------------------
# logging — secrets never go through log()
# ---------------------------------------------------------------------------

log() { printf 'datahub.sh: %s\n' "$*" >&2; }
err() { printf 'datahub.sh: %s\n' "$*" >&2; exit 1; }
warn() { printf 'datahub.sh: warning: %s\n' "$*" >&2; }

in_test() { [[ "${RIVETHUB_TEST:-}" == "1" ]]; }

# Password-bearing temps (role SQL, migration wrap) must not survive a
# failing psql: set -e skips the `rm -f` that follows. EXIT covers abort.
_RIVETHUB_TMP_FILES=()
register_tmp() { _RIVETHUB_TMP_FILES+=("$1"); }
_RIVETHUB_BUNDLE_DIR=""
cleanup_tmp_files() {
  local f
  for f in "${_RIVETHUB_TMP_FILES[@]+"${_RIVETHUB_TMP_FILES[@]}"}"; do
    rm -f "${f}"
  done
  _RIVETHUB_TMP_FILES=()
  if [[ -n "${_RIVETHUB_BUNDLE_DIR}" && -d "${_RIVETHUB_BUNDLE_DIR}" ]]; then
    rm -rf "${_RIVETHUB_BUNDLE_DIR}"
  fi
  _RIVETHUB_BUNDLE_DIR=""
  wizard_close_prompt_fd
}
trap cleanup_tmp_files EXIT

# ---------------------------------------------------------------------------
# wizard I/O — /dev/tty for curl-pipe; RIVETHUB_PROMPT_IN is the test seam
# ---------------------------------------------------------------------------

wizard_close_prompt_fd() {
  if [[ -z "${_WIZARD_PROMPT_FD}" || "${_WIZARD_PROMPT_FD}" == "0" ]]; then
    _WIZARD_PROMPT_FD=""
    return 0
  fi
  if [[ "${_WIZARD_PROMPT_FD}" =~ ^[0-9]+$ ]]; then
    eval "exec ${_WIZARD_PROMPT_FD}<&-" || true
  fi
  _WIZARD_PROMPT_FD=""
}

# True when we can actually read an answer. Existence of /dev/tty is not
# enough (plain ssh leaves the node but opening it fails). Test:
# RIVETHUB_PROMPT_IN (file of answers). RIVETHUB_TEST=1 never uses
# /dev/tty — bats would hang. Production: wizard_open_prompt_fd.
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
    if exec {_WIZARD_PROMPT_FD}<"${RIVETHUB_PROMPT_IN}"; then
      return 0
    fi
    return 1
  fi
  if in_test; then
    return 1
  fi
  if [[ -e /dev/tty && -r /dev/tty ]]; then
    if { exec {_WIZARD_PROMPT_FD}<>/dev/tty; } 2>/dev/null; then
      return 0
    fi
  fi
  if [[ -t 0 ]]; then
    _WIZARD_PROMPT_FD=0
    return 0
  fi
  return 1
}

# Read one answer into WIZARD_REPLY. Prompt text goes to stderr.
# Empty enter keeps default. EOF or a failed read hard-errors and names
# the unanswered question (same idea as a missing --answers-file key) —
# never block, never silently proceed. Must run in the installer shell,
# not inside $(...); a subshell would reopen RIVETHUB_PROMPT_IN from byte 0.
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
  # `if ! read` so set -e does not abort before we can name the question.
  if ! IFS= read -r reply <&"${_WIZARD_PROMPT_FD}"; then
    if [[ -z "${reply}" ]]; then
      err "unanswered question (${prompt}): prompt input ended (EOF). Pass flags or RIVETHUB_* / RIVETOS_* environment variables, or add a line to RIVETHUB_PROMPT_IN."
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
Usage: datahub.sh [options]

Install a RivetHub datahub (Postgres + CA + rivethub-hub) on Debian 12 or
Ubuntu LTS. Run from a rivetOS checkout (distro/), or curl-pipe it (helpers
are then fetched from get.rivethub.io and sha256-checked against
pins/stable.json). Re-running is safe (idempotent). Version ${VERSION}.

On a terminal (or curl-pipe with a controlling /dev/tty that can actually
be opened), unset fields are prompted with defaults shown, then a SUMMARY,
then an explicit yes is required before any write. Flags and RIVETHUB_*
env vars skip their prompt. --yes skips the confirm. With no terminal
(plain ssh, no controlling terminal) nothing is prompted and there is no
confirm, with or without --yes: flags, env vars and each prompt's
documented default apply. Fields with no default are listed together in
one error with their env names — never one question per rerun.

Options:
  --docker                 Run Postgres 16 + pgvector as a systemd-managed
                           container (image from pins/stable.json pgvector_image,
                           else pgvector/pgvector:pg16) instead of PGDG packages.
  --bare-metal             Explicit PGDG packages (the default). Skips the
                           install-mode prompt; conflicts with --docker.
  --memory lite|full       Memory workers. Default lite (off). full writes
                           OpenAI-compatible endpoints into datahub.env and
                           installs rivet-embedder.service / rivet-compactor.service
                           (not started until a rivetOS runtime is present).
  --owner NAME             Owner user id in users.json (default: owner).
                           Honored on first run only; an existing users.json
                           is left in place.
  --pg-port PORT           Postgres listen port (default 5432). Docker publishes
                           127.0.0.1:PORT:5432.
  --data-root DIR          Hub root (default /var/lib/rivethub). Same as
                           RIVETHUB_ROOT.
  --advertise-host HOST    This host as agents should reach it (DNS or
                           RFC 5737 example 192.0.2.10). Used in the banner.
                           Defaults to RIVETHUB_ADVERTISE_HOST when set.
  -y, --yes                Skip the pre-mutation confirm (the --defaults
                           spelling is folded into --yes). With no terminal
                           the documented defaults apply either way. Does
                           not invent values for fields with no default
                           (memory-full URLs, compaction model).
  --force                  Re-init the mesh CA (ca-init --force) and rotate
                           the postgres password. Never implied by a re-run.
  -h, --help               Show this help.

Environment (full non-interactive set; unset ones take their defaults):
  RIVETHUB_ROOT            Hub root (default /var/lib/rivethub)
  RIVETHUB_DISTRO_DIR      Checkout containing bin/rivethub-hub and lib/rivet-ca.sh
  RIVETHUB_BASE_URL        Where curl-pipe fetches pins + helpers
                           (default https://get.rivethub.io)
  RIVETHUB_MIGRATIONS_DIR  Directory of *.sql to apply (overrides pin fetch)
  RIVETHUB_ADVERTISE_HOST  Default for --advertise-host
  RIVETHUB_OWNER           Default for --owner (default: owner)
  RIVETHUB_MEMORY          lite|full (default: lite)
  RIVETHUB_INSTALL_MODE    bare-metal|docker (default: bare-metal)
  RIVETHUB_PG_PORT         Default for --pg-port (default: 5432)
  RIVETOS_EMBED_URL        Required with --memory full (no default)
  RIVETOS_EMBED_MODEL      Embed model (default nemotron)
  RIVETOS_COMPACTOR_URL    Required with --memory full (no default)
  RIVETOS_COMPACTOR_MODEL  Required with --memory full (no default)
  RIVETHUB_PROMPT_IN       Test seam: file of wizard answers, one per prompt.
                           Exhausting the file is a hard error naming the question.

Examples:
  sudo bash install/datahub.sh
  sudo bash install/datahub.sh --yes
  sudo bash install/datahub.sh --docker --advertise-host 192.0.2.10 --yes
  sudo bash install/datahub.sh --memory full --owner owner
EOF
}

# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------

# Resolve the distro checkout. Curl-pipe has no sibling bin/; preflight then
# fills DISTRO_ROOT from get.rivethub.io (fetch_distro_bundle).
discover_distro_root() {
  local parent
  if [[ -n "${RIVETHUB_DISTRO_DIR:-}" ]]; then
    printf '%s\n' "${RIVETHUB_DISTRO_DIR}"
    return 0
  fi
  # Siblings are used unverified, so only a real checkout counts. A
  # datahub.sh downloaded on its own into a shared directory (/tmp/install/)
  # must not adopt a ../bin planted by another local user — it fetches.
  if parent="$(sibling_checkout_dir)" && trusted_checkout "${parent}"; then
    printf '%s\n' "${parent}"
    return 0
  fi
  return 1
}

# The directory above this file, when this file is install/datahub.sh and
# the helpers sit beside install/. Says nothing about whether to trust it.
sibling_checkout_dir() {
  local src here parent
  src="${BASH_SOURCE[0]:-}"
  [[ -n "${src}" && -f "${src}" ]] || return 1
  here="$(cd "$(dirname "${src}")" && pwd)"
  [[ "$(basename "${here}")" == "install" ]] || return 1
  parent="$(cd "${here}/.." && pwd)"
  [[ -f "${parent}/bin/rivethub-hub" && -f "${parent}/lib/rivet-ca.sh" ]] || return 1
  printf '%s\n' "${parent}"
}

# root, us, or whoever ran sudo.
trusted_uid() {
  [[ "$1" == "0" || "$1" == "${EUID}" || "$1" == "${SUDO_UID:-}" ]]
}

# A group is trusted when every account in it is: its listed members and
# every account that has it as primary group. That is a per-user group
# (umask 002 checkouts), not a shared one. Accounts a directory service does
# not enumerate are not seen here.
trusted_group() {
  local gid="$1" line members m uid pgid
  line="$(getent group "${gid}" 2>/dev/null)" || return 1
  members="${line##*:}"
  for m in ${members//,/ }; do
    uid="$(id -u "${m}" 2>/dev/null)" || return 1
    trusted_uid "${uid}" || return 1
  done
  while IFS=: read -r _ _ uid pgid _; do
    [[ "${pgid}" == "${gid}" ]] || continue
    trusted_uid "${uid}" || return 1
  done < <(getent passwd 2>/dev/null)
  return 0
}

# Owned by a trusted uid and writable by nobody else. /tmp is root-owned but
# world-writable, so ownership alone is not it; a group-writable path counts
# only when the group is a trusted one.
trusted_path() {
  local owner mode group
  owner="$(stat -c %u "$1" 2>/dev/null)" || return 1
  mode="$(stat -c %a "$1" 2>/dev/null)" || return 1
  trusted_uid "${owner}" || return 1
  (( (8#${mode} & 2) == 0 )) || return 1
  (( (8#${mode} & 020) == 0 )) && return 0
  group="$(stat -c %g "$1" 2>/dev/null)" || return 1
  trusted_group "${group}"
}

# Everything the installer reads or runs from a checkout. systemd/ and pins/
# are checked when present (preflight refuses a missing one where needed).
trusted_checkout() {
  local root="$1" p
  for p in "${root}" "${root}/install" "${root}/bin" "${root}/lib" \
    "${root}/bin/rivethub-hub" "${root}/lib/rivet-ca.sh"; do
    trusted_path "${p}" || return 1
  done
  for p in "${root}/systemd" "${root}/systemd/rivet-embedder.service" \
    "${root}/systemd/rivet-compactor.service" "${root}/pins" "${root}/pins/stable.json"; do
    [[ -e "${p}" ]] || continue
    trusted_path "${p}" || return 1
  done
}

init_paths() {
  HUB_ROOT="${RIVETHUB_ROOT:-/var/lib/rivethub}"
  HUB_SHARED="${HUB_ROOT}/shared"
  HUB_CA_ROOT="${HUB_ROOT}/ca-root"
  HUB_ENV="${HUB_ROOT}/datahub.env"
  HUB_USERS_DIR="${HUB_SHARED}/rivetos"
  HUB_USERS="${HUB_USERS_DIR}/users.json"
  BIN_DIR="${RIVETHUB_BIN_DIR:-/usr/local/bin}"
  LIB_DIR="${RIVETHUB_LIB_DIR:-/usr/local/lib/rivethub}"
  SYSTEMD_DIR="${RIVETHUB_SYSTEMD_DIR:-/etc/systemd/system}"
  DISTRO_ROOT=""
  if DISTRO_ROOT="$(discover_distro_root)"; then
    :
  else
    DISTRO_ROOT=""
  fi
  if [[ -n "${DISTRO_ROOT}" && -f "${DISTRO_ROOT}/pins/stable.json" ]]; then
    PINS_FILE="${DISTRO_ROOT}/pins/stable.json"
  else
    PINS_FILE=""
  fi
}

# ---------------------------------------------------------------------------
# pins/stable.json — UNPINNED placeholders are expected
# ---------------------------------------------------------------------------

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

# Pin / GitHub ref: letters, digits, dot, underscore, hyphen only. Blocks
# `?ref=` query injection and `$HUB_ROOT/migrations/${tag}` traversal.
valid_pin_tag() {
  [[ "${1:-}" =~ ^[A-Za-z0-9._-]+$ ]]
}

pgvector_image() {
  local img
  img="$(pin_get pgvector_image UNPINNED)"
  if [[ -z "${img}" || "${img}" == "UNPINNED" ]]; then
    warn "pins/stable.json pgvector_image is UNPINNED; using floating tag pgvector/pgvector:pg16"
    printf '%s\n' "pgvector/pgvector:pg16"
    return 0
  fi
  printf '%s\n' "${img}"
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------

parse_args() {
  FLAG_DOCKER=0
  FLAG_HELP=0
  FLAG_YES=0
  FLAG_FORCE=0
  MEMORY_MODE="lite"
  MEMORY_SET=0
  OWNER_ID="owner"
  OWNER_SET=0
  ADVERTISE_HOST=""
  INSTALL_MODE_SET=0
  PG_PORT="5432"
  PG_PORT_SET=0
  ROOT_SET=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        FLAG_HELP=1
        return 0
        ;;
      --docker)
        if [[ "${INSTALL_MODE_SET}" -eq 1 && "${FLAG_DOCKER}" -eq 0 ]]; then
          err "--docker conflicts with --bare-metal"
        fi
        FLAG_DOCKER=1
        INSTALL_MODE_SET=1
        shift
        ;;
      --bare-metal)
        if [[ "${INSTALL_MODE_SET}" -eq 1 && "${FLAG_DOCKER}" -eq 1 ]]; then
          err "--bare-metal conflicts with --docker"
        fi
        FLAG_DOCKER=0
        INSTALL_MODE_SET=1
        shift
        ;;
      --memory)
        if [[ $# -lt 2 ]]; then
          err "--memory requires 'lite' or 'full'"
        fi
        MEMORY_MODE="$2"
        if [[ "${MEMORY_MODE}" != "lite" && "${MEMORY_MODE}" != "full" ]]; then
          err "--memory must be 'lite' or 'full' (got '${MEMORY_MODE}')"
        fi
        MEMORY_SET=1
        shift 2
        ;;
      --memory=*)
        MEMORY_MODE="${1#--memory=}"
        if [[ "${MEMORY_MODE}" != "lite" && "${MEMORY_MODE}" != "full" ]]; then
          err "--memory must be 'lite' or 'full' (got '${MEMORY_MODE}')"
        fi
        MEMORY_SET=1
        shift
        ;;
      --owner)
        if [[ $# -lt 2 ]]; then
          err "--owner requires a user id"
        fi
        OWNER_ID="$2"
        OWNER_SET=1
        shift 2
        ;;
      --owner=*)
        OWNER_ID="${1#--owner=}"
        OWNER_SET=1
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
      --data-root)
        if [[ $# -lt 2 ]]; then
          err "--data-root requires a directory"
        fi
        RIVETHUB_ROOT="$2"
        ROOT_SET=1
        shift 2
        ;;
      --data-root=*)
        RIVETHUB_ROOT="${1#--data-root=}"
        ROOT_SET=1
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
      -y|--yes)
        FLAG_YES=1
        shift
        ;;
      --force)
        FLAG_FORCE=1
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
  validate_pg_port "${PG_PORT}" || err "invalid postgres port '${PG_PORT}' (expected 1-65535)"
  if [[ "${ROOT_SET}" -eq 1 ]]; then
    validate_data_root "${RIVETHUB_ROOT}" || err "invalid --data-root '${RIVETHUB_ROOT}' (expected an absolute path)"
  fi
  if [[ -z "${ADVERTISE_HOST}" && -n "${RIVETHUB_ADVERTISE_HOST:-}" ]]; then
    ADVERTISE_HOST="${RIVETHUB_ADVERTISE_HOST}"
  fi
  validate_owner_id "${OWNER_ID}" || err "invalid --owner '${OWNER_ID}' (expected [A-Za-z0-9][A-Za-z0-9._-]*)"
}

# Env fills only gaps flags did not set (flags win).
apply_env_defaults() {
  if [[ "${OWNER_SET}" -eq 0 && -n "${RIVETHUB_OWNER:-}" ]]; then
    OWNER_ID="${RIVETHUB_OWNER}"
    OWNER_SET=1
  fi
  if [[ "${MEMORY_SET}" -eq 0 && -n "${RIVETHUB_MEMORY:-}" ]]; then
    MEMORY_MODE="${RIVETHUB_MEMORY}"
    if [[ "${MEMORY_MODE}" != "lite" && "${MEMORY_MODE}" != "full" ]]; then
      err "RIVETHUB_MEMORY must be 'lite' or 'full' (got '${MEMORY_MODE}')"
    fi
    MEMORY_SET=1
  fi
  if [[ "${INSTALL_MODE_SET}" -eq 0 && -n "${RIVETHUB_INSTALL_MODE:-}" ]]; then
    case "${RIVETHUB_INSTALL_MODE,,}" in
      docker)
        FLAG_DOCKER=1
        ;;
      bare-metal|baremetal|bare_metal|bare)
        FLAG_DOCKER=0
        ;;
      *)
        err "RIVETHUB_INSTALL_MODE must be 'bare-metal' or 'docker' (got '${RIVETHUB_INSTALL_MODE}')"
        ;;
    esac
    INSTALL_MODE_SET=1
  fi
  if [[ "${PG_PORT_SET}" -eq 0 && -n "${RIVETHUB_PG_PORT:-}" ]]; then
    PG_PORT="${RIVETHUB_PG_PORT}"
    PG_PORT_SET=1
  fi
  if [[ "${ROOT_SET}" -eq 0 && -n "${RIVETHUB_ROOT:-}" ]]; then
    ROOT_SET=1
  fi
}

validate_owner_id() {
  local name="${1:-}"
  [[ -n "${name}" ]] || return 1
  [[ "${#name}" -le 64 ]] || return 1
  [[ "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

validate_pg_port() {
  local p="${1:-}" n
  [[ "${p}" =~ ^[0-9]+$ ]] || return 1
  n=$((10#${p}))
  [[ "${n}" -ge 1 && "${n}" -le 65535 ]]
}

validate_data_root() {
  local p="${1:-}"
  [[ -n "${p}" ]] || return 1
  [[ "${p}" == /* ]]
}

# ---------------------------------------------------------------------------
# curl-pipe — no checkout: fetch the helper bundle, verify against pins
#
# Pins and helpers come from the same origin over TLS, so the sha256 check
# catches a truncated or half-published bundle, not a compromised origin.
# A missing or non-sha256 pin is refused (fail closed), never skipped.
# ---------------------------------------------------------------------------

# Published path : pins/stable.json key holding its sha256.
BUNDLE_FILES=(
  "bin/rivethub-hub:hub_helper_sha256"
  "lib/rivet-ca.sh:rivet_ca_sha256"
  "systemd/rivet-embedder.service:rivet_embedder_unit_sha256"
  "systemd/rivet-compactor.service:rivet_compactor_unit_sha256"
)

fetch_distro_bundle() {
  local base dir entry rel key want got
  local -a proto=(--proto '=https' --proto-redir '=https')
  # The bats suites publish the bundle over file://.
  if in_test; then proto=(); fi
  base="${RIVETHUB_BASE_URL:-https://get.rivethub.io}"
  base="${base%/}"
  dir="$(mktemp -d "${TMPDIR:-/tmp}/rivethub-distro.XXXXXX")"
  _RIVETHUB_BUNDLE_DIR="${dir}"
  mkdir -p "${dir}/bin" "${dir}/lib" "${dir}/systemd" "${dir}/pins"
  if ! curl -fsSL "${proto[@]}" --max-time 30 -o "${dir}/pins/stable.json" -- "${base}/pins/stable.json"; then
    err "could not fetch ${base}/pins/stable.json (run from a rivethub checkout, or set RIVETHUB_DISTRO_DIR) — refusing before any write."
  fi
  PINS_FILE="${dir}/pins/stable.json"
  for entry in "${BUNDLE_FILES[@]}"; do
    rel="${entry%%:*}"
    key="${entry##*:}"
    want="$(pin_get "${key}" UNPINNED)"
    if [[ ! "${want}" =~ ^[0-9a-f]{64}$ ]]; then
      err "pins/stable.json ${key} is not a sha256 (got '${want}'); will not install an unverified ${rel} — refusing before any write."
    fi
    if ! curl -fsSL "${proto[@]}" --max-time 30 -o "${dir}/${rel}" -- "${base}/${rel}"; then
      err "could not fetch ${base}/${rel} — refusing before any write."
    fi
    got="$(sha256_file "${dir}/${rel}")"
    if [[ "${got}" != "${want}" ]]; then
      err "checksum mismatch for ${rel}: got ${got} want ${want} (pins/stable.json ${key}) — refusing before any write."
    fi
  done
  DISTRO_ROOT="${dir}"
  log "fetched helpers from ${base} (sha256 verified against pins/stable.json)"
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
    err "must run as root (sudo bash install/datahub.sh, or curl … | sudo bash)"
  fi
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

preflight_tools() {
  local t missing=()
  for t in curl openssl flock python3; do
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
      curl openssl python3 util-linux ca-certificates
  else
    err "missing required tools: ${missing[*]}"
  fi
  for t in curl openssl flock python3; do
    have_cmd "${t}" || err "still missing required tool: ${t}"
  done
}

# Postgres port is free, or already our datahub postgres. Docker re-runs must
# not require pg_isready (B2): the unit/container name is enough to call
# the listener "ours". Bare-metal↔docker switches are refused (the other
# side still holds 127.0.0.1:PG_PORT).
port_5432_state() {
  python3 - "${PG_PORT}" <<'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(0.4)
try:
    s.connect(("127.0.0.1", port))
except OSError:
    print("closed")
else:
    print("open")
finally:
    s.close()
PY
}

docker_postgres_is_ours() {
  if have_cmd systemctl && systemctl is-active --quiet rivethub-postgres.service 2>/dev/null; then
    return 0
  fi
  if have_cmd docker && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'rivethub-pg'; then
    return 0
  fi
  return 1
}

bare_metal_postgres_is_ours() {
  [[ -f "${HUB_ENV}" ]] && have_cmd pg_isready && pg_isready -h "${PG_HOST}" -p "${PG_PORT}" >/dev/null 2>&1
}

preflight_port() {
  local state
  if in_test; then
    return 0
  fi
  state="$(port_5432_state)"
  if [[ "${state}" != "open" ]]; then
    log "port ${PG_PORT} is free"
    return 0
  fi
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    if docker_postgres_is_ours; then
      log "port ${PG_PORT} is already our docker postgres (rivethub-postgres / rivethub-pg)"
      return 0
    fi
    err "port ${PG_PORT} is in use by a non-docker listener. Stop the existing postgres before --docker; the container cannot bind 127.0.0.1:${PG_PORT} otherwise."
  fi
  if bare_metal_postgres_is_ours; then
    log "port ${PG_PORT} is already our postgres (datahub.env present, pg_isready ok)"
    return 0
  fi
  if docker_postgres_is_ours; then
    err "port ${PG_PORT} is rivethub-postgres (docker). Stop that unit before a bare-metal install."
  fi
  err "port ${PG_PORT} is in use by something that is not this datahub (no ${HUB_ENV} + pg_isready). Stop that service or pick --docker on a free host."
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
  # Check the filesystem that will hold HUB_ROOT, not always /var/lib.
  target="${HUB_ROOT}"
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
  if [[ "${kb}" -lt 2097152 ]]; then
    warn "low disk on ${target} (${kb} KiB free); 2 GiB is a comfortable minimum"
  fi
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

# A helper bundle that cannot be fetched or verified, or UNPINNED migrations,
# must fail here, before ensure_layout or datahub.env (B3). RIVETHUB_TEST
# never touches the network unless RIVETHUB_BASE_URL is set.
preflight_sources() {
  local tag skipped unit
  if [[ -z "${DISTRO_ROOT}" ]]; then
    if in_test && [[ -z "${RIVETHUB_BASE_URL:-}" ]]; then
      err "cannot find bin/rivethub-hub (run from a rivethub checkout: sudo bash install/datahub.sh, or set RIVETHUB_DISTRO_DIR) — refusing before any write."
    fi
    if skipped="$(sibling_checkout_dir)"; then
      warn "not using the helpers in ${skipped}: it, or bin/ lib/ under it, is owned by another user or writable by others. Fetching verified copies instead. Only if you trust everything in that directory: set RIVETHUB_DISTRO_DIR=${skipped} to use it as is."
    fi
    fetch_distro_bundle
  elif [[ -n "${RIVETHUB_DISTRO_DIR:-}" ]] && ! in_test && ! trusted_checkout "${DISTRO_ROOT}"; then
    warn "RIVETHUB_DISTRO_DIR=${DISTRO_ROOT} is owned by another user or writable by others; its helpers run as root unverified because you set it."
  fi
  if [[ ! -f "${DISTRO_ROOT}/bin/rivethub-hub" || ! -f "${DISTRO_ROOT}/lib/rivet-ca.sh" ]]; then
    err "no bin/rivethub-hub + lib/rivet-ca.sh under ${DISTRO_ROOT} (check RIVETHUB_DISTRO_DIR) — refusing before any write."
  fi
  if [[ "${MEMORY_MODE}" == "full" ]]; then
    for unit in rivet-embedder.service rivet-compactor.service; do
      [[ -f "${DISTRO_ROOT}/systemd/${unit}" ]] \
        || err "no systemd/${unit} under ${DISTRO_ROOT} (check RIVETHUB_DISTRO_DIR) — refusing before any write."
    done
  fi
  if [[ -z "${RIVETHUB_MIGRATIONS_DIR:-}" ]]; then
    tag="$(pin_get rivetos_tag UNPINNED)"
    if [[ "${tag}" == "UNPINNED" ]]; then
      err "pins/stable.json rivetos_tag is UNPINNED; set RIVETHUB_MIGRATIONS_DIR to plugins/memory/postgres/src/schema/migrations from a rivetOS checkout (refusing before any write)"
    fi
    valid_pin_tag "${tag}" || err "pins/stable.json rivetos_tag '${tag}' is not a safe tag (expected [A-Za-z0-9._-]+)"
  fi
}

preflight() {
  preflight_root
  preflight_os
  preflight_arch
  preflight_tools
  preflight_sources
  preflight_port
  preflight_disk
  preflight_docker
}

# ---------------------------------------------------------------------------
# layout
# ---------------------------------------------------------------------------

ensure_layout() {
  local new_root=0 new_shared=0 new_users=0
  [[ -d "${HUB_ROOT}" ]] || new_root=1
  [[ -d "${HUB_SHARED}" ]] || new_shared=1
  [[ -d "${HUB_USERS_DIR}" ]] || new_users=1
  mkdir -p "${HUB_SHARED}" "${HUB_CA_ROOT}" "${HUB_USERS_DIR}"
  # Do not reset operator-chosen modes on re-run. ca-root must stay private.
  [[ "${new_root}" -eq 1 ]] && chmod 0755 "${HUB_ROOT}"
  [[ "${new_shared}" -eq 1 ]] && chmod 0755 "${HUB_SHARED}"
  [[ "${new_users}" -eq 1 ]] && chmod 0755 "${HUB_USERS_DIR}"
  chmod 0700 "${HUB_CA_ROOT}"
}

# ---------------------------------------------------------------------------
# datahub.env (0600) — password is never printed
# ---------------------------------------------------------------------------

generate_password() {
  openssl rand -hex 32
}

# Read PGPASSWORD from an existing env file without sourcing it.
env_get() {
  local key="$1"
  local file="${2:-${HUB_ENV}}"
  [[ -f "${file}" ]] || return 0
  python3 - "${file}" "${key}" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
prefix = key + "="
for raw in open(path, encoding="utf-8"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith(prefix):
        val = line[len(prefix):]
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        print(val)
        break
PY
}

write_datahub_env() {
  local pass="$1"
  local tmp old_umask
  tmp="${HUB_ENV}.tmp"
  old_umask="$(umask)"
  umask 077
  cat >"${tmp}" <<EOF
# RivetHub datahub connection. Mode 0600. Generated by install/datahub.sh.
# Do not print this file; the password lives only here.
RIVETOS_PG_URL=postgres://${PG_USER}:${pass}@${PG_HOST}:${PG_PORT}/${PG_DB}
PGHOST=${PG_HOST}
PGPORT=${PG_PORT}
PGUSER=${PG_USER}
PGDATABASE=${PG_DB}
PGPASSWORD=${pass}
POSTGRES_USER=${PG_USER}
POSTGRES_PASSWORD=${pass}
POSTGRES_DB=${PG_DB}
EOF
  umask "${old_umask}"
  chmod 0600 "${tmp}"
  mv -f "${tmp}" "${HUB_ENV}"
  chmod 0600 "${HUB_ENV}"
}

# Idempotent: reuse PGPASSWORD when datahub.env already has one so a re-run
# cannot desync the running cluster / docker volume. --force rotates.
reuse_or_create_password() {
  local existing=""
  if [[ "${FLAG_FORCE}" -eq 1 ]]; then
    log "generating new postgres password (--force; stored in ${HUB_ENV}, not printed)"
    generate_password
    return 0
  fi
  if [[ -f "${HUB_ENV}" ]]; then
    existing="$(env_get PGPASSWORD || true)"
  fi
  if [[ -n "${existing}" ]]; then
    log "reusing postgres password from ${HUB_ENV}"
    printf '%s\n' "${existing}"
    return 0
  fi
  log "generating postgres password (stored in ${HUB_ENV}, not printed)"
  generate_password
}

# ---------------------------------------------------------------------------
# postgres — bare-metal (PGDG 16 + pgvector) or docker
# ---------------------------------------------------------------------------

apt_get() {
  DEBIAN_FRONTEND=noninteractive apt-get "$@"
}

install_pgdg_and_postgres16() {
  local file codename=""
  if in_test; then
    log "RIVETHUB_TEST=1: skipping PGDG apt install"
    return 0
  fi
  file="$(os_release_file)"
  if [[ -f "${file}" ]]; then
    # shellcheck source=/dev/null
    . "${file}"
    codename="${VERSION_CODENAME:-}"
  fi
  [[ -n "${codename}" ]] || err "cannot determine VERSION_CODENAME for the PGDG apt source"
  log "installing PostgreSQL 16 + pgvector from PGDG (${codename}-pgdg)"
  mkdir -p /usr/share/postgresql-common/pgdg
  if [[ ! -f /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc ]]; then
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc
  fi
  cat >/etc/apt/sources.list.d/pgdg.list <<EOF
deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main
EOF
  apt_get update -qq
  apt_get install -y postgresql-16 postgresql-16-pgvector
  # || true: a slow/already-started cluster is caught by wait_for_postgres
  # (hard error after the cap). Do not abort the installer on a redundant start.
  if have_cmd pg_ctlcluster; then
    pg_ctlcluster 16 main start >/dev/null 2>&1 || true
  fi
  if have_cmd systemctl; then
    systemctl enable --now postgresql >/dev/null 2>&1 || true
  fi
}

write_postgres_docker_unit() {
  local unit="${SYSTEMD_DIR}/rivethub-postgres.service"
  local image
  image="$(pgvector_image)"
  mkdir -p "${SYSTEMD_DIR}"
  cat >"${unit}" <<EOF
# RivetHub Postgres 16 + pgvector (docker alternative to PGDG packages).
# Password and role come from ${HUB_ENV}; they are not on the docker CLI.
# Image: ${image} (pin pgvector_image in pins/stable.json; digest form
#   pgvector/pgvector@sha256:… preferred when a pin exists).
[Unit]
Description=RivetHub Postgres 16 (${image})
Requires=docker.service
After=docker.service

[Service]
Type=simple
Restart=always
RestartSec=5
EnvironmentFile=${HUB_ENV}
ExecStartPre=-/usr/bin/docker rm -f rivethub-pg
ExecStart=/usr/bin/docker run --name rivethub-pg --rm --env POSTGRES_USER --env POSTGRES_PASSWORD --env POSTGRES_DB -v rivethub-pgdata:/var/lib/postgresql/data -p 127.0.0.1:${PG_PORT}:5432 ${image}
ExecStop=/usr/bin/docker stop rivethub-pg
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rivethub-postgres

[Install]
WantedBy=multi-user.target
EOF
}

# Docker mode does not install postgresql-16, so psql/pg_isready would be
# missing on a clean host (B2). PGDG client matches the server major.
install_postgres_client() {
  log "docker mode needs postgresql-client-16 (psql/pg_isready)"
  if have_cmd psql && have_cmd pg_isready; then
    return 0
  fi
  if in_test; then
    log "RIVETHUB_TEST=1: skipping postgresql-client-16 install"
    return 0
  fi
  log "installing postgresql-client-16 (psql/pg_isready for docker mode)"
  if have_cmd apt-get; then
    apt_get update -qq
    apt_get install -y postgresql-client-16 || apt_get install -y postgresql-client || true
  fi
  have_cmd psql || err "psql not found after postgresql-client install (needed for --docker migrations)"
  have_cmd pg_isready || warn "pg_isready still missing; wait_for_postgres will skip"
}

install_postgres_docker() {
  install_postgres_client
  if in_test; then
    log "RIVETHUB_TEST=1: writing docker postgres unit, skipping docker/systemctl"
    write_postgres_docker_unit
    return 0
  fi
  write_postgres_docker_unit
  systemctl daemon-reload
  systemctl enable --now rivethub-postgres.service
}

wait_for_postgres() {
  local n=0
  local max=90
  if in_test; then
    return 0
  fi
  if ! have_cmd pg_isready; then
    warn "pg_isready not found; not waiting"
    return 0
  fi
  while (( n < max )); do
    n=$((n + 1))
    if pg_isready -h "${PG_HOST}" -p "${PG_PORT}" >/dev/null 2>&1; then
      log "postgres is ready"
      return 0
    fi
    sleep 1
  done
  err "postgres did not become ready on ${PG_HOST}:${PG_PORT} after ${max}s (image pull + initdb can exceed this). Re-run this installer to resume."
}

# Env-file reuse-not-rotate is wrong if datahub.env was lost and regenerated
# against a docker volume that still has the original POSTGRES_PASSWORD.
probe_postgres_password() {
  local pass
  if in_test; then
    return 0
  fi
  pass="$(env_get PGPASSWORD)"
  [[ -n "${pass}" ]] || err "no PGPASSWORD in ${HUB_ENV}"
  if PGPASSWORD="${pass}" psql -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; then
    return 0
  fi
  err "datahub.env password does not authenticate to ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}. If the env file was replaced, restore the original or wipe docker volume rivethub-pgdata / the bare-metal cluster and re-run."
}

# psql as the datahub role (TCP). Password from datahub.env, never argv logs.
psql_datahub() {
  local pass
  pass="$(env_get PGPASSWORD)"
  [[ -n "${pass}" ]] || err "no PGPASSWORD in ${HUB_ENV}"
  PGPASSWORD="${pass}" psql -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 "$@"
}

psql_as_postgres() {
  if [[ "${FLAG_DOCKER}" -eq 1 ]] || in_test; then
    # Docker POSTGRES_USER starts as superuser. Tests stub psql in PATH.
    psql_datahub "$@"
    return 0
  fi
  have_cmd runuser || err "runuser (util-linux) is required to run psql as postgres"
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 "$@"
}

# Feed SQL from a root-owned 0600 file on stdin. `psql -f` is opened *after*
# runuser drops to postgres, which cannot read the file (B1). Root keeps the
# fd; postgres inherits it. Never pass -f for secrets-bearing SQL.
psql_postgres_stdin() {
  local sql="$1"
  shift
  if [[ "${FLAG_DOCKER}" -eq 1 ]] || in_test; then
    psql_datahub "$@" <"${sql}"
    return 0
  fi
  have_cmd runuser || err "runuser (util-linux) is required to run psql as postgres"
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 "$@" <"${sql}"
}

# vector + pg_trgm as the bootstrap superuser so rivetos can stay a plain
# DB owner. 0001_baseline.sql's CREATE EXTENSION IF NOT EXISTS then no-ops.
ensure_pg_extensions() {
  local sql
  sql="$(mktemp "${TMPDIR:-/tmp}/rivethub-ext.XXXXXX.sql")"
  register_tmp "${sql}"
  cat >"${sql}" <<'EOF'
\set VERBOSITY terse
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
EOF
  chmod 0644 "${sql}"
  if [[ "${FLAG_DOCKER}" -eq 1 ]] || in_test; then
    psql_datahub <"${sql}" >/dev/null
  else
    psql_postgres_stdin "${sql}" -d "${PG_DB}" >/dev/null
  fi
  rm -f "${sql}"
}

demote_docker_app_role() {
  if in_test; then
    log "RIVETHUB_TEST=1: skipping ALTER ROLE NOSUPERUSER"
    return 0
  fi
  log "demoting docker role ${PG_USER} to NOSUPERUSER (extensions already created)"
  psql_datahub -c "ALTER ROLE ${PG_USER} NOSUPERUSER" >/dev/null
}

ensure_postgres_role_db() {
  local pass sql old_umask
  pass="$(env_get PGPASSWORD)"
  [[ -n "${pass}" ]] || err "no PGPASSWORD in ${HUB_ENV}"
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    wait_for_postgres
    probe_postgres_password
    log "docker postgres role/db created by the image (POSTGRES_USER=${PG_USER})"
    ensure_pg_extensions
    demote_docker_app_role
    return 0
  fi
  if in_test; then
    log "RIVETHUB_TEST=1: stub role/db ensure via psql"
  else
    wait_for_postgres
  fi
  # Hex password is URL- and SQL-literal safe. rivetos is a LOGIN DB owner,
  # not SUPERUSER: CREATE EXTENSION ran as postgres (ensure_pg_extensions).
  # Workers hold RIVETOS_PG_URL as User=rivet — a compromised worker must
  # not be a DB superuser.
  sql="$(mktemp "${TMPDIR:-/tmp}/rivethub-pg.XXXXXX.sql")"
  register_tmp "${sql}"
  old_umask="$(umask)"
  umask 077
  cat >"${sql}" <<EOF
\\set VERBOSITY terse
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${PG_USER}') THEN
    CREATE ROLE ${PG_USER} LOGIN PASSWORD '${pass}';
  ELSE
    ALTER ROLE ${PG_USER} WITH LOGIN PASSWORD '${pass}';
  END IF;
END
\$\$;
EOF
  umask "${old_umask}"
  chmod 0600 "${sql}"
  if in_test || [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    psql_datahub -d postgres <"${sql}" >/dev/null
  else
    psql_postgres_stdin "${sql}" >/dev/null
  fi
  rm -f "${sql}"
  if in_test || [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    if ! PGPASSWORD="${pass}" psql -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; then
      PGPASSWORD="${pass}" psql -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" -d postgres -v ON_ERROR_STOP=1 \
        -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER}" >/dev/null
    fi
  else
    if ! psql_as_postgres -d "${PG_DB}" -c 'SELECT 1' >/dev/null 2>&1; then
      psql_as_postgres -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER}" >/dev/null
    fi
  fi
  ensure_pg_extensions
}

install_postgres() {
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    install_postgres_docker
  else
    install_pgdg_and_postgres16
  fi
  ensure_postgres_role_db
}

# ---------------------------------------------------------------------------
# migrations — match plugins/memory/postgres/src/schema/migrate.ts
#
# Proven against migrate.ts (quoted, not assumed):
#
#   (a) DDL equality — ensureMigrationsTable:
#         CREATE TABLE IF NOT EXISTS _rivetos_migrations (
#           name        TEXT PRIMARY KEY,
#           applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
#           checksum    TEXT
#         )
#   (b) checksum NULL semantics — apply() inserts only (name); getApplied()
#       SELECTs only name. Runtime never compares stored checksum to file
#       bytes, so a populated checksum (or NULL) cannot cause re-apply/error.
#       We still store sha256 so a future runtime compare has a real value,
#       and so GitHub-fetched SQL is verified before \\i.
#   (c) same-transaction insert — apply(): BEGIN; query(sql); INSERT name;
#       COMMIT. We do BEGIN; \\i file; INSERT (name, checksum); COMMIT.
#   (d) schema/search-path + role — run() uses RIVETOS_PG_URL as rivetos over
#       TCP (default public search_path). Installer applies as rivetos over
#       TCP the same way. Extensions are created first as postgres so 0001's
#       CREATE EXTENSION IF NOT EXISTS no-ops without SUPERUSER.
#
# Name is the filename including .sql, lexical order, one transaction each.
# ---------------------------------------------------------------------------

# Print basenames of *.sql in dir, LC_ALL=C sort (same as listMigrations).
list_migration_names() {
  local dir="$1"
  [[ -d "${dir}" ]] || return 0
  (
    shopt -s nullglob
    local f
    local -a files=()
    for f in "${dir}"/*.sql; do
      files+=("$(basename "${f}")")
    done
    if [[ ${#files[@]} -eq 0 ]]; then
      exit 0
    fi
    printf '%s\n' "${files[@]}" | LC_ALL=C sort
  )
}

valid_migration_name() {
  [[ "${1:-}" =~ ^[0-9A-Za-z._-]+\.sql$ ]]
}

migrations_source_dir() {
  local tag dest
  if [[ -n "${RIVETHUB_MIGRATIONS_DIR:-}" ]]; then
    printf '%s\n' "${RIVETHUB_MIGRATIONS_DIR}"
    return 0
  fi
  tag="$(pin_get rivetos_tag UNPINNED)"
  if [[ "${tag}" == "UNPINNED" ]]; then
    err "pins/stable.json rivetos_tag is UNPINNED; set RIVETHUB_MIGRATIONS_DIR to plugins/memory/postgres/src/schema/migrations from a rivetOS checkout"
  fi
  valid_pin_tag "${tag}" || err "pins/stable.json rivetos_tag '${tag}' is not a safe tag (expected [A-Za-z0-9._-]+)"
  dest="${HUB_ROOT}/migrations/${tag}"
  fetch_migrations_from_tag "${tag}" "${dest}"
  printf '%s\n' "${dest}"
}

sha256_file() {
  python3 - "$1" <<'PY'
import hashlib, sys
path = sys.argv[1]
h = hashlib.sha256()
with open(path, "rb") as f:
    for chunk in iter(lambda: f.read(65536), b""):
        h.update(chunk)
print(h.hexdigest())
PY
}

# If a .sha256 sidecar exists (written on GitHub fetch), require a match
# before applying. Always print the computed digest for the tracking INSERT.
verify_migration_checksum() {
  local file="$1"
  local side="${file}.sha256"
  local got want
  got="$(sha256_file "${file}")"
  if [[ -f "${side}" ]]; then
    want="$(tr -d ' \t\r\n' <"${side}")"
    want="${want%%:*}"
    if [[ "${got}" != "${want}" ]]; then
      err "checksum mismatch for $(basename "${file}"): got ${got} want ${want}"
    fi
  fi
  printf '%s\n' "${got}"
}

fetch_migrations_from_tag() {
  local tag="$1"
  local dest="$2"
  local api names name url digest
  valid_pin_tag "${tag}" || err "refusing migration tag '${tag}'"
  mkdir -p "${dest}"
  log "fetching migrations from github.com/${RIVETOS_GITHUB_REPO}@${tag}"
  api="https://api.github.com/repos/${RIVETOS_GITHUB_REPO}/contents/plugins/memory/postgres/src/schema/migrations?ref=${tag}"
  names="$(curl -fsSL "${api}" | python3 -c '
import json, sys
data = json.load(sys.stdin)
if not isinstance(data, list):
    sys.stderr.write("datahub.sh: unexpected GitHub API response for migrations\n")
    sys.exit(1)
for ent in data:
    name = ent.get("name") or ""
    if name.endswith(".sql"):
        print(name)
')"
  if [[ -z "${names}" ]]; then
    err "no .sql migrations listed for tag ${tag}"
  fi
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    valid_migration_name "${name}" || err "refusing migration name '${name}'"
    url="https://raw.githubusercontent.com/${RIVETOS_GITHUB_REPO}/${tag}/plugins/memory/postgres/src/schema/migrations/${name}"
    curl -fsSL -o "${dest}/${name}" "${url}"
    digest="$(sha256_file "${dest}/${name}")"
    printf '%s\n' "${digest}" >"${dest}/${name}.sha256"
    chmod 0644 "${dest}/${name}.sha256"
  done <<<"${names}"
}

ensure_migrations_table() {
  psql_datahub <<'SQL' >/dev/null
CREATE TABLE IF NOT EXISTS _rivetos_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum    TEXT
);
SQL
}

migration_is_applied() {
  local name="$1"
  local out=""
  out="$(psql_datahub -tAc "SELECT 1 FROM _rivetos_migrations WHERE name = '${name}'" 2>/dev/null || true)"
  out="${out//[$'\t\r\n ']/}"
  [[ "${out}" == "1" ]]
}

apply_one_migration() {
  local dir="$1"
  local name="$2"
  local wrap digest
  digest="$(verify_migration_checksum "${dir}/${name}")"
  wrap="$(mktemp "${TMPDIR:-/tmp}/rivethub-mig.XXXXXX.sql")"
  register_tmp "${wrap}"
  cat >"${wrap}" <<EOF
\\set VERBOSITY terse
BEGIN;
\\i '${dir}/${name}'
INSERT INTO _rivetos_migrations (name, checksum) VALUES ('${name}', '${digest}');
COMMIT;
EOF
  psql_datahub -f "${wrap}" >/dev/null
  rm -f "${wrap}"
  log "applied ${name}"
}

apply_migrations() {
  local dir name
  dir="$(migrations_source_dir)"
  [[ -d "${dir}" ]] || err "migrations dir not found: ${dir}"
  ensure_migrations_table
  local count=0
  local applied=0
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    valid_migration_name "${name}" || err "refusing migration name '${name}'"
    count=$((count + 1))
    if migration_is_applied "${name}"; then
      log "skip ${name} (already in _rivetos_migrations)"
      continue
    fi
    apply_one_migration "${dir}" "${name}"
    applied=$((applied + 1))
  done < <(list_migration_names "${dir}")
  if [[ "${count}" -eq 0 ]]; then
    err "no .sql migrations in ${dir}"
  fi
  log "migrations: ${count} found, ${applied} applied"
}

# ---------------------------------------------------------------------------
# install rivethub-hub + rivet-ca.sh, then ca-init
# ---------------------------------------------------------------------------

install_one_helper() {
  local src="$1"
  local dest="$2"
  local mode="$3"
  if [[ -f "${dest}" ]]; then
    if cmp -s "${src}" "${dest}"; then
      chmod "${mode}" "${dest}"
      return 0
    fi
    cp -f "${dest}" "${dest}.prev"
    chmod 0644 "${dest}.prev"
    warn "replacing ${dest} (it differs from this release); previous copy kept at ${dest}.prev"
  fi
  # Temp file + mv: a helper someone is running is never read half-written.
  cp -f "${src}" "${dest}.new"
  chmod "${mode}" "${dest}.new"
  mv -f "${dest}.new" "${dest}"
}

install_hub_helper() {
  local src_hub src_ca
  if [[ -z "${DISTRO_ROOT}" ]]; then
    err "cannot find bin/rivethub-hub (run from a rivethub checkout, or set RIVETHUB_DISTRO_DIR)."
  fi
  src_hub="${DISTRO_ROOT}/bin/rivethub-hub"
  src_ca="${DISTRO_ROOT}/lib/rivet-ca.sh"
  [[ -f "${src_hub}" ]] || err "missing ${src_hub}"
  [[ -f "${src_ca}" ]] || err "missing ${src_ca}"
  mkdir -p "${BIN_DIR}" "${LIB_DIR}"
  install_one_helper "${src_hub}" "${BIN_DIR}/rivethub-hub" 0755
  install_one_helper "${src_ca}" "${LIB_DIR}/rivet-ca.sh" 0644
  log "installed ${BIN_DIR}/rivethub-hub and ${LIB_DIR}/rivet-ca.sh"
}

run_ca_init() {
  local hub="${BIN_DIR}/rivethub-hub"
  local ca="${RIVETHUB_CA_SCRIPT:-${LIB_DIR}/rivet-ca.sh}"
  [[ -f "${hub}" ]] || err "rivethub-hub not installed at ${hub}"
  if [[ "${FLAG_FORCE}" -eq 1 ]]; then
    log "ca-init --force (CA root will be recreated)"
    env \
      RIVETHUB_ROOT="${HUB_ROOT}" \
      RIVETHUB_CA_SCRIPT="${ca}" \
      bash "${hub}" ca-init --force
    return 0
  fi
  env \
    RIVETHUB_ROOT="${HUB_ROOT}" \
    RIVETHUB_CA_SCRIPT="${ca}" \
    bash "${hub}" ca-init
}

# ---------------------------------------------------------------------------
# users.json — packages/types/src/users-registry.ts UsersRegistry
#   { ownerUserId, unmappedIsOwner, users: { [id]: { id, devices, db?, persona? } } }
# File registry: unmappedIsOwner=false (fail closed). pgUrl omitted — it is a
# secret; callers merge UserDbEntry from RIVETOS_PG_URL / datahub.env.
# ---------------------------------------------------------------------------

write_users_json() {
  local owner="$1"
  mkdir -p "${HUB_USERS_DIR}"
  if [[ -f "${HUB_USERS}" ]]; then
    python3 - "${HUB_USERS}" <<'PY' >/dev/null
import json, sys
path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
if not isinstance(data, dict):
    raise SystemExit("users.json is not an object")
if not isinstance(data.get("ownerUserId"), str) or not data["ownerUserId"].strip():
    raise SystemExit("users.json missing ownerUserId")
if not isinstance(data.get("users"), dict):
    raise SystemExit("users.json users is not an object")
PY
    log "users.json already present at ${HUB_USERS}; leaving it in place"
    return 0
  fi
  python3 - "${HUB_USERS}" "${owner}" <<'PY'
import json, os, sys
path, owner = sys.argv[1], sys.argv[2]
doc = {
    "ownerUserId": owner,
    "unmappedIsOwner": False,
    "users": {
        owner: {
            "id": owner,
            "devices": [],
        }
    },
}
tmp = path + ".tmp"
umask = os.umask(0o077)
try:
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
finally:
    os.umask(umask)
PY
  chmod 0600 "${HUB_USERS}"
  # Units run as User=rivet. If that user exists, they must be able to open
  # the registry; otherwise leave root:root (memory-lite, no unprivileged
  # worker). Root can always read.
  if id -u rivet >/dev/null 2>&1; then
    chown rivet:rivet "${HUB_USERS}" 2>/dev/null || true
  fi
  log "seeded users.json (owner=${owner}) at ${HUB_USERS}"
}

# ---------------------------------------------------------------------------
# --memory full: env + unit files. Node runtime is a follow-up.
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

append_worker_env() {
  local embed_url="$1"
  local embed_model="$2"
  local compact_url="$3"
  local compact_model="$4"
  python3 - "${HUB_ENV}" "${embed_url}" "${embed_model}" "${compact_url}" "${compact_model}" <<'PY'
import os, sys
path, embed_url, embed_model, compact_url, compact_model = sys.argv[1:6]
keys = {
    "RIVETOS_EMBED_URL": embed_url,
    "RIVETOS_EMBED_MODEL": embed_model,
    "RIVETOS_COMPACTOR_URL": compact_url,
    "RIVETOS_COMPACTOR_MODEL": compact_model,
}
lines = []
if os.path.exists(path):
    lines = open(path, encoding="utf-8").read().splitlines()
kept = []
seen = set()
for line in lines:
    stripped = line.strip()
    hit = False
    for k in keys:
        if stripped.startswith(k + "="):
            hit = True
            break
    if not hit:
        kept.append(line)
out = kept[:]
if out and out[-1] != "":
    out.append("")
for k, v in keys.items():
    out.append(f"{k}={v}")
tmp = path + ".tmp"
os.umask(0o077)
with open(tmp, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
os.chmod(path, 0o600)
PY
}

install_worker_units() {
  local src_dir unit dest node_bin
  mkdir -p "${SYSTEMD_DIR}"
  if [[ -n "${DISTRO_ROOT}" && -d "${DISTRO_ROOT}/systemd" ]]; then
    src_dir="${DISTRO_ROOT}/systemd"
  else
    err "cannot find systemd/ unit templates (set RIVETHUB_DISTRO_DIR)"
  fi
  node_bin="$(command -v node 2>/dev/null || true)"
  if [[ -z "${node_bin}" ]]; then
    node_bin="/usr/bin/node"
    warn "node not in PATH; worker ExecStart keeps ${node_bin} (nvm /usr/local node will crash-loop until node is on PATH)"
  else
    log "worker ExecStart node: ${node_bin}"
  fi
  for unit in rivet-embedder.service rivet-compactor.service; do
    [[ -f "${src_dir}/${unit}" ]] || err "missing ${src_dir}/${unit}"
    dest="${SYSTEMD_DIR}/${unit}"
    python3 - "${src_dir}/${unit}" "${dest}" "${HUB_ROOT}" "${node_bin}" <<'PY'
import sys
src, dest, root, node_bin = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = open(src, encoding="utf-8").read()
# Templates hardcode the distro default; rewrite if the operator overrode it.
text = text.replace("/var/lib/rivethub", root)
text = text.replace("ExecStart=/usr/bin/node ", "ExecStart=" + node_bin + " ")
open(dest, "w", encoding="utf-8").write(text)
PY
    chmod 0644 "${dest}"
    log "installed ${dest} (not enabled until the runtime exists)"
  done
  if in_test; then
    return 0
  fi
  if ! id -u rivet >/dev/null 2>&1; then
    log "creating system user rivet"
    if [[ -d /home/rivet ]]; then
      # Existing fleet home: do not --create-home (would chown the tree).
      useradd --system --no-create-home --home-dir /home/rivet --shell /usr/sbin/nologin rivet
    else
      useradd --system --create-home --home-dir /home/rivet --shell /usr/sbin/nologin rivet
    fi
  fi
  if [[ -f "${HUB_USERS}" ]]; then
    chown rivet:rivet "${HUB_USERS}" 2>/dev/null || true
  fi
  if have_cmd systemctl; then
    systemctl daemon-reload
    local runtime="/opt/rivetos"
    if [[ ! -x "${node_bin}" ]] && ! have_cmd node; then
      log "node not found at ${node_bin}; units installed but not started"
      return 0
    fi
    if [[ -f "${runtime}/services/embedding-worker/dist/index.js" && -f "${runtime}/services/compaction-worker/dist/index.js" ]]; then
      systemctl enable --now rivet-embedder.service rivet-compactor.service
      log "enabled memory workers (runtime found at ${runtime})"
    else
      log "runtime not at ${runtime}; units installed but not started (see banner TODO)"
    fi
  fi
}

configure_memory_full() {
  local embed_url embed_model compact_url compact_model
  embed_url="${RIVETOS_EMBED_URL:-}"
  embed_model="${RIVETOS_EMBED_MODEL:-nemotron}"
  compact_url="${RIVETOS_COMPACTOR_URL:-}"
  compact_model="${RIVETOS_COMPACTOR_MODEL:-}"
  if [[ -z "${embed_url}" ]]; then
    prompt_if_tty "OpenAI-compatible embed base URL" ""
    embed_url="${WIZARD_REPLY}"
  fi
  if [[ -z "${compact_url}" ]]; then
    prompt_if_tty "OpenAI-compatible compaction base URL" ""
    compact_url="${WIZARD_REPLY}"
  fi
  if [[ -z "${compact_model}" ]]; then
    prompt_if_tty "compaction model" ""
    compact_model="${WIZARD_REPLY}"
  fi
  if [[ -z "${embed_url}" || -z "${compact_url}" || -z "${compact_model}" ]]; then
    collect_unanswered_questions
    fail_unanswered_questions
    err "--memory full needs RIVETOS_EMBED_URL, RIVETOS_COMPACTOR_URL and RIVETOS_COMPACTOR_MODEL (or a TTY /dev/tty to prompt)"
  fi
  if can_prompt && [[ -z "${RIVETOS_EMBED_MODEL:-}" ]]; then
    prompt_if_tty "embed model" "${embed_model}"
    embed_model="${WIZARD_REPLY}"
  fi
  append_worker_env "${embed_url}" "${embed_model}" "${compact_url}" "${compact_model}"
  chmod 0600 "${HUB_ENV}"
  install_worker_units
}

# ---------------------------------------------------------------------------
# banner — next steps. Password is never printed; path is.
# ---------------------------------------------------------------------------

print_banner() {
  local host pg_kind
  host="${ADVERTISE_HOST}"
  if [[ -z "${host}" ]]; then
    host="$(hostname -f 2>/dev/null || hostname 2>/dev/null || true)"
  fi
  if [[ -z "${host}" ]]; then
    host="this-host"
  fi
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    pg_kind="docker"
  else
    pg_kind="bare-metal"
  fi
  cat <<EOF

RivetHub datahub ${VERSION} is installed.

  hub root:       ${HUB_ROOT}
  postgres:       ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}  (${pg_kind})
  password file:  ${HUB_ENV}  (mode 0600 — the password is not printed)
  users.json:     ${HUB_USERS}  (owner=${OWNER_ID}; --owner only seeds first run)
  ca:             ${HUB_CA_ROOT} (root key stays on this host)
  memory:         ${MEMORY_MODE}

Check:
  rivethub-hub status

On the first agent node, enroll against this datahub:

  curl -fsSL https://get.rivethub.io/node.sh | sudo bash -s -- --hub user@this-host

Replace user@this-host with an SSH login that can run rivethub-hub on this
host (example: owner@${host}).

EOF
  if [[ "${MEMORY_MODE}" == "full" ]]; then
    cat <<EOF
TODO (--memory full, v1): rivet-embedder.service and rivet-compactor.service
are installed under ${SYSTEMD_DIR} and the OpenAI-compatible endpoints are in
${HUB_ENV}, but this installer does not vendor a Node runtime. Place a pinned
rivetOS tree at /opt/rivetos (workers at services/{embedding,compaction}-worker/dist/index.js)
then: systemctl enable --now rivet-embedder rivet-compactor
EOF
  fi
}

# ---------------------------------------------------------------------------
# wizard — field prompts, existing-install, SUMMARY, confirm
# ---------------------------------------------------------------------------

existing_datahub() {
  [[ -f "${HUB_ENV}" ]] || [[ -f "${HUB_CA_ROOT}/ca.key" ]] || [[ -f "${HUB_USERS}" ]]
}

print_existing_state() {
  log "existing datahub detected at ${HUB_ROOT}"
  if [[ -f "${HUB_ENV}" ]]; then
    log "  datahub.env: present (postgres password reused unless --force)"
  else
    log "  datahub.env: absent"
  fi
  if [[ -f "${HUB_CA_ROOT}/ca.key" ]]; then
    log "  CA root: present (ca-init will not overwrite unless --force)"
  else
    log "  CA root: absent"
  fi
  if [[ -f "${HUB_USERS}" ]]; then
    log "  users.json: present (will not clobber)"
  else
    log "  users.json: absent"
  fi
  if [[ "${FLAG_FORCE}" -eq 1 ]]; then
    log "  --force: CA will be re-inited and the postgres password rotated"
  fi
}

prompt_owner_field() {
  local reply
  if [[ "${OWNER_SET}" -eq 1 ]]; then
    return 0
  fi
  prompt_line "Owner user id" "${OWNER_ID}"
  reply="${WIZARD_REPLY}"
  validate_owner_id "${reply}" || err "invalid owner id '${reply}'"
  OWNER_ID="${reply}"
  OWNER_SET=1
}

prompt_memory_field() {
  local reply
  if [[ "${MEMORY_SET}" -eq 0 ]]; then
    while true; do
      prompt_line "Memory mode (lite/full)" "${MEMORY_MODE}"
      reply="${WIZARD_REPLY}"
      case "${reply,,}" in
        lite|full)
          MEMORY_MODE="${reply,,}"
          MEMORY_SET=1
          break
          ;;
        *)
          log "please answer lite or full"
          ;;
      esac
    done
  fi
  if [[ "${MEMORY_MODE}" == "full" ]]; then
    fill_memory_full_endpoints
  fi
}

fill_memory_full_endpoints() {
  local base=""
  if [[ -z "${RIVETOS_EMBED_URL:-}" && -z "${RIVETOS_COMPACTOR_URL:-}" ]]; then
    prompt_line "OpenAI-compatible base URL" ""
    base="${WIZARD_REPLY}"
    [[ -n "${base}" ]] || err "OpenAI-compatible base URL is required for memory full"
    RIVETOS_EMBED_URL="${base}"
    RIVETOS_COMPACTOR_URL="${base}"
  else
    if [[ -z "${RIVETOS_EMBED_URL:-}" ]]; then
      prompt_line "OpenAI-compatible embed base URL" "${RIVETOS_COMPACTOR_URL:-}"
      RIVETOS_EMBED_URL="${WIZARD_REPLY}"
    fi
    if [[ -z "${RIVETOS_COMPACTOR_URL:-}" ]]; then
      prompt_line "OpenAI-compatible compaction base URL" "${RIVETOS_EMBED_URL:-}"
      RIVETOS_COMPACTOR_URL="${WIZARD_REPLY}"
    fi
  fi
  [[ -n "${RIVETOS_EMBED_URL:-}" ]] || err "RIVETOS_EMBED_URL is required for memory full"
  [[ -n "${RIVETOS_COMPACTOR_URL:-}" ]] || err "RIVETOS_COMPACTOR_URL is required for memory full"
  if [[ -z "${RIVETOS_EMBED_MODEL:-}" ]]; then
    prompt_line "embed model" "nemotron"
    RIVETOS_EMBED_MODEL="${WIZARD_REPLY}"
  fi
  if [[ -z "${RIVETOS_COMPACTOR_MODEL:-}" ]]; then
    prompt_line "compaction model" ""
    RIVETOS_COMPACTOR_MODEL="${WIZARD_REPLY}"
  fi
  [[ -n "${RIVETOS_COMPACTOR_MODEL:-}" ]] || err "RIVETOS_COMPACTOR_MODEL is required for memory full"
  export RIVETOS_EMBED_URL RIVETOS_EMBED_MODEL RIVETOS_COMPACTOR_URL RIVETOS_COMPACTOR_MODEL
}

prompt_install_mode_field() {
  local reply
  if [[ "${INSTALL_MODE_SET}" -eq 1 ]]; then
    return 0
  fi
  while true; do
    prompt_line "Install mode (bare-metal/docker)" "bare-metal"
    reply="${WIZARD_REPLY}"
    case "${reply,,}" in
      bare-metal|baremetal|bare_metal|bare)
        FLAG_DOCKER=0
        INSTALL_MODE_SET=1
        break
        ;;
      docker)
        FLAG_DOCKER=1
        INSTALL_MODE_SET=1
        break
        ;;
      *)
        log "please answer bare-metal or docker"
        ;;
    esac
  done
}

prompt_pg_port_field() {
  local reply
  if [[ "${PG_PORT_SET}" -eq 1 ]]; then
    return 0
  fi
  prompt_line "Postgres port" "${PG_PORT}"
  reply="${WIZARD_REPLY}"
  validate_pg_port "${reply}" || err "invalid postgres port '${reply}' (expected 1-65535)"
  PG_PORT="${reply}"
  PG_PORT_SET=1
}

prompt_data_root_field() {
  local reply
  if [[ "${ROOT_SET}" -eq 1 ]]; then
    return 0
  fi
  prompt_line "Data root" "${RIVETHUB_ROOT:-/var/lib/rivethub}"
  reply="${WIZARD_REPLY}"
  validate_data_root "${reply}" || err "invalid data root '${reply}' (expected an absolute path)"
  RIVETHUB_ROOT="${reply}"
  ROOT_SET=1
}

prompt_fresh_fields() {
  prompt_owner_field
  prompt_memory_field
  prompt_install_mode_field
  prompt_pg_port_field
  prompt_data_root_field
}

prompt_reconfigure_fields() {
  # Safe bits only: memory workers. Owner, CA, password, port, root, docker
  # stay put (changing those is not a reconfigure; --force is the CA/password
  # hammer, a new --data-root is a different install).
  MEMORY_SET=0
  prompt_memory_field
}

wizard_existing_action() {
  local reply
  print_existing_state
  if [[ "${FLAG_YES}" -eq 1 ]]; then
    WIZARD_ACTION="resume"
    log "existing install: resume (--yes)"
    return 0
  fi
  while true; do
    prompt_line "Existing install: resume / reconfigure (memory workers) / abort" "resume"
    reply="${WIZARD_REPLY}"
    case "${reply,,}" in
      resume|r|"")
        WIZARD_ACTION="resume"
        return 0
        ;;
      reconfigure|reconfig|safe)
        WIZARD_ACTION="reconfigure"
        return 0
        ;;
      abort|a|n|no|q|quit)
        WIZARD_ACTION="abort"
        err "aborted by operator (existing install left untouched)"
        ;;
      *)
        log "please answer resume, reconfigure, or abort"
        ;;
    esac
  done
}

# One error, complete shopping list (F2). Never surface questions one-at-a-time
# on a non-TTY rerun. Each entry already names the env var / flag.
fail_unanswered_questions() {
  local line
  if [[ ${#UNANSWERED_QUESTIONS[@]} -eq 0 ]]; then
    return 0
  fi
  printf 'datahub.sh: cannot prompt (stdin is not a TTY and /dev/tty is unavailable). Unanswered questions:\n' >&2
  for line in "${UNANSWERED_QUESTIONS[@]}"; do
    printf '  - %s\n' "${line}" >&2
  done
  printf 'datahub.sh: pass the flags or environment variables above, or re-run on a TTY. Fields with a documented default are not listed.\n' >&2
  exit 1
}

# Fields with documented defaults are filled (F1: --yes / non-TTY). Fields
# with no default (memory-full URLs, compaction model) are collected, not guessed.
collect_unanswered_questions() {
  UNANSWERED_QUESTIONS=()
  if [[ "${MEMORY_MODE}" == "full" ]]; then
    if [[ -z "${RIVETOS_EMBED_URL:-}" ]]; then
      UNANSWERED_QUESTIONS+=("OpenAI-compatible embed base URL (RIVETOS_EMBED_URL)")
    fi
    if [[ -z "${RIVETOS_COMPACTOR_URL:-}" ]]; then
      UNANSWERED_QUESTIONS+=("OpenAI-compatible compaction base URL (RIVETOS_COMPACTOR_URL)")
    fi
    if [[ -z "${RIVETOS_COMPACTOR_MODEL:-}" ]]; then
      UNANSWERED_QUESTIONS+=("compaction model (RIVETOS_COMPACTOR_MODEL)")
    fi
  fi
}

apply_noninteractive_defaults() {
  # Values already sit in OWNER_ID / MEMORY_MODE / FLAG_DOCKER / PG_PORT /
  # RIVETHUB_ROOT from parse_args. --yes on non-TTY is the spelling that
  # means "keep those defaults"; the historical no-TTY path does the same
  # so existing e2e / bats without --yes still install.
  if existing_datahub; then
    WIZARD_ACTION="resume"
    if [[ "${FLAG_YES}" -eq 1 ]]; then
      log "existing install: resume (--yes)"
    else
      log "existing install: resume (non-TTY)"
    fi
  else
    WIZARD_ACTION="fresh"
  fi
  if [[ "${FLAG_YES}" -eq 1 ]]; then
    log "non-TTY --yes: accepting documented defaults for unset fields"
  fi
  collect_unanswered_questions
  fail_unanswered_questions
}

# Prompt-capable: fill gaps, then SUMMARY + confirm (unless --yes).
# No prompt source: defaults + flags; --yes is the one-click spelling.
# Unanswerable fields (no default) are listed together (F2).
run_wizard_flow() {
  WIZARD_ACTION="noninteractive"
  if ! can_prompt; then
    apply_noninteractive_defaults
    return 0
  fi
  # Open the prompt fd in this shell before any field helper. Helpers used
  # to call $(prompt_line), which is a subshell — each reopen of
  # RIVETHUB_PROMPT_IN started at byte 0, so a retry loop (invalid memory
  # mode, etc.) never consumed the file and wedged the bats suite.
  if ! wizard_open_prompt_fd; then
    apply_noninteractive_defaults
    return 0
  fi
  if existing_datahub; then
    wizard_existing_action
    if [[ "${WIZARD_ACTION}" == "reconfigure" ]]; then
      prompt_reconfigure_fields
    elif [[ "${MEMORY_MODE}" == "full" ]]; then
      # configure_memory_full runs last; ask here so a missing value is
      # refused before the install, not after it.
      fill_memory_full_endpoints
    fi
  else
    WIZARD_ACTION="fresh"
    prompt_fresh_fields
  fi
  init_paths
}

print_summary() {
  local pg_kind packages services
  if [[ "${FLAG_DOCKER}" -eq 1 ]]; then
    pg_kind="docker"
    packages="postgresql-client-16 (psql/pg_isready); docker image from pins/stable.json pgvector_image (else pgvector/pgvector:pg16)"
    services="rivethub-postgres.service (127.0.0.1:${PG_PORT}:5432)"
  else
    pg_kind="bare-metal"
    packages="postgresql-16 + postgresql-16-pgvector from PGDG (${PG_PORT})"
    services="postgresql (PGDG cluster)"
  fi
  if [[ "${MEMORY_MODE}" == "full" ]]; then
    services="${services}; rivet-embedder.service + rivet-compactor.service (installed, not started until a rivetOS runtime exists)"
  fi
  cat <<EOF

SUMMARY — about to install RivetHub datahub ${VERSION}

  owner:          ${OWNER_ID}
  memory:         ${MEMORY_MODE}
  install mode:   ${pg_kind}
  postgres:       ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}
  data root:      ${HUB_ROOT}
  action:         ${WIZARD_ACTION:-fresh}

  packages:       ${packages}
  services:       ${services}
  helpers:        rivethub-hub + rivet-ca.sh into ${BIN_DIR} / ${LIB_DIR}

  paths:
    ${HUB_ROOT}              hub root (0755)
    ${HUB_CA_ROOT}           CA root dir (0700)
    ${HUB_ENV}               conninfo (0600)
    ${HUB_USERS}             users.json (0600)

  secrets (values never printed):
    postgres password  →  ${HUB_ENV}  mode 0600 (reused on re-run unless --force)
    CA root key        →  ${HUB_CA_ROOT}  never exported, never packed into enroll
    users.json         →  ${HUB_USERS}  mode 0600 (not clobbered on re-run)

EOF
  if [[ "${MEMORY_MODE}" == "full" ]]; then
    cat <<EOF
  memory-full endpoints (written into ${HUB_ENV}, not started here):
    embed:      ${RIVETOS_EMBED_URL:-<required>}  model ${RIVETOS_EMBED_MODEL:-nemotron}
    compaction: ${RIVETOS_COMPACTOR_URL:-<required>}  model ${RIVETOS_COMPACTOR_MODEL:-<required>}

EOF
  fi
  if [[ "${FLAG_FORCE}" -eq 1 ]]; then
    cat <<EOF
  --force: CA will be re-inited and the postgres password rotated. An existing
  cluster that still has the old password will fail to authenticate until you
  ALTER ROLE or wipe the docker volume / bare-metal cluster.

EOF
  fi
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

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

datahub_main() {
  parse_args "$@"
  if [[ "${FLAG_HELP}" -eq 1 ]]; then
    usage
    return 0
  fi
  init_paths
  run_wizard_flow
  init_paths
  if can_prompt; then
    print_summary
  fi
  confirm_or_die
  preflight
  ensure_layout

  # Serialize re-runs against each other. Timeout so a stale lock is not silent.
  exec 9>"${HUB_ROOT}/.install.lock"
  if ! flock -w 60 9; then
    err "another datahub install holds ${HUB_ROOT}/.install.lock (waited 60s). If no installer is running, remove the lock file and re-run."
  fi

  local pass
  pass="$(reuse_or_create_password)"
  if [[ "${FLAG_FORCE}" -eq 1 ]] || [[ ! -f "${HUB_ENV}" ]] || [[ -z "$(env_get PGPASSWORD || true)" ]]; then
    write_datahub_env "${pass}"
  else
    log "leaving existing ${HUB_ENV} in place"
  fi
  # Forget the local copy; everything else reads datahub.env.
  pass=""

  install_hub_helper
  install_postgres
  apply_migrations
  run_ca_init
  write_users_json "${OWNER_ID}"
  if [[ "${MEMORY_MODE}" == "full" ]]; then
    configure_memory_full
  fi
  print_banner
}

# Run main when executed (file or `curl | bash`), not when sourced. Do not
# use BASH_SOURCE==$0 — under bash -s they differ and the installer would
# silently exit 0.
if ! (return 0 2>/dev/null); then
  datahub_main "$@"
fi
