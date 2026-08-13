#!/bin/sh
# Local-development database role bootstrap (runs once on first postgres start).
# Production deployments run packages/database/sql/roles.sql with operator-
# supplied passwords instead.
set -eu

# Password comes from the environment so production never ships a literal.
# Use an alphanumeric value (e.g. `openssl rand -hex 24`) to avoid SQL quoting
# issues. Runs once, on first start of an empty data volume.
: "${CDFIR_DB_PASSWORD:=changeme-local-only}"
case "$CDFIR_DB_PASSWORD" in
  *"'"*) echo "CDFIR_DB_PASSWORD must not contain a single quote" >&2; exit 1 ;;
esac

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v pw="$CDFIR_DB_PASSWORD" <<'SQL'
CREATE ROLE cdfir_migrator LOGIN PASSWORD :'pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE cdfir LOGIN PASSWORD :'pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT CONNECT ON DATABASE cdfir TO cdfir, cdfir_migrator;
-- CREATE SCHEMA IF NOT EXISTS in migrations checks CREATE even when it exists.
GRANT CREATE ON DATABASE cdfir TO cdfir_migrator;
ALTER SCHEMA public OWNER TO cdfir_migrator;
GRANT USAGE ON SCHEMA public TO cdfir;

ALTER DEFAULT PRIVILEGES FOR ROLE cdfir_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cdfir;
ALTER DEFAULT PRIVILEGES FOR ROLE cdfir_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cdfir;
SQL
