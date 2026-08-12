-- Database role bootstrap for AEG-CloudDFIR.
-- Executed once per environment by an operator (or the compose init script).
-- Passwords here are placeholders substituted by the deployment tooling via
-- psql -v; NEVER ship literal production passwords in files.
--
--   psql -v migrator_password="'...'" -v runtime_password="'...'" -f roles.sql
--
-- Two roles:
--   cdfir_migrator  owns the schema; used only by `prisma migrate deploy`
--   cdfir           runtime role; NOBYPASSRLS so row-level security
--                           applies to every application query

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cdfir_migrator') THEN
    EXECUTE format('CREATE ROLE cdfir_migrator LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', current_setting('vars.migrator_password', true));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cdfir') THEN
    EXECUTE format('CREATE ROLE cdfir LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', current_setting('vars.runtime_password', true));
  END IF;
END
$$;

-- Schema ownership and grants (run inside the cdfir database).
GRANT CONNECT ON DATABASE cdfir TO cdfir, cdfir_migrator;
GRANT CREATE ON DATABASE cdfir TO cdfir_migrator;
ALTER SCHEMA public OWNER TO cdfir_migrator;
GRANT USAGE ON SCHEMA public TO cdfir;

-- Runtime role: CRUD on tables, but audit history can never be rewritten.
ALTER DEFAULT PRIVILEGES FOR ROLE cdfir_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cdfir;
ALTER DEFAULT PRIVILEGES FOR ROLE cdfir_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cdfir;

-- Applied after migrations create the tables (rerun-safe):
--   REVOKE UPDATE, DELETE ON audit_events FROM cdfir;
-- The append-only trigger in migration 20260807000002 enforces this even for
-- roles that retain the grant.
