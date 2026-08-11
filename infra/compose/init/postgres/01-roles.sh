#!/bin/sh
# Local-development database role bootstrap (runs once on first postgres start).
# Production deployments run packages/database/sql/roles.sql with operator-
# supplied passwords instead.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE evidencevault_migrator LOGIN PASSWORD 'changeme-local-only'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE evidencevault LOGIN PASSWORD 'changeme-local-only'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT CONNECT ON DATABASE evidencevault TO evidencevault, evidencevault_migrator;
-- CREATE SCHEMA IF NOT EXISTS in migrations checks CREATE even when it exists.
GRANT CREATE ON DATABASE evidencevault TO evidencevault_migrator;
ALTER SCHEMA public OWNER TO evidencevault_migrator;
GRANT USAGE ON SCHEMA public TO evidencevault;

ALTER DEFAULT PRIVILEGES FOR ROLE evidencevault_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO evidencevault;
ALTER DEFAULT PRIVILEGES FOR ROLE evidencevault_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO evidencevault;
SQL
