#!/usr/bin/env bash
# rivetos-onboard-persist — write mode (+ DataHub / cloud URL) to ~/.rivetos/.env
#
# Reads values from the current environment (plugin vars or the onboard
# skill). Never prints secrets, PG URLs, or tokens.
#
# Does not clobber RIVETOS_MODE=workspace|production (boot/CLI local-dev).
# Parses the existing file with the same rules as packages/cli (export
# prefix, quotes, last-wins, BOM). Encodes so bash source, this parser,
# and the CLI recover the same bytes. Writes through a symlink.
# Unsubstituted ${VAR} and newline values refuse the write (rc 2).
set -euo pipefail

case "$-" in
  *x*) set +x ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
_rivet_paths=""
for _rivet_candidate in \
  "$SCRIPT_DIR/../../../shared/rivet-paths.sh" \
  "${RIVETOS_ROOT:-/opt/rivetos}/integrations/shared/rivet-paths.sh"; do
  if [ -f "$_rivet_candidate" ]; then
    _rivet_paths="$_rivet_candidate"
    break
  fi
done
if [ -z "$_rivet_paths" ]; then
  echo "rivetos-onboard-persist: rivet-paths.sh not found" >&2
  exit 1
fi
# shellcheck source=../../../shared/rivet-paths.sh
. "$_rivet_paths"
unset _rivet_paths _rivet_candidate

ENV_FILE="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
MODE="${RIVETOS_MODE:-}"

if [ "$MODE" != "cloud" ] && [ "$MODE" != "local" ]; then
  echo "rivetos-onboard-persist: RIVETOS_MODE must be cloud or local" >&2
  exit 2
fi

if [ "$MODE" = "local" ] && rivetos_is_effective_unset "${RIVETOS_DATAHUB_URL:-}" && rivetos_is_effective_unset "${RIVETOS_PG_URL:-}"; then
  echo "rivetos-onboard-persist: local mode needs RIVETOS_DATAHUB_URL or RIVETOS_PG_URL" >&2
  exit 2
fi

_refuse() {
  echo "rivetos-onboard-persist: $1" >&2
  exit 2
}

_encode_or_refuse() {
  local key="$1"
  local val="$2"
  local enc
  if ! enc="$(rivetos_encode_env_value "$val")"; then
    if rivetos_is_effective_unset "$val" && [ -n "$val" ]; then
      _refuse "refusing unsubstituted placeholder for $key (file not written)"
    fi
    _refuse "refusing value with newline or NUL for $key (file not written)"
  fi
  printf '%s' "$enc"
}

mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -e "$ENV_FILE" ]; then
  umask 077
  : >"$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

_rivetos_install_env() {
  local tmp="$1"
  chmod 600 "$tmp"
  if [ -L "$ENV_FILE" ]; then
    cat "$tmp" >"$ENV_FILE"
    rm -f "$tmp"
  else
    mv -f "$tmp" "$ENV_FILE"
  fi
}

upsert_encoded() {
  local key="$1"
  local encoded="$2"
  local tmp line replaced prefix
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  replaced=0
  while IFS= read -r line || [ -n "$line" ]; do
    if rivetos_parse_env_line "$line" && [ "$_rivetos_env_key" = "$key" ]; then
      if [ "$replaced" -eq 0 ]; then
        prefix=""
        if [[ "$line" =~ ^[[:space:]]*export[[:space:]] ]]; then
          prefix="export "
        fi
        printf '%s%s=%s\n' "$prefix" "$key" "$encoded"
        replaced=1
      fi
      continue
    fi
    printf '%s\n' "$line"
  done <"$ENV_FILE" >"$tmp"
  if [ "$replaced" -eq 0 ]; then
    printf '%s=%s\n' "$key" "$encoded" >>"$tmp"
  fi
  _rivetos_install_env "$tmp"
}

mode_ambiguous=0
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *RIVETOS_MODE*)
        if rivetos_has_non_ascii "$line"; then
          mode_ambiguous=1
          break
        fi
        ;;
    esac
  done <"$ENV_FILE"
fi

want_mode=0
enc_mode=""
if [ "$mode_ambiguous" -eq 1 ]; then
  echo "rivetos-onboard-persist: left RIVETOS_MODE (line is ambiguous); plugin mode stays in process env" >&2
else
  existing_mode="$(rivetos_env_file_value "$ENV_FILE" RIVETOS_MODE)"
  case "$existing_mode" in
    workspace | production)
      echo "rivetos-onboard-persist: left RIVETOS_MODE=$existing_mode (boot/CLI); plugin mode stays in process env" >&2
      ;;
    *)
      want_mode=1
      enc_mode="$(_encode_or_refuse RIVETOS_MODE "$MODE")"
      ;;
  esac
fi

enc_cloud=""
enc_datahub=""
enc_token=""
enc_pg=""
if [ -n "${RIVETOS_CLOUD_URL:-}" ]; then
  enc_cloud="$(_encode_or_refuse RIVETOS_CLOUD_URL "$RIVETOS_CLOUD_URL")"
fi
if [ -n "${RIVETOS_DATAHUB_URL:-}" ]; then
  enc_datahub="$(_encode_or_refuse RIVETOS_DATAHUB_URL "$RIVETOS_DATAHUB_URL")"
fi
if [ -n "${RIVETOS_CLOUD_TOKEN:-}" ]; then
  enc_token="$(_encode_or_refuse RIVETOS_CLOUD_TOKEN "$RIVETOS_CLOUD_TOKEN")"
fi
if [ -n "${RIVETOS_PG_URL:-}" ]; then
  enc_pg="$(_encode_or_refuse RIVETOS_PG_URL "$RIVETOS_PG_URL")"
fi

if [ "$want_mode" -eq 1 ]; then
  upsert_encoded RIVETOS_MODE "$enc_mode"
fi
if [ -n "$enc_cloud" ]; then
  upsert_encoded RIVETOS_CLOUD_URL "$enc_cloud"
fi
if [ -n "$enc_datahub" ]; then
  upsert_encoded RIVETOS_DATAHUB_URL "$enc_datahub"
fi
if [ -n "$enc_token" ]; then
  upsert_encoded RIVETOS_CLOUD_TOKEN "$enc_token"
fi
if [ -n "$enc_pg" ]; then
  upsert_encoded RIVETOS_PG_URL "$enc_pg"
fi

echo "rivetos-onboard-persist: wrote mode=$MODE to env file (secrets not printed)"
