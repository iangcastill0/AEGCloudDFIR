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
#
# It runs the SAME migrate step as production, pointed at staging's database, and
# for the same reason: staging is where a migration gets to fail. A staging deploy
# that skips the schema reproduces the production outage here and teaches nothing,
# because the symptom (403 everywhere, "no tenant selected") looks like a bug in
# the code that shipped.
set -euo pipefail

usage() {
  echo "usage: $0 <image-tag> [--dry-run] [--skip-backup-check]" >&2
  echo "  e.g. $0 sha-1a2b3c4" >&2
  exit 64
}

TAG="${1:-}"
[ -n "$TAG" ] || usage
case "$TAG" in -*) usage ;; esac
shift

DRY_RUN=false
SKIP_BACKUP_CHECK=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --skip-backup-check) SKIP_BACKUP_CHECK=true ;;
    *) echo "error: unknown option $1" >&2; usage ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_DIR="$REPO_ROOT/infra/compose"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.staging.yml"
ENV_FILE="$REPO_ROOT/.env.staging"
PROJECT="cdfir-staging"
SERVICES=(postgres-staging redis-staging opensearch-staging tika-staging crush-parser-staging api-staging worker-staging web-staging)

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

# --expendable-database, not --skip-backup-check: staging has no backup and is
# not meant to have one (scripts/backup-postgres.sh dumps PRODUCTION). Using the
# emergency override here would print an emergency warning on every staging
# deploy, and a warning an operator sees every day is one they stop reading.
MIGRATE_ARGS=(
  --env-file "$ENV_FILE"
  --compose-file "$COMPOSE_FILE"
  --project "$PROJECT"
  --api-service api-staging
  --db-service postgres-staging
  --expendable-database
)
[ "$SKIP_BACKUP_CHECK" = true ] && MIGRATE_ARGS+=(--skip-backup-check)

cd "$COMPOSE_DIR"

if [ "$DRY_RUN" = true ]; then
  echo "    dry run: would pull ${SERVICES[*]} at $TAG and restart them"
  echo "    dry run: asking staging's database what the schema would need."
  "$REPO_ROOT/scripts/migrate.sh" "$TAG" "${MIGRATE_ARGS[@]}" --status
  exit 0
fi

docker image prune -f >/dev/null 2>&1 || true

set_env_value CDFIR_IMAGE_TAG "$TAG"

echo "==> pulling"
if ! compose pull crush-parser-staging api-staging worker-staging web-staging; then
  echo "error: pull failed — staging untouched" >&2
  [ -n "$PREVIOUS_TAG" ] && set_env_value CDFIR_IMAGE_TAG "$PREVIOUS_TAG"
  exit 1
fi

# SCHEMA BEFORE CODE, for the same reason as production: new code that reads a
# column the database does not have answers 403 on every route. A failure here
# restarts nothing — the old staging code keeps serving the old staging schema.
echo "==> database migrations (before any new code serves traffic)"
if ! "$REPO_ROOT/scripts/migrate.sh" "$TAG" "${MIGRATE_ARGS[@]}"; then
  echo "error: staging migrations did not apply — NOTHING was restarted." >&2
  [ -n "$PREVIOUS_TAG" ] && set_env_value CDFIR_IMAGE_TAG "$PREVIOUS_TAG"
  exit 1
fi

echo "==> applying staging database migrations as cdfir_migrator"
if ! compose run --rm --no-deps api-staging sh -lc \
  'cd /app && node_modules/.bin/prisma migrate deploy --schema packages/database/prisma/schema.prisma'; then
  echo "error: staging migration failed — application containers were not changed" >&2
  [ -n "$PREVIOUS_TAG" ] && set_env_value CDFIR_IMAGE_TAG "$PREVIOUS_TAG"
  exit 1
fi

echo "==> starting"
if ! compose up -d --remove-orphans "${SERVICES[@]}"; then
  echo "error: containers failed to start" >&2
  compose logs --tail 40 api-staging >&2 || true
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
  compose logs --tail 40 api-staging >&2 || true
  if [ -n "$PREVIOUS_TAG" ]; then
    echo "==> rolling staging back to $PREVIOUS_TAG"
    set_env_value CDFIR_IMAGE_TAG "$PREVIOUS_TAG"
    compose pull crush-parser-staging api-staging worker-staging web-staging || true
    compose up -d "${SERVICES[@]}" || true
  fi
  exit 1
fi

web_code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/" || true)"
# Reclaim old image tags now that the new ones are proven healthy.
#
# Why this exists: this host is shared by staging and production on a 98 GB
# disk, and each deploy pulls three images (~3.7 GB). Roughly ten deploys in one
# day filled it to 100%, which panicked PostgreSQL mid-checkpoint and then
# blocked its crash recovery, because replaying WAL also needs space. The
# monitor had been failing on 96% for five hours and nobody was watching, so the
# fix has to run where the images are created, not where the alert is read.
#
# Why a COUNT and not an age filter: the obvious `--filter until=72h` was
# measured against this host and would have removed nothing at all, while 18 GB
# of dead tags sat there — every one of them pulled that same day. Deploy
# frequency, not age, is what piles them up.
#
# Safety, in order of importance:
#  - only ever considers this project's own repositories, so a shared image like
#    postgres or opensearch can never be selected, whatever its state
#  - never touches an image any container references, running or exited
#  - keeps the newest KEEP_PER_REPO tags per repository, so a manual rollback
#    later still has somewhere to go
#  - failures are logged and ignored: a full disk is bad, but a deploy that
#    reports failure after the new version is already serving is worse
#
# Set PRUNE_DRY_RUN=1 to print the selection without deleting.
KEEP_PER_REPO="${KEEP_PER_REPO:-3}"

prune_old_images() {
  echo "==> pruning old image tags (keeping $KEEP_PER_REPO per repository)"

  local in_use
  in_use="$(docker ps -a --format '{{.Image}}' | sort -u)"

  local repos
  repos="$(docker images --format '{{.Repository}}' | grep '/aegclouddfir/' | sort -u || true)"

  local removed=0
  local repo image kept
  for repo in $repos; do
    kept=0
    # Newest first, so the survivors are the most recent tags.
    while read -r image; do
      [ -n "$image" ] || continue
      case "$image" in *:'<none>') continue ;; esac

      if printf '%s\n' "$in_use" | grep -qxF "$image"; then
        continue                      # a container references it; not ours to remove
      fi
      # Prefix match, not equality: staging's web image is tagged
      # "<sha>-staging", so "$repo:$PREVIOUS_TAG" alone silently fails to
      # protect the one image a rollback would need most.
      case "$image" in
        "$repo:$TAG" | "$repo:$TAG"-*) continue ;;
      esac
      if [ -n "${PREVIOUS_TAG:-}" ]; then
        case "$image" in
          "$repo:$PREVIOUS_TAG" | "$repo:$PREVIOUS_TAG"-*) continue ;;
        esac
      fi

      kept=$((kept + 1))
      if [ "$kept" -le "$KEEP_PER_REPO" ]; then
        continue
      fi

      if [ "${PRUNE_DRY_RUN:-0}" = "1" ]; then
        echo "    would remove $image"
      else
        docker rmi "$image" >/dev/null 2>&1 && removed=$((removed + 1)) || \
          echo "    warning: could not remove $image" >&2
      fi
    done <<EOF
$(docker images "$repo" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null)
EOF
  done

  # Layers left behind by removed tags.
  if [ "${PRUNE_DRY_RUN:-0}" != "1" ]; then
    docker image prune -f >/dev/null 2>&1 || true
    echo "    removed $removed image tag(s)"
  fi
  df -h / | tail -1
}

prune_old_images

echo "==> staging deployed $TAG (api ready, web $web_code)"
