#!/usr/bin/env bash
#
# Take a verified PostgreSQL backup into the Wasabi backups bucket.
#
#   ./scripts/backup-postgres.sh
#
# Two things this script exists to get right, both learned the hard way:
#
# 1. pg_dump must run as a SUPERUSER. Every tenant table carries
#    FORCE ROW LEVEL SECURITY, which applies to the table owner too, so dumping
#    as cdfir_migrator fails with "query would be affected by row-level security
#    policy" and produces a dump whose table of contents looks complete while
#    the data is truncated. pg_restore --list cannot detect this.
#
# 2. pg_dump's exit code must be authoritative. In a shell pipeline the exit
#    status is the LAST command's, so `pg_dump | uploader` reports success even
#    when pg_dump died — uploading a partial dump that then verifies against
#    itself and gets a manifest. The dump is therefore written to a temp file
#    and its exit code checked BEFORE anything is uploaded.
#
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.yml}"
PG_CONTAINER="${PG_CONTAINER:-cdfir-postgres-1}"
ENV_FILE="${ENV_FILE:-.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found (run from the repo root)" >&2
  exit 2
fi
set -a
# shellcheck source=/dev/null  # runtime path; nothing to analyse statically
. "$ENV_FILE"
set +a

: "${CDFIR_LOCAL_PG_SUPER_PASSWORD:?CDFIR_LOCAL_PG_SUPER_PASSWORD must be set (needed to bypass FORCE RLS)}"
: "${CDFIR_BACKUP_S3_BUCKET:?CDFIR_BACKUP_S3_BUCKET must be set}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DUMP="$TMP/cdfir.dump"

echo "==> pg_dump (superuser, so FORCE RLS does not truncate it)"
if ! docker exec -e PGPASSWORD="$CDFIR_LOCAL_PG_SUPER_PASSWORD" -i "$PG_CONTAINER" \
      pg_dump -Fc -U postgres -d cdfir > "$DUMP" 2>"$TMP/err"; then
  echo "error: pg_dump failed — NOT uploading anything" >&2
  sed 's/^/  /' "$TMP/err" >&2
  exit 1
fi
if [ -s "$TMP/err" ]; then
  # pg_dump can emit warnings and still succeed; surface them but continue.
  echo "  pg_dump wrote to stderr:" >&2
  sed 's/^/    /' "$TMP/err" >&2
fi

SIZE=$(wc -c < "$DUMP" | tr -d ' ')
echo "==> dump ok: $SIZE bytes"
if [ "$SIZE" -lt 1000 ]; then
  echo "error: dump is implausibly small ($SIZE bytes) — refusing to upload" >&2
  exit 1
fi

echo "==> upload + verify"
docker compose -f "$COMPOSE_FILE" exec -T worker \
  node /app/packages/database/dist/backup-cli.js < "$DUMP"
