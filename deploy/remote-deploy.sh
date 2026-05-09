#!/usr/bin/env bash
set -euo pipefail

section() { printf '\n== %s ==\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

APP_DIR="${APP_DIR:-/opt/jarvis-freightops}"
COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH:-${APP_DIR}/compose.yaml}"
SYSTEM_ENV_FILE="${SYSTEM_ENV_FILE:-${APP_DIR}/deploy/system.env.local}"
APP_ENV_FILE="${APP_ENV_FILE:-${APP_DIR}/.env}"
IMAGE_REF="${IMAGE_REF:-}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:3011/api/health}"
HEALTHCHECK_TIMEOUT_SECONDS="${HEALTHCHECK_TIMEOUT_SECONDS:-90}"
GHCR_USERNAME="${GHCR_USERNAME:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"

[[ -n "$IMAGE_REF" ]] || fail 'IMAGE_REF is required.'
[[ -f "$COMPOSE_FILE_PATH" ]] || fail "Missing compose file: $COMPOSE_FILE_PATH"
[[ -f "$SYSTEM_ENV_FILE" ]] || fail "Missing system env file: $SYSTEM_ENV_FILE"
[[ -f "$APP_ENV_FILE" ]] || fail "Missing app env file: $APP_ENV_FILE"

if [[ -n "$GHCR_USERNAME" && -n "$GHCR_TOKEN" ]]; then
  section 'Logging into GHCR'
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin >/dev/null
fi

section 'Pull image'
IMAGE_REF="$IMAGE_REF" APP_ENV_FILE="$APP_ENV_FILE" \
  docker compose --env-file "$SYSTEM_ENV_FILE" -f "$COMPOSE_FILE_PATH" pull app

section 'Restart service'
IMAGE_REF="$IMAGE_REF" APP_ENV_FILE="$APP_ENV_FILE" \
  docker compose --env-file "$SYSTEM_ENV_FILE" -f "$COMPOSE_FILE_PATH" up -d --remove-orphans app

section 'Health check'
deadline=$((SECONDS + HEALTHCHECK_TIMEOUT_SECONDS))
until curl -fsS "$HEALTHCHECK_URL" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    fail "Timed out waiting for health at $HEALTHCHECK_URL"
  fi
  sleep 2
done

curl -fsS "$HEALTHCHECK_URL"
