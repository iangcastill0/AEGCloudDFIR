#!/usr/bin/env bash
#
# Apply pending database migrations BEFORE the new code starts serving.
#
#   ./scripts/migrate.sh sha-1a2b3c4 --status    # what WOULD be applied
#   ./scripts/migrate.sh sha-1a2b3c4             # apply it
#
# Called by scripts/deploy.sh and scripts/deploy-staging.sh between the image
# pull and the container restart. Safe to run by hand; it is idempotent.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
#
# On 2026-09-24 a deploy shipped code that read tenants.billingStatus while five
# migrations sat unapplied. prisma.membership.findMany() threw, so no tenant ever
# came back, so TenantGuard answered 403 on every route. The product showed "no
# tenant selected" and could not be used. Nothing was broken except the order in
# which two things happened.
#
# Nothing in this application migrates itself. The worker does not (its boot log
# goes straight from "worker starting" to "queue workers started"), and an
# earlier version of docs/runbooks/deploy.md wrongly said it did.
#
# ---------------------------------------------------------------------------
# WHY IT RUNS IN A ONE-OFF CONTAINER MADE FROM THE api IMAGE
#
# The host cannot run prisma. It has no pnpm and no node_modules, and building
# there is what filled the disk once already.
#
# The api image already carries both halves: packages/database/prisma/migrations
# (COPY packages ./packages) and the CLI at
# packages/database/node_modules/.bin/prisma, because prisma is a devDependency
# of @aeg-clouddfir/database and `pnpm install --filter @aeg-clouddfir/api...`
# installs it. docs/runbooks/staging.md has been using that exact path by hand.
#
# So: no new image, and no bytes added to any existing one. A separate migrate
# image was the alternative and it is worse — a second artifact to build, push,
# pull, prune and keep in step with the schema it applies. That is the same trade
# api.Dockerfile already made when it carried the host health checker as a
# passenger rather than giving it an image.
#
# It must be a ONE-OFF container from the PULLED image, never `docker exec` into
# the running api. The running api is the OLD image, so exec'ing into it applies
# YESTERDAY'S migrations and reports success. That failure would look exactly
# like this working.
#
# ---------------------------------------------------------------------------
# WHAT THIS SCRIPT CANNOT DO: ROLL BACK
#
# Read this before writing a migration that drops or renames anything.
#
# scripts/deploy.sh rolls the CODE back to the previous image tag when a health
# check fails. Migrations do not roll back, and this script does not try to.
# So a deploy that migrates successfully and then fails its health check leaves
# the NEW schema with the OLD code on top of it.
#
#   additive migration (add a column, add a table, add an enum value)
#     -> the old code does not know the new column and never selects it. The
#        rollback is genuinely safe.
#
#   destructive migration (drop a column, rename a column, narrow a type,
#   add a NOT NULL without a default)
#     -> the old code still selects the old name. The rollback puts the site
#        back into exactly the outage it was rolling back from.
#
# An automatic rollback cannot fix that, and pretending otherwise is worse than
# saying so. For a destructive change the operator must deploy in two releases:
# first a release that stops using the column, then a later release that drops
# it. docs/runbooks/deploy.md spells this out under "The rollback hazard".
# ---------------------------------------------------------------------------
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: scripts/migrate.sh <image-tag> [options]

  --status               report what would be applied and stop. Changes nothing.
  --skip-backup-check    apply even when the last verified backup is stale.
                         For an emergency on a database that matters. It says so,
                         loudly, in the log.
  --expendable-database  this database has no backup and is not meant to have one
                         (staging). Skips the backup guard, quietly, because
                         there is nothing for it to check.
  --env-file PATH        default .env
  --compose-file PATH    default infra/compose/docker-compose.yml
  --project NAME         default cdfir
  --api-service NAME     default api          (the service whose image has prisma)
  --db-service NAME      default postgres     (started first, so the DB is up)

exit codes
  0   nothing pending, or applied and verified, or --status reported
  1   the migration itself failed. Nothing was restarted.
  70  refused before touching the schema (stale backup, failed migration
      already recorded, or a status this script could not read).
USAGE
  exit 64
}

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

TAG="${1:-}"
[ -n "$TAG" ] || usage
case "$TAG" in -*) usage ;; esac
shift

MODE=apply
SKIP_BACKUP_CHECK=false
EXPENDABLE=false
ENV_FILE="$REPO_ROOT/.env"
COMPOSE_FILE="$REPO_ROOT/infra/compose/docker-compose.yml"
PROJECT=cdfir
API_SERVICE=api
DB_SERVICE=postgres

while [ $# -gt 0 ]; do
  case "$1" in
    --status) MODE=status ;;
    --skip-backup-check) SKIP_BACKUP_CHECK=true ;;
    --expendable-database) EXPENDABLE=true ;;
    --env-file) ENV_FILE="${2:-}"; shift ;;
    --compose-file) COMPOSE_FILE="${2:-}"; shift ;;
    --project) PROJECT="${2:-}"; shift ;;
    --api-service) API_SERVICE="${2:-}"; shift ;;
    --db-service) DB_SERVICE="${2:-}"; shift ;;
    *) echo "error: unknown option $1" >&2; usage ;;
  esac
  shift
done

# Refused a precondition. Deliberately distinct from 1: the schema was not
# touched, so the old code is still correct for the schema it faces.
EXIT_REFUSED=70

[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found" >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "error: $COMPOSE_FILE not found" >&2; exit 1; }

# How old a verified backup may be before this refuses to change the schema.
#
# 30 hours, which is the SAME number packages/monitoring uses for its backup
# check (BACKUP_MAX_AGE_HOURS). Backups run 03:15 UTC daily, so consecutive runs
# are ~24h apart and 30h absorbs ordinary drift. Two different numbers would mean
# a deploy can be refused while the monitor reports backups healthy, and an
# operator who cannot reconcile two thresholds stops believing either. A test in
# packages/monitoring/src/deploy-migrate.test.ts fails if they drift apart.
#
# Not readable from the environment, on purpose. The only way past it is
# --skip-backup-check, which prints a line naming itself. A threshold that can be
# widened quietly in one .env is not a guard.
BACKUP_MAX_AGE_HOURS=30

# The same stamp scripts/backup-postgres.sh writes and packages/monitoring reads,
# honouring the same override. It is written ONLY after the uploaded dump has been
# re-read and re-hashed, so a fresh stamp means a backup that actually exists.
STAMP_FILE="${CDFIR_BACKUP_STAMP_FILE:-$REPO_ROOT/.last-backup}"

# Compose, with the tag being deployed forced into interpolation.
#
# The shell environment beats --env-file in Compose, so this resolves the NEW
# image whether or not the caller has written the tag into .env yet. That is what
# lets --status answer "what WOULD be applied" while changing nothing on disk.
compose() {
  CDFIR_IMAGE_TAG="$TAG" docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# Run one prisma migrate subcommand in a one-off container from the pulled image.
#
# --no-deps because the database is started explicitly below; nothing else may be
# started by a schema change. --name because the api service in the staging
# compose file sets container_name, and a one-off container must not collide with
# the running one. No --service-ports, so this never binds the api's host port.
#
# The path is the one docs/runbooks/staging.md has been using by hand. Matching a
# command already known to work on this host is worth more than a tidier one.
run_prisma() {
  local subcommand="$1"
  compose run --rm --no-deps -T --name "cdfir-migrate-$subcommand-$$" "$API_SERVICE" \
    sh -c "cd /app/packages/database && ./node_modules/.bin/prisma migrate $subcommand" 2>&1
}

# Seconds since the epoch for a stamp like 2026-09-24T19:20:05Z.
#
# GNU date first (the servers are Ubuntu), then BSD date (so the test suite is
# real on the operator's Mac). Prints nothing if neither can read it, and the
# caller treats that as no backup — the monitor makes the same choice.
stamp_epoch() {
  local stamp="$1"
  date -u -d "$stamp" +%s 2>/dev/null ||
    date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$stamp" +%s 2>/dev/null ||
    true
}

# Refuse to change the schema without a recent verified backup.
#
# Today's outage happened on a database that did have one, and that was luck. A
# migration is the one deploy step that cannot be undone by redeploying, so it is
# the one step that needs a known-good copy behind it.
#
# Called ONLY when there is something to apply. A code-only deploy is never
# blocked by a stale stamp, which is the whole reason this guard will still be in
# place in six months: a check that fires on every deploy gets routed around.
backup_is_recent_enough() {
  local raw when now age

  if [ ! -f "$STAMP_FILE" ]; then
    echo "!! no verified backup found: $STAMP_FILE does not exist" >&2
    return 1
  fi

  raw="$(tr -d '[:space:]' < "$STAMP_FILE")"
  when="$(stamp_epoch "$raw")"
  if [ -z "$when" ]; then
    echo "!! cannot read the backup stamp in $STAMP_FILE (got '${raw}')" >&2
    return 1
  fi

  now="$(date -u +%s)"
  age=$(((now - when) / 3600))
  if [ "$age" -gt "$BACKUP_MAX_AGE_HOURS" ]; then
    echo "!! the newest verified backup is ${age}h old (${raw}); the limit is ${BACKUP_MAX_AGE_HOURS}h" >&2
    return 1
  fi

  echo "    last verified backup: ${raw} (${age}h ago, limit ${BACKUP_MAX_AGE_HOURS}h)"
  return 0
}

echo "==> migrations for $TAG (project $PROJECT, service $API_SERVICE)"

# Pull first: the migration files have to be the NEW ones, and the only place the
# host can get them is the image. A pull adds an image to the local store and
# replaces nothing that is running, which is why --status is allowed to do it.
echo "==> pulling $API_SERVICE"
if ! compose pull "$API_SERVICE"; then
  echo "error: could not pull the $API_SERVICE image at $TAG — nothing was changed" >&2
  exit 1
fi

# The database has to be reachable to be asked anything. Starting postgres is not
# "new code serving traffic": it is the same third-party image it was before, and
# on a live host it is already running, so this is a no-op.
#
# Not in --status mode, which must change nothing at all. If the database happens
# to be down then, the status below lands in the "could not tell" branch and says
# so, which is the honest answer to "what would be applied".
if [ "$MODE" = apply ]; then
  echo "==> making sure $DB_SERVICE is up"
  if ! compose up -d "$DB_SERVICE"; then
    echo "error: $DB_SERVICE would not start — not touching the schema" >&2
    exit 1
  fi
fi

echo "==> prisma migrate status"
pending=""
count=0
status_output="$(run_prisma status || true)"
printf '%s\n' "$status_output" | sed 's/^/    /'

# `prisma migrate status` exits 1 whenever anything is pending, so its exit code
# cannot be used. Read what it said instead — and if it said something this
# script does not recognise, STOP. A connection refused, a wrong role, or a
# changed prisma message must not be read as "nothing to do".
case "$status_output" in
  *'have failed'*|*'migration has failed'*)
    echo "!! a previous migration is recorded as FAILED, so prisma will not apply anything." >&2
    echo "   fix it by hand, then mark it with:" >&2
    echo "     prisma migrate resolve --applied <name>   (the SQL did run)" >&2
    echo "     prisma migrate resolve --rolled-back <name>   (it did not)" >&2
    echo "   see docs/runbooks/deploy.md. NOTHING was restarted." >&2
    exit "$EXIT_REFUSED"
    ;;
  *'Environment variable not found'*)
    echo "!! prisma could not read CDFIR_DATABASE_MIGRATION_URL." >&2
    echo "   It is the MIGRATOR role (cdfir_migrator), not the app role. The compose" >&2
    echo "   files build it from CDFIR_DB_PASSWORD for the api service; if that is" >&2
    echo "   missing, set CDFIR_DATABASE_MIGRATION_URL in $ENV_FILE." >&2
    echo "   see docs/runbooks/deploy.md. NOTHING was restarted." >&2
    exit "$EXIT_REFUSED"
    ;;
  *'not yet been applied'*)
    pending="$(printf '%s\n' "$status_output" | grep -oE '[0-9]{14}_[A-Za-z0-9_]+' | sort -u)"
    count="$(printf '%s\n' "$pending" | grep -c . || true)"
    ;;
  *'up to date'*)
    echo "==> nothing to apply; the schema already matches $TAG"
    exit 0
    ;;
  *)
    echo "!! could not tell whether migrations are pending. Refusing to guess." >&2
    echo "   The output above is everything prisma said. NOTHING was restarted." >&2
    exit "$EXIT_REFUSED"
    ;;
esac

echo "==> $count migration(s) pending:"
printf '%s\n' "$pending" | sed 's/^/      /'

if [ "$MODE" = status ]; then
  if [ "$EXPENDABLE" = true ]; then
    echo "==> would apply the $count migration(s) above. Nothing was changed."
    echo "    (no backup guard: this database is marked expendable)"
  else
    echo "==> checking the backup guard (report only)"
    if backup_is_recent_enough; then
      echo "==> would apply the $count migration(s) above. Nothing was changed."
    else
      echo "==> would REFUSE: take a backup first (scripts/backup-postgres.sh), or"
      echo "    pass --skip-backup-check. Nothing was changed."
    fi
  fi
  exit 0
fi

if [ "$EXPENDABLE" = true ]; then
  # Staging. There is no staging backup and there is not meant to be one:
  # scripts/backup-postgres.sh dumps the PRODUCTION container. Reading
  # production's stamp to decide whether staging's schema may change would be a
  # guard that is always satisfied for the wrong reason, which is worse than none.
  echo "    no backup guard: this database is marked expendable"
elif [ "$SKIP_BACKUP_CHECK" = true ]; then
  echo "!! --skip-backup-check: changing the schema WITHOUT checking for a recent" >&2
  echo "   verified backup. If this migration drops or rewrites data, it is gone." >&2
elif ! backup_is_recent_enough; then
  echo "!! refusing to change the schema. A migration cannot be undone by" >&2
  echo "   redeploying, so it needs a known-good copy behind it." >&2
  echo "   take one:   ./scripts/backup-postgres.sh" >&2
  echo "   or override: re-run with --skip-backup-check" >&2
  echo "   NOTHING was restarted. The old code is still serving the old schema," >&2
  echo "   which is the safe direction." >&2
  exit "$EXIT_REFUSED"
fi

echo "==> prisma migrate deploy"
if ! deploy_output="$(run_prisma deploy)"; then
  printf '%s\n' "$deploy_output" | sed 's/^/    /' >&2
  echo "error: the migration FAILED. NOTHING was restarted, on purpose." >&2
  echo "   The old code is still serving the old schema. Read the output above," >&2
  echo "   fix it, and deploy again. If prisma recorded the migration as failed," >&2
  echo "   see the 'migrate resolve' note in docs/runbooks/deploy.md." >&2
  exit 1
fi
printf '%s\n' "$deploy_output" | sed 's/^/    /'

# Do not trust the exit code. Every fault this deployment has had looked the
# same: reports success, silently broken. So ask the database again.
echo "==> confirming the schema is now up to date"
confirm_output="$(run_prisma status || true)"
case "$confirm_output" in
  *'up to date'*)
    echo "==> applied $count migration(s); schema matches $TAG"
    ;;
  *)
    printf '%s\n' "$confirm_output" | sed 's/^/    /' >&2
    echo "error: prisma migrate deploy reported success but the schema is still not" >&2
    echo "   up to date. NOTHING was restarted." >&2
    exit 1
    ;;
esac
