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
# 5. MIGRATIONS RUN BEFORE ANY NEW CODE SERVES TRAFFIC, and a migration that
#    fails stops the deploy dead — see the migrate block below. Nothing in this
#    application migrates itself; a deploy that skipped this answered 403 on
#    every route for twenty minutes on 2026-09-24. Read scripts/migrate.sh for
#    the rollback hazard that comes with it, because point 4 cannot fix it.
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
ENV_FILE="$REPO_ROOT/.env"
SERVICES=(crush-parser api worker web)

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

# Settings for the migrate step. Production's are the script's own defaults, but
# they are spelled out so a reader of this file can see which database is about
# to be changed without opening another one.
MIGRATE_ARGS=(
  --env-file "$ENV_FILE"
  --compose-file "$COMPOSE_DIR/docker-compose.yml"
  --project cdfir
  --api-service api
  --db-service postgres
)
[ "$SKIP_BACKUP_CHECK" = true ] && MIGRATE_ARGS+=(--skip-backup-check)

cd "$COMPOSE_DIR"

if [ "$DRY_RUN" = true ]; then
  echo "    dry run: would pull ${SERVICES[*]} at $TAG and restart them"
  echo "    dry run: asking the database what the schema would need. It pulls the"
  echo "             api image to read the new migration files; nothing that is"
  echo "             running changes, and no file on this host is written."
  # Exit code propagated on purpose. A dry run that discovers a blocker — a
  # migration already recorded as failed, a stale backup — has to go red, or the
  # green tick teaches the operator that the preview means nothing.
  "$REPO_ROOT/scripts/migrate.sh" "$TAG" "${MIGRATE_ARGS[@]}" --status
  exit 0
fi

# Free space before pulling. Registry images replaced the on-host build cache,
# but superseded image layers still accumulate one deploy at a time.
docker image prune -f >/dev/null 2>&1 || true

# Put the health checker where host cron can run it.
#
# It HAS to run on the host. Three of its six checks are host facts — `df -h /`,
# `docker ps`, `docker system df`. The same code inside a container measures the
# container's own nearly-empty filesystem and reports "4% used" every five
# minutes while the real disk fills. That is worse than no monitor, and it is the
# outage this repo already had: 96% for five hours, then PostgreSQL crashed and
# could not restart, because replaying its log also needed space.
#
# The host has no pnpm, so CI builds it into the api image (infra/docker/
# api.Dockerfile) and this lifts it out. `docker create` makes a container
# without starting one, purely so `docker cp` has something to copy from.
#
# Production only. Staging shares this checkout, so letting a staging deploy
# write here would let an older commit quietly downgrade the checker that watches
# production.
#
# A failure is reported and does NOT stop the deploy: a checker one version
# behind is a smaller problem than refusing to ship a fix. It is not silent
# either — the line below names the image it came from, and the checker keeps
# pinging, so nothing turns off.
ship_health_checker() {
  local image cid dest copied
  dest="$REPO_ROOT/packages/monitoring/dist"

  # Match the api repository by NAME, never by position. `config --images api`
  # also prints the dependency images, and the order is not stable: two runs
  # against this compose file put redis:7-alpine first and then api first. A
  # `head -1` here would copy the checker out of redis some of the time, which is
  # worse than always — it would look like it worked.
  image="$(compose config --images api 2>/dev/null | grep -m1 '/aegclouddfir/api:' || true)"
  if [ -z "$image" ]; then
    echo "!! could not resolve the api image — health checker NOT updated" >&2
    return 1
  fi

  if ! cid="$(docker create "$image" 2>/dev/null)"; then
    echo "!! docker create $image failed — health checker NOT updated" >&2
    return 1
  fi

  mkdir -p "$dest"
  copied=true
  docker cp "$cid:/app/packages/monitoring/dist/." "$dest/" >/dev/null 2>&1 || copied=false
  docker rm -v "$cid" >/dev/null 2>&1 || true

  if [ "$copied" != true ] || [ ! -f "$dest/cli.js" ]; then
    echo "!! could not copy the health checker out of $image — it is now STALE" >&2
    echo "   cron keeps running the previous one; see docs/runbooks/monitoring.md" >&2
    return 1
  fi
  echo "    health checker installed from $image"
}

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

# After the pull, so the new image is local, and before anything is replaced, so
# a problem here is reported while the running containers are still untouched.
echo "==> installing the host health checker"
ship_health_checker || true

# SCHEMA BEFORE CODE. This is the whole lesson of 2026-09-24: new code that reads
# a column the database does not have takes down every route, and the only thing
# wrong is the order.
#
# A failure here exits WITHOUT restarting anything. Leaving the old code running
# against the old schema is the safe direction; the alternative is a half-changed
# schema with new code on top of it, which is the outage.
#
# roll_back() is deliberately NOT called. There is nothing to roll back — no
# container was replaced — and calling it would pull and restart containers to
# "recover" from a state where they were never touched.
echo "==> database migrations (before any new code serves traffic)"
if ! "$REPO_ROOT/scripts/migrate.sh" "$TAG" "${MIGRATE_ARGS[@]}"; then
  echo "error: migrations did not apply — NOTHING was restarted." >&2
  echo "   $PREVIOUS_TAG is still serving, against the schema it was written for." >&2
  [ -n "$PREVIOUS_TAG" ] && set_env_value CDFIR_IMAGE_TAG "$PREVIOUS_TAG"
  exit 1
fi

echo "==> applying database migrations as cdfir_migrator"
if ! compose run --rm --no-deps api sh -lc \
  'cd /app && node_modules/.bin/prisma migrate deploy --schema packages/database/prisma/schema.prisma'; then
  echo "error: database migration failed — application containers were not changed" >&2
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

echo "==> deployed $TAG (api ready, web $web_code)"
