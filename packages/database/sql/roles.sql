-- Database role bootstrap for EvidenceVault.
-- Executed once per environment by an operator (or the compose init script).
-- Passwords here are placeholders substituted by the deployment tooling via
-- psql -v; NEVER ship literal production passwords in files.
--
--   psql -v migrator_password="'...'" -v runtime_password="'...'" -f roles.sql
--
-- Two roles:
--   evidencevault_migrator  owns the schema; used only by `prisma migrate deploy`
--   evidencevault           runtime role; NOBYPASSRLS so row-level security
--                           applies to every application query

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'evidencevault_migrator') THEN
    EXECUTE format('CREATE ROLE evidencevault_migrator LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', current_setting('vars.migrator_password', true));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'evidencevault') THEN
    EXECUTE format('CREATE ROLE evidencevault LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', current_setting('vars.runtime_password', true));
  END IF;
END
$$;

-- Schema ownership and grants (run inside the evidencevault database).
GRANT CONNECT ON DATABASE evidencevault TO evidencevault, evidencevault_migrator;
GRANT CREATE ON DATABASE evidencevault TO evidencevault_migrator;
ALTER SCHEMA public OWNER TO evidencevault_migrator;
GRANT USAGE ON SCHEMA public TO evidencevault;

-- Runtime role: CRUD on tables, but audit history can never be rewritten.
ALTER DEFAULT PRIVILEGES FOR ROLE evidencevault_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO evidencevault;
ALTER DEFAULT PRIVILEGES FOR ROLE evidencevault_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO evidencevault;

-- Applied after migrations create the tables (rerun-safe):
--   REVOKE UPDATE, DELETE ON audit_events FROM evidencevault;
-- The append-only trigger in migration 20260807000002 enforces this even for
-- roles that retain the grant.
