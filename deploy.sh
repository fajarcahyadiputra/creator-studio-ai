#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-.env.deploy}"
DEPLOY_ENV_PATH="$ROOT_DIR/$DEPLOY_ENV_FILE"

if [[ ! -f "$DEPLOY_ENV_PATH" ]]; then
  cp "$ROOT_DIR/.env.deploy.example" "$DEPLOY_ENV_PATH"
  cat <<EOF
Created $DEPLOY_ENV_FILE from .env.deploy.example.

Edit $DEPLOY_ENV_FILE first, especially:
- APP_BASE_URL
- S3_PUBLIC_ENDPOINT
- POSTGRES_PASSWORD
- MINIO_ROOT_PASSWORD / S3_SECRET_KEY
- SESSION_SECRET / CSRF_SECRET / INTERNAL_SERVICE_TOKEN
- CREDENTIAL_MASTER_KEY_BASE64
- OPENAI_API_KEY

Then rerun: ./deploy.sh
EOF
  exit 1
fi

read_env() {
  local key="$1"
  local default="${2:-}"
  local value
  value="$(grep -E "^${key}=" "$DEPLOY_ENV_PATH" | tail -n 1 | cut -d '=' -f 2- || true)"
  value="${value%$'\r'}"
  value="${value%\"}"
  value="${value#\"}"
  if [[ -z "$value" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$value"
  fi
}

PROJECT_NAME="$(read_env DEPLOY_PROJECT_NAME creator-studio-ai-deploy)"
BUILD_IMAGES="$(read_env DEPLOY_BUILD true)"
PULL_IMAGES="$(read_env DEPLOY_PULL false)"
WAIT_SECONDS="$(read_env DEPLOY_WAIT_SECONDS 180)"
PROFILES="$(read_env DEPLOY_COMPOSE_PROFILES '')"
APP_BASE_URL="$(read_env APP_BASE_URL http://localhost:3000)"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.deploy.yml)
COMPOSE=(docker compose -p "$PROJECT_NAME" --env-file "$DEPLOY_ENV_FILE" "${COMPOSE_FILES[@]}")

if [[ -n "$PROFILES" ]]; then
  IFS=',' read -ra PROFILE_LIST <<< "$PROFILES"
  for profile in "${PROFILE_LIST[@]}"; do
    profile="${profile// /}"
    [[ -n "$profile" ]] && COMPOSE+=(--profile "$profile")
  done
fi

export APP_ENV_FILE="$DEPLOY_ENV_FILE"

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon is not reachable. Start Docker Desktop or your Docker service, then rerun ./deploy.sh."
    exit 1
  fi
}

wait_for_service() {
  local service="$1"
  local deadline=$((SECONDS + WAIT_SECONDS))
  local status

  while (( SECONDS < deadline )); do
    status="$("${COMPOSE[@]}" ps --format json "$service" 2>/dev/null | tr -d '\r' || true)"
    if [[ "$status" == *'"Health":"healthy"'* || "$status" == *'"State":"running"'* ]]; then
      return 0
    fi
    sleep 3
  done

  echo "Timed out waiting for $service."
  "${COMPOSE[@]}" ps "$service" || true
  "${COMPOSE[@]}" logs --tail=120 "$service" || true
  return 1
}

echo "Deploying Creator Studio AI"
echo "Project: $PROJECT_NAME"
echo "Env file: $DEPLOY_ENV_FILE"
echo "Base URL: $APP_BASE_URL"

require_docker

if [[ "$PULL_IMAGES" == "true" ]]; then
  "${COMPOSE[@]}" pull
fi

if [[ "$BUILD_IMAGES" == "true" ]]; then
  "${COMPOSE[@]}" build
fi

"${COMPOSE[@]}" up -d postgres redis minio temporal mailpit
wait_for_service postgres
wait_for_service redis
wait_for_service minio
wait_for_service temporal

"${COMPOSE[@]}" up -d minio-init
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" run --rm seed

"${COMPOSE[@]}" up -d
wait_for_service web-node
wait_for_service ai-media-python-api

"${COMPOSE[@]}" ps

cat <<EOF

Deploy finished.
Open: $APP_BASE_URL

Useful commands:
  docker compose -p "$PROJECT_NAME" --env-file "$DEPLOY_ENV_FILE" -f docker-compose.yml -f docker-compose.deploy.yml ps
  docker compose -p "$PROJECT_NAME" --env-file "$DEPLOY_ENV_FILE" -f docker-compose.yml -f docker-compose.deploy.yml logs -f --tail=200
EOF
