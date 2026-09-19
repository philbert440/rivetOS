#!/usr/bin/env bash
# rivetos-onboard-persist — write mode (+ DataHub / cloud URL) to ~/.rivetos/.env
#
# Reads values from the current environment (plugin vars or the onboard
# skill). Never prints secrets, PG URLs, or tokens.
#
# Does not clobber RIVETOS_MODE=workspace|production (boot/CLI local-dev).
# Parses the existing file with the same rules as packages/cli (export
# prefix, quotes, last-wins). Writes single-quoted values. Writes through
# a symlink instead of replacing it with a regular file.
set -euo pipefail

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

upsert() {
  local key="$1"
  local val="$2"
  local tmp quoted line replaced prefix
  if rivetos_is_effective_unset "$val"; then
    return 0
  fi
  case "$val" in
    *$'\n'*)
      echo "rivetos-onboard-persist: $key value must be a single line" >&2
      exit 2
      ;;
  esac
  quoted="$(rivetos_quote_env_value "$val")"
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  replaced=0
  while IFS= read -r line || [ -n "$line" ]; do
    if rivetos_parse_env_line "$line" && [ "$_rivetos_env_key" = "$key" ]; then
      if [ "$replaced" -eq 0 ]; then
        prefix=""
        if [[ "$line" =~ ^[[:space:]]*export[[:space:]] ]]; then
          prefix="export "
        fi
        printf '%s%s=%s\n' "$prefix" "$key" "$quoted"
        replaced=1
      fi
      continue
    fi
    printf '%s\n' "$line"
  done <"$ENV_FILE" >"$tmp"
  if [ "$replaced" -eq 0 ]; then
    printf '%s=%s\n' "$key" "$quoted" >>"$tmp"
  fi
  _rivetos_install_env "$tmp"
}

existing_mode="$(rivetos_env_file_value "$ENV_FILE" RIVETOS_MODE)"
case "$existing_mode" in
  workspace | production)
    echo "rivetos-onboard-persist: left RIVETOS_MODE=$existing_mode (boot/CLI); plugin mode stays in process env" >&2
    ;;
  *)
    upsert RIVETOS_MODE "$MODE"
    ;;
esac

if ! rivetos_is_effective_unset "${RIVETOS_CLOUD_URL:-}"; then
  upsert RIVETOS_CLOUD_URL "$RIVETOS_CLOUD_URL"
fi
if ! rivetos_is_effective_unset "${RIVETOS_DATAHUB_URL:-}"; then
  upsert RIVETOS_DATAHUB_URL "$RIVETOS_DATAHUB_URL"
fi
# Token / PG URL: persist only when already in env (user or plugin form set them).
# Still never print the values.
if ! rivetos_is_effective_unset "${RIVETOS_CLOUD_TOKEN:-}"; then
  upsert RIVETOS_CLOUD_TOKEN "$RIVETOS_CLOUD_TOKEN"
fi
if ! rivetos_is_effective_unset "${RIVETOS_PG_URL:-}"; then
  upsert RIVETOS_PG_URL "$RIVETOS_PG_URL"
fi

echo "rivetos-onboard-persist: wrote mode=$MODE to env file (secrets not printed)"
