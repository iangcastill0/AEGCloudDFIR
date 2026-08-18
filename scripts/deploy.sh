#!/usr/bin/env bash
#
# Deploy a published image tag on this host. Runs ON THE SERVER, invoked either
# by .github/workflows/deploy.yml over SSH or by hand.
#
# Design notes, all of them lessons from breaking this deployment by hand:
#
# 1. The tag is PERSISTED into .env. Passing it only as a shell variable works
#    for this command and then rots: the next plain `docker compose up -d` would
#    fall back to the compose default and quietly replace the running images.
# 2. Compose always gets --env-file explicitly. Interpolation reads the .env in
#    the CURRENT directory, and running from infra/compose without it silently
#    applied every default — colliding host ports and a placeholder DB password.
# 3. Health is verified through /readyz, which probes Postgres AND object
#    storage. An earlier healthcheck only hit /healthz and reported a healthy
#    container whose storage credentials had never worked.
# 4. Failure rolls back to the tag that was running, because a deploy that
#    leaves the site down is worse than one that does not happen.
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
ENV_FILE="$REPO_ROOT/.env"
SERVICES=(api worker web)

[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found" >&2; exit 1; }

compose() { docker compose --env-file "$ENV_FILE" "$@"; }

# Read one key without sourcing the file: values may contain characters that a
# shell would interpret, and this file holds every production secret.
env_value() {
  local key="$1" line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)"
  printf '%s' "${line#*=}"
}

set_env_value() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  # Preserve mode 0600: this file is every production credential.
  chmod 600 "$tmp"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    grep -vE "^${key}=" "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

API_PORT="$(env_value CDFIR_API_HOST_PORT)"; API_PORT="${API_PORT:-4000}"
WEB_PORT="$(env_value CDFIR_WEB_HOST_PORT)"; WEB_PORT="${WEB_PORT:-3000}"
PREVIOUS_TAG="$(env_value CDFIR_IMAGE_TAG)"

echo "==> deploying $TAG (previous: ${PREVIOUS_TAG:-none recorded})"
if [ "$DRY_RUN" = true ]; then
  echo "    dry run: would pull ${SERVICES[*]} at $TAG and restart them"
  exit 0
fi

cd "$COMPOSE_DIR"

# Free space before pulling. Registry images replaced the on-host build cache,
# but superseded image layers still accumulate one deploy at a time.
docker image prune -f >/dev/null 2>&1 || true

roll_back() {
  if [ -z "$PREVIOUS_TAG" ]; then
    echo "!! no previous tag recorded — CANNOT roll back automatically." >&2
    echo "   the site may be down; deploy a known-good tag by hand." >&2
    return
  fi
  echo "==> rolling back to $PREVIOUS_TAG"
  set_env_value CDFIR_IMAGE_TAG "$PREVIOUS_TAG"
  compose pull "${SERVICES[@]}" || true
  compose up -d "${SERVICES[@]}" || true
}

set_env_value CDFIR_IMAGE_TAG "$TAG"

echo "==> pulling"
if ! compose pull "${SERVICES[@]}"; then
  # Nothing has been replaced yet, so restore the tag and stop. The running
  # containers were never touched.
  echo "error: pull failed — nothing was changed" >&2
  [ -n "$PREVIOUS_TAG" ] && set_env_value CDFIR_IMAGE_TAG "$PREVIOUS_TAG"
  exit 1
fi

echo "==> starting"
if ! compose up -d "${SERVICES[@]}"; then
  echo "error: containers failed to start" >&2
  roll_back
  exit 1
fi

echo "==> waiting for /readyz (database + object storage)"
ready=false
for _ in $(seq 1 60); do
  body="$(curl -fsS -m 5 "http://127.0.0.1:${API_PORT}/readyz" 2>/dev/null || true)"
  case "$body" in
    *'"status":"ok"'*) ready=true; break ;;
  esac
  sleep 2
done

if [ "$ready" != true ]; then
  echo "error: api never became ready. last response: ${body:-<none>}" >&2
  compose logs --tail 40 api >&2 || true
  roll_back
  exit 1
fi

echo "==> checking web"
web_code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/" || true)"
if [ "$web_code" != "200" ]; then
  echo "error: web returned $web_code" >&2
  compose logs --tail 40 web >&2 || true
  roll_back
  exit 1
fi

echo "==> deployed $TAG (api ready, web $web_code)"
