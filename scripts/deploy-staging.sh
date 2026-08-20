#!/usr/bin/env bash
#
# Put an image tag on staging. Runs ON THE SERVER, called by
# .github/workflows/deploy-staging.yml or by hand.
#
# Deliberately simpler than scripts/deploy.sh: staging is expendable. It still
# health-checks and rolls back, because a broken staging teaches you nothing and
# wastes the trip.
#
# The two stacks cannot collide: different compose project (cdfir-staging),
# different env file (.env.staging), different host ports, different database,
# different Redis, different OpenSearch index prefix, different buckets.
set -euo pipefail

usage() {
  echo "usage: $0 <image-tag> [--dry-run]" >&2
  echo "  e.g. $0 sha-1a2b3c4" >&2
  exit 64
}

TAG="${1:-}"
[ -n "$TAG" ] || usage
DRY_RUN=false
[ "${2:-}" = "--dry-run" ] && DRY_RUN=true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_DIR="$REPO_ROOT/infra/compose"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.staging.yml"
ENV_FILE="$REPO_ROOT/.env.staging"
PROJECT="cdfir-staging"
SERVICES=(postgres redis api worker web)

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found. Create it from .env.staging.example first —" >&2
  echo "       see docs/runbooks/staging.md." >&2
  exit 1
fi

compose() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# Read one key without executing the file: it holds staging's secrets, and a
# stray line must not be able to abort a deploy (that already happened once with
# the backup script).
env_value() {
  local key="$1" line value
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)"
  value="${line#*=}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

set_env_value() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  chmod 600 "$tmp"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    grep -vE "^${key}=" "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

API_PORT="$(env_value CDFIR_API_HOST_PORT)"; API_PORT="${API_PORT:-4100}"
WEB_PORT="$(env_value CDFIR_WEB_HOST_PORT)"; WEB_PORT="${WEB_PORT:-3100}"
PREVIOUS_TAG="$(env_value CDFIR_IMAGE_TAG)"

echo "==> staging: deploying $TAG (previous: ${PREVIOUS_TAG:-none recorded})"
if [ "$DRY_RUN" = true ]; then
  echo "    dry run: would pull ${SERVICES[*]} at $TAG and restart them"
  exit 0
fi

cd "$COMPOSE_DIR"
docker image prune -f >/dev/null 2>&1 || true

set_env_value CDFIR_IMAGE_TAG "$TAG"

echo "==> pulling"
if ! compose pull api worker web; then
  echo "error: pull failed — staging untouched" >&2
  [ -n "$PREVIOUS_TAG" ] && set_env_value CDFIR_IMAGE_TAG "$PREVIOUS_TAG"
  exit 1
fi

echo "==> starting"
if ! compose up -d "${SERVICES[@]}"; then
  echo "error: containers failed to start" >&2
  compose logs --tail 40 api >&2 || true
  exit 1
fi

echo "==> waiting for staging /readyz"
ready=false
for _ in $(seq 1 60); do
  body="$(curl -fsS -m 5 "http://127.0.0.1:${API_PORT}/readyz" 2>/dev/null || true)"
  case "$body" in
    *'"status":"ok"'*) ready=true; break ;;
  esac
  sleep 2
done

if [ "$ready" != true ]; then
  echo "error: staging api never became ready. last response: ${body:-<none>}" >&2
  compose logs --tail 40 api >&2 || true
  if [ -n "$PREVIOUS_TAG" ]; then
    echo "==> rolling staging back to $PREVIOUS_TAG"
    set_env_value CDFIR_IMAGE_TAG "$PREVIOUS_TAG"
    compose pull api worker web || true
    compose up -d "${SERVICES[@]}" || true
  fi
  exit 1
fi

web_code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/" || true)"
echo "==> staging deployed $TAG (api ready, web $web_code)"
