#!/usr/bin/env bash
# rivetos-onboard-persist — write mode (+ DataHub / cloud URL) to ~/.rivetos/.env
#
# Reads values from the current environment (plugin vars or the onboard
# skill). Never prints secrets, PG URLs, or tokens.
#
# Does not clobber RIVETOS_MODE=workspace|production (boot/CLI local-dev).
set -euo pipefail

ENV_FILE="${RIVETOS_ENV_FILE:-$HOME/.rivetos/.env}"
MODE="${RIVETOS_MODE:-}"

if [ "$MODE" != "cloud" ] && [ "$MODE" != "local" ]; then
  echo "rivetos-onboard-persist: RIVETOS_MODE must be cloud or local" >&2
  exit 2
fi

if [ "$MODE" = "local" ] && [ -z "${RIVETOS_DATAHUB_URL:-}" ] && [ -z "${RIVETOS_PG_URL:-}" ]; then
  echo "rivetos-onboard-persist: local mode needs RIVETOS_DATAHUB_URL or RIVETOS_PG_URL" >&2
  exit 2
fi

mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  : >"$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

upsert() {
  local key="$1"
  local val="$2"
  local tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    awk -v k="$key" -v v="$val" '
      BEGIN { done=0 }
      $0 ~ "^" k "=" { print k "=" v; done=1; next }
      { print }
      END { if (!done) print k "=" v }
    ' "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"
    printf '%s=%s\n' "$key" "$val" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

existing_mode=""
if [ -f "$ENV_FILE" ]; then
  existing_mode="$(awk -F= '$1=="RIVETOS_MODE" { sub(/^[^=]+=/, ""); print; exit }' "$ENV_FILE" || true)"
fi
case "$existing_mode" in
  workspace | production)
    echo "rivetos-onboard-persist: left RIVETOS_MODE=$existing_mode (boot/CLI); plugin mode stays in process env" >&2
    ;;
  *)
    upsert RIVETOS_MODE "$MODE"
    ;;
esac

if [ -n "${RIVETOS_CLOUD_URL:-}" ]; then
  upsert RIVETOS_CLOUD_URL "$RIVETOS_CLOUD_URL"
fi
if [ -n "${RIVETOS_DATAHUB_URL:-}" ]; then
  upsert RIVETOS_DATAHUB_URL "$RIVETOS_DATAHUB_URL"
fi
# Token / PG URL: persist only when already in env (user or plugin form set them).
# Still never print the values.
if [ -n "${RIVETOS_CLOUD_TOKEN:-}" ]; then
  upsert RIVETOS_CLOUD_TOKEN "$RIVETOS_CLOUD_TOKEN"
fi
if [ -n "${RIVETOS_PG_URL:-}" ]; then
  upsert RIVETOS_PG_URL "$RIVETOS_PG_URL"
fi

echo "rivetos-onboard-persist: wrote mode=$MODE to env file (secrets not printed)"
