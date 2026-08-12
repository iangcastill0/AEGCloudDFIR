#!/bin/sh
# Local-development database role bootstrap (runs once on first postgres start).
# Production deployments run packages/database/sql/roles.sql with operator-
# supplied passwords instead.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE cdfir_migrator LOGIN PASSWORD 'changeme-local-only'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE cdfir LOGIN PASSWORD 'changeme-local-only'
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
